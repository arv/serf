import { createServer, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { decodeFrame, encodePong } from '../../src/protocol/net.ts';
import {
  TICK_MS,
  acceptSubmission,
  roomsIterable,
  sweepRooms,
  addSeat,
  createRoom,
  deleteRoomIfDead,
  findSeatByToken,
  getRoom,
  pumpRoom,
  recordHash,
  type Room,
  type Seat,
} from './rooms.ts';

/**
 * The Serf relay: rooms, the lockstep tick authority, and dumb-but-honest
 * input relaying. It never simulates the game — determinism means the
 * closed turn history IS the authoritative state. Lobby traffic is JSON
 * text frames; in-match traffic is the binary protocol from
 * src/protocol/net.ts (shared file, no build step — node strips types).
 */

const PORT = Number(process.env.PORT ?? 8787);

/**
 * One process, one port: this HTTP server serves the built game (the vite
 * dist/) and upgrades the same origin's WebSocket connections to the relay
 * — so production is a single service, and the client's relay URL is just
 * its own origin. The game needs cross-origin isolation for
 * SharedArrayBuffer, so every response carries COOP/COEP.
 */
const DIST_DIR = resolve(
  process.env.DIST_DIR ?? join(fileURLToPath(import.meta.url), '../../../dist'),
);
const SERVES_GAME = existsSync(join(DIST_DIR, 'index.html'));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
};

function isolationHeaders(res: ServerResponse): void {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (!SERVES_GAME || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404);
    res.end();
    return;
  }
  // Static game: sanitized path under dist/, SPA-falling back to index.html.
  const urlPath = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(
    /^(\.\.[/\\])+/,
    '',
  );
  let file = join(DIST_DIR, urlPath);
  if (!file.startsWith(DIST_DIR) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(DIST_DIR, 'index.html');
  }
  const ext = extname(file);
  isolationHeaders(res);
  res.setHeader('content-type', MIME[ext] ?? 'application/octet-stream');
  // Hashed assets cache forever; the entry document revalidates.
  res.setHeader(
    'cache-control',
    ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  );
  createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server: http, perMessageDeflate: true });

interface Conn {
  room?: Room;
  seat?: Seat;
}

type LobbyMsg =
  | { t: 'create'; ai?: number }
  | { t: 'join'; code: string }
  | { t: 'start'; worldBlob: string }
  | { t: 'rejoin'; token: string };

function sendJson(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

function broadcastRoomState(room: Room): void {
  const seats = room.seats.map((s) => ({ kind: s.kind, connected: s.connected }));
  for (const s of room.seats) {
    if (s.connected && s.ws) {
      sendJson(s.ws, { t: 'room', code: room.code, yourSeat: s.playerId, seats });
    }
  }
}

wss.on('connection', (ws) => {
  const conn: Conn = {};

  ws.on('message', (data, isBinary) => {
    try {
      if (isBinary) {
        handleBinary(ws, conn, new Uint8Array(data as Buffer));
      } else {
        handleLobby(ws, conn, JSON.parse(String(data)) as LobbyMsg);
      }
    } catch (err) {
      sendJson(ws, { t: 'error', message: err instanceof Error ? err.message : String(err) });
      ws.close();
    }
  });

  ws.on('close', () => {
    const { room, seat } = conn;
    if (!room || !seat) return;
    // A newer socket may have taken this seat over (worker rejoin after the
    // lobby socket) — only the current socket's close disconnects the seat.
    if (seat.ws !== ws) return;
    seat.connected = false;
    seat.ws = null;
    for (const s of room.seats) {
      if (s.connected && s.ws) sendJson(s.ws, { t: 'peer', playerId: seat.playerId, connected: false });
    }
    if (room.state === 'lobby') broadcastRoomState(room);
    deleteRoomIfDead(room);
  });
});

function handleLobby(ws: WebSocket, conn: Conn, msg: LobbyMsg): void {
  switch (msg.t) {
    case 'create': {
      const room = createRoom();
      const seat = addSeat(room, 'human', ws);
      // Host-requested AI seats fill in right away (they never connect —
      // every client simulates them locally).
      const aiCount = Math.max(0, Math.min(3, msg.ai ?? 0));
      for (let i = 0; i < aiCount; i++) addSeat(room, 'ai', null);
      conn.room = room;
      conn.seat = seat;
      broadcastRoomState(room);
      break;
    }
    case 'join': {
      const room = getRoom(msg.code);
      if (!room) throw new Error(`no room ${msg.code}`);
      if (room.state !== 'lobby') throw new Error('match already started');
      if (room.seats.filter((s) => s.kind === 'human').length >= 4) throw new Error('room full');
      const seat = addSeat(room, 'human', ws);
      conn.room = room;
      conn.seat = seat;
      broadcastRoomState(room);
      break;
    }
    case 'start': {
      console.log('[relay] start requested');
      const { room, seat } = conn;
      if (!room || !seat) throw new Error('not in a room');
      if (seat.playerId !== 0) throw new Error('only the host starts the match');
      if (room.state !== 'lobby') throw new Error('already started');
      room.worldBlob = msg.worldBlob;
      room.state = 'running';
      room.matchStartMs = Date.now() + 1500;
      for (const s of room.seats) {
        if (s.connected && s.ws) {
          sendJson(s.ws, {
            t: 'begin',
            playerId: s.playerId,
            token: s.token,
            worldBlob: room.worldBlob,
            seats: room.seats.map((x) => ({ kind: x.kind })),
            startInMs: room.matchStartMs - Date.now(),
            // The host runs the AI brains: hand it their seat tokens so
            // each brain worker connects as an ordinary (headless) client.
            aiSeats:
              s.playerId === 0
                ? room.seats
                    .filter((x) => x.kind === 'ai')
                    .map((x) => ({ playerId: x.playerId, token: x.token }))
                : [],
          });
        }
      }
      break;
    }
    case 'rejoin': {
      const found = findSeatByToken(msg.token);
      console.log(`[relay] rejoin token=${msg.token.slice(0, 8)} found=${!!found}`);
      if (!found) throw new Error('unknown token');
      const { room, seat } = found;
      seat.ws = ws;
      seat.connected = true;
      room.emptySinceMs = undefined;
      conn.room = room;
      conn.seat = seat;
      sendJson(ws, {
        t: 'rejoined',
        playerId: seat.playerId,
        worldBlob: room.worldBlob,
        seats: room.seats.map((x) => ({ kind: x.kind })),
        historyTicks: room.history.length,
      });
      // Stream the whole closed history, then live frames follow naturally.
      for (const frame of room.history) ws.send(frame);
      for (const s of room.seats) {
        if (s !== seat && s.connected && s.ws) {
          sendJson(s.ws, { t: 'peer', playerId: seat.playerId, connected: true });
        }
      }
      break;
    }
  }
}

function handleBinary(ws: WebSocket, conn: Conn, data: Uint8Array): void {
  const { room, seat } = conn;
  if (!room || !seat) throw new Error('binary frame before joining a room');
  const frame = decodeFrame(data);
  switch (frame.kind) {
    case 'turnSubmit':
      if (!acceptSubmission(room, seat, frame.envelope)) {
        throw new Error(`bad seq ${frame.envelope.seq} from seat ${seat.playerId}`);
      }
      break;
    case 'ping':
      ws.send(encodePong(frame.clientTimeMs, Date.now() % 0xffffffff, room.closedTick >>> 0));
      break;
    case 'hash': {
      const result = recordHash(room, seat, frame.tick, frame.hash);
      if (result.desync) {
        for (const s of room.seats) {
          if (s.connected && s.ws) {
            sendJson(s.ws, { t: 'desync', tick: frame.tick, hashes: result.hashes });
          }
        }
      }
      break;
    }
    default:
      throw new Error(`unexpected ${frame.kind} from client`);
  }
}

// One clock for every room.
setInterval(() => {
  const now = Date.now();
  for (const room of roomsIterable()) pumpRoom(room, now);
}, 10);
setInterval(() => sweepRooms(Date.now()), 30_000);

http.listen(PORT, () => {
  console.log(`serf relay listening on :${PORT} (tick ${TICK_MS}ms)`);
});
