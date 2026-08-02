import { createServer, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { decodeState, encodePong } from '../../src/protocol/state.ts';
import { defaultLobbyConfig, sanitizeLobbyConfig } from '../../src/protocol/lobby.ts';
import { sanitizeCommands } from '../../src/sim/commands.ts';
import {
  MAX_COMMANDS_PER_FRAME,
  MAX_SEATS,
  TICK_MS,
  roomsIterable,
  sweepRooms,
  addSeat,
  createRoom,
  deleteRoomIfDead,
  findSeatByToken,
  getRoom,
  listOpenRooms,
  pumpRoom,
  queueCommands,
  removeSeat,
  serverStats,
  startMatch,
  type Room,
  type Seat,
} from './rooms.ts';
import { sendInit } from './sync.ts';
import { persistRooms, restorePersistedRooms } from './persist.ts';

/**
 * The Serf server: rooms, the simulation, and per-client state frames. It
 * owns the world — clients send orders and render what they are told, and
 * never hold state their seat has not observed. Lobby traffic is JSON text
 * frames; in-match traffic is the binary protocol from
 * src/protocol/state.ts (shared file, no build step — node strips types).
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
    // Deliberately more than 'ok': this process now simulates, so the useful
    // question is how close to full it is.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...serverStats() }));
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
wss.on('error', (err) => console.error('[serf] websocket server error:', err));

interface Conn {
  room?: Room;
  seat?: Seat;
  /** Last time this socket asked for the room list (rate limiting). */
  lastListMs?: number;
}

/** Minimum gap between {t:'list'} requests on one socket. The menu polls at
 * 3s; this only bites on a client that is misbehaving. */
const LIST_MIN_GAP_MS = 1000;

type LobbyMsg =
  | { t: 'list' }
  | { t: 'create'; open?: boolean; config?: unknown }
  | { t: 'join'; code: string }
  | { t: 'config'; config?: unknown }
  | { t: 'start' }
  | { t: 'rejoin'; token: string };

function sendJson(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

function broadcastRoomState(room: Room): void {
  const seats = room.seats.map((s) => ({ kind: s.kind, connected: s.connected }));
  for (const s of room.seats) {
    if (s.connected && s.ws) {
      sendJson(s.ws, {
        t: 'room',
        code: room.code,
        yourSeat: s.playerId,
        seats,
        config: room.config,
      });
    }
  }
}

wss.on('connection', (ws) => {
  const conn: Conn = {};

  // A client that vanishes rudely — phone reload, tab kill, radio drop —
  // surfaces as an 'error' on its socket, and an EventEmitter error with
  // no listener takes down the whole process, every room with it. The
  // close handler right below does the actual seat bookkeeping; this only
  // has to exist.
  ws.on('error', (err) => {
    console.warn('[serf] client socket error:', err instanceof Error ? err.message : err);
  });

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

/**
 * Give up whatever room this socket is already in. One connection holds one
 * seat: without this, a second `create` or `join` simply overwrote
 * conn.room/conn.seat and the old room kept a seat marked connected, with a
 * live ws, that nothing would ever reclaim — the close handler only knows
 * about the newest room. A client looping `create` grew the room map without
 * bound; join-then-join left a permanent "Ready" ghost that could hold a
 * lobby at full.
 */
function releaseRoom(conn: Conn, ws: WebSocket): void {
  const { room, seat } = conn;
  conn.room = undefined;
  conn.seat = undefined;
  if (!room || !seat) return;
  if (seat.ws !== ws) return; // a newer socket owns the seat now
  if (room.state === 'lobby') {
    // Nothing has been built yet: take the chair away rather than leave an
    // empty one at the table.
    removeSeat(room, seat);
    broadcastRoomState(room);
  } else {
    seat.connected = false;
    seat.ws = null;
  }
  deleteRoomIfDead(room);
}

function handleLobby(ws: WebSocket, conn: Conn, msg: LobbyMsg): void {
  switch (msg.t) {
    case 'list': {
      const now = Date.now();
      if (conn.lastListMs !== undefined && now - conn.lastListMs < LIST_MIN_GAP_MS) return;
      conn.lastListMs = now;
      sendJson(ws, { t: 'rooms', rooms: listOpenRooms(now) });
      break;
    }
    case 'create': {
      releaseRoom(conn, ws);
      // The start screen sends open:false for a code-only room. Settings
      // come in as a config the host keeps tuning from the council; AI
      // seats are numbers in it, not chairs, until the match starts.
      const room = createRoom(
        msg.open === false ? 'closed' : 'open',
        sanitizeLobbyConfig(defaultLobbyConfig(), msg.config),
      );
      const seat = addSeat(room, 'human', ws);
      conn.room = room;
      conn.seat = seat;
      broadcastRoomState(room);
      break;
    }
    case 'join': {
      const room = getRoom(msg.code);
      if (!room) throw new Error(`no room ${msg.code}`);
      if (room.state !== 'lobby') throw new Error('match already started');
      // Already sitting here: refresh the view rather than release the seat
      // and immediately claim a second one.
      if (conn.room === room) {
        broadcastRoomState(room);
        break;
      }
      // Every seat counts, AI included: the world has no start layout past
      // four, so letting a fifth in made a room that could never begin.
      if (room.seats.length >= MAX_SEATS) throw new Error('room full');
      releaseRoom(conn, ws);
      const seat = addSeat(room, 'human', ws);
      conn.room = room;
      conn.seat = seat;
      broadcastRoomState(room);
      break;
    }
    case 'config': {
      const { room, seat } = conn;
      if (!room || !seat) throw new Error('not in a room');
      if (room.state !== 'lobby') throw new Error('already started');
      // Not the host's word: ignored, not fatal — a stale client mustn't
      // lose its seat over a message the room simply doesn't honor.
      if (seat.playerId !== 0) break;
      room.config = sanitizeLobbyConfig(room.config, msg.config);
      broadcastRoomState(room);
      break;
    }
    case 'start': {
      const { room, seat } = conn;
      if (!room || !seat) throw new Error('not in a room');
      if (seat.playerId !== 0) throw new Error('only the host starts the match');
      if (room.state !== 'lobby') throw new Error('already started');
      // The server builds the world from room.config. With one simulator
      // there is no cross-engine worldgen risk and no blob to ship around.
      startMatch(room);
      console.log(`[serf] room ${room.code} started, ${room.seats.length} seat(s)`);
      for (const s of room.seats) {
        if (s.connected && s.ws) {
          sendJson(s.ws, {
            t: 'begin',
            playerId: s.playerId,
            token: s.token,
            seats: room.seats.map((x) => ({ kind: x.kind })),
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
      // Same leak as create/join: a socket that already held a seat must let
      // go of it before binding another.
      if (conn.seat !== seat) releaseRoom(conn, ws);
      seat.ws = ws;
      seat.connected = true;
      room.emptySinceMs = undefined;
      conn.room = room;
      conn.seat = seat;
      sendJson(ws, {
        t: 'rejoined',
        playerId: seat.playerId,
        seats: room.seats.map((x) => ({ kind: x.kind })),
      });
      // Current state, not a replay: the server holds the world, so catching
      // a client up is one frame regardless of how long the match has run.
      sendInit(room, seat);
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
  const frame = decodeState(data);
  if (!frame) throw new Error('unknown frame from client');
  if (frame.kind === 'cmd') {
    // A lobby room never pumps, so anything queued before the match starts
    // would sit in room.queued forever, growing with every frame. No client
    // submits before it has been told the match began.
    if (room.state !== 'running') throw new Error('command frame before the match started');
    // What came off the wire only claims to be commands. Screen it here, at
    // the trust boundary, so nothing malformed can reach the shared tick.
    queueCommands(room, seat, frame.seq, sanitizeCommands(frame.commands, MAX_COMMANDS_PER_FRAME));
    return;
  }
  if (frame.kind === 'ping') {
    ws.send(encodePong(frame.clientTimeMs, Date.now() % 0xffffffff));
    return;
  }
  throw new Error(`unexpected ${frame.kind} from client`);
}

// One clock for every room. A room that manages to throw despite the
// screening at the socket boundary loses its own tick, not everyone's — an
// uncaught error here would stop the interval and freeze every live match.
setInterval(() => {
  const now = Date.now();
  for (const room of roomsIterable()) {
    try {
      pumpRoom(room, now);
    } catch (err) {
      room.pumpErrors = (room.pumpErrors ?? 0) + 1;
      // Loud the first time, then occasionally: this fires at 100 Hz.
      if (room.pumpErrors === 1 || room.pumpErrors % 1000 === 0) {
        console.error(`[serf] room ${room.code} pump failed (x${room.pumpErrors}):`, err);
      }
    }
  }
}, 10);
setInterval(() => sweepRooms(Date.now()), 30_000);

// Rooms the previous process left behind (a deploy's SIGTERM, below):
// restored before the listener opens, so the tokens clients are already
// retrying with are honored from the very first upgrade.
const restored = restorePersistedRooms(Date.now());
if (restored > 0) console.log(`[serf] restored ${restored} room(s) from the previous process`);

// Every deploy replaces this process: SIGTERM, grace, then the new image.
// Running rooms go to disk for the next process; the sockets just die,
// which is fine — clients reconnect-loop through the downtime and rejoin
// by token once the new listener answers.
process.on('SIGTERM', () => {
  try {
    console.log(`[serf] SIGTERM: persisted ${persistRooms()} running room(s)`);
  } catch (err) {
    console.error('[serf] SIGTERM: persisting rooms failed:', err);
  }
  process.exit(0);
});

http.listen(PORT, () => {
  console.log(`serf relay listening on :${PORT} (tick ${TICK_MS}ms)`);
});
