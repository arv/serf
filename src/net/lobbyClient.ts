import { createWorld, type WorldConfig } from '../sim/world';
import { serializeWorld } from '../sim/save';
import type { NetInfo } from '../protocol/messages';

/**
 * Main-thread lobby flow: a short-lived JSON WebSocket for room setup. On
 * match start it hands over a world blob + seat token and closes — the sim
 * worker then opens its own binary socket straight to the relay.
 *
 * The host generates the world and ships it via the server, which sidesteps
 * cross-engine worldgen float differences entirely and gives the relay the
 * rejoin/replay base state.
 */

export interface LobbyResult {
  net: NetInfo;
  worldBlob: string;
  seats: { kind: 'human' | 'ai' }[];
  myPlayerId: number;
  /** Host only: the AI seats this client must run brain workers for. */
  aiSeats: { playerId: number; token: string }[];
}

export function relayUrl(search: string): string {
  const params = new URLSearchParams(search);
  const fromParam = params.get('relay');
  if (fromParam) return fromParam;
  const fromEnv = import.meta.env.VITE_RELAY_URL as string | undefined;
  if (fromEnv) return fromEnv;
  // Production is served by the relay process itself — same origin, same
  // port, ws upgraded in place. Dev runs vite + the relay side by side.
  if (import.meta.env.PROD) {
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  }
  return `ws://${location.hostname}:8787`;
}

interface RoomState {
  code: string;
  yourSeat: number;
  seats: { kind: 'human' | 'ai'; connected: boolean }[];
}

/**
 * Run the lobby until the match starts. `mp` is 'new' (host) or a room
 * code (joiner); hosts may bring AI seats. Renders a minimal DOM overlay;
 * resolves when the server says 'begin'.
 */
export function runLobby(mp: string, aiSeats: number, seed: number, url: string): Promise<LobbyResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const overlay = makeOverlay();
    let room: RoomState | null = null;
    const isHost = mp === 'new';

    const fail = (message: string): void => {
      overlay.remove();
      ws.close();
      reject(new Error(message));
    };

    ws.onerror = () => fail(`cannot reach the relay at ${url}`);
    ws.onopen = () => {
      ws.send(
        isHost ? JSON.stringify({ t: 'create', ai: aiSeats }) : JSON.stringify({ t: 'join', code: mp }),
      );
    };
    ws.onmessage = (e: MessageEvent<string>) => {
      const msg = JSON.parse(e.data) as
        | ({ t: 'room' } & RoomState)
        | {
            t: 'begin';
            playerId: number;
            token: string;
            worldBlob: string;
            seats: { kind: 'human' | 'ai' }[];
            aiSeats?: { playerId: number; token: string }[];
          }
        | { t: 'error'; message: string }
        | { t: 'peer' };
      if (msg.t === 'room') {
        room = msg;
        overlay.render(msg, isHost, () => {
          // Host generates the world for everyone at Start.
          const config: WorldConfig = {
            seed,
            players: room!.seats.map((s) => ({ kind: s.kind })),
            adminEnabled: false,
            banditsEnabled: true,
          };
          ws.send(JSON.stringify({ t: 'start', worldBlob: serializeWorld(createWorld(config)) }));
        });
      } else if (msg.t === 'begin') {
        overlay.remove();
        ws.close();
        resolve({
          net: { relayUrl: url, token: msg.token, playerId: msg.playerId },
          worldBlob: msg.worldBlob,
          seats: msg.seats,
          myPlayerId: msg.playerId,
          aiSeats: msg.aiSeats ?? [],
        });
      } else if (msg.t === 'error') {
        fail(msg.message);
      }
    };
  });
}

interface Overlay {
  render(room: RoomState, isHost: boolean, onStart: () => void): void;
  remove(): void;
}

function makeOverlay(): Overlay {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;inset:0;display:grid;place-items:center;background:rgba(10,12,10,0.92);' +
    'z-index:50;color:#e8e4d8;font-family:Georgia,serif;text-align:center;';
  el.innerHTML = '<div><h1>Reaching the relay…</h1></div>';
  document.body.appendChild(el);
  return {
    render(room, isHost, onStart) {
      const seatRows = room.seats
        .map(
          (s, i) =>
            `<li>Seat ${i}${i === room.yourSeat ? ' (you)' : ''} — ${
              s.kind === 'ai' ? 'Computer' : s.connected ? 'Ready' : 'Away'
            }</li>`,
        )
        .join('');
      el.innerHTML =
        `<div><h1>War Council</h1>` +
        `<p>Room code: <strong style="font-size:1.6em;letter-spacing:0.2em">${room.code}</strong></p>` +
        `<ul style="list-style:none;padding:0">${seatRows}</ul>` +
        (isHost
          ? `<button id="lobby-start" style="font-size:1.2em;padding:8px 24px">Begin the match</button>`
          : `<p>Waiting for the host…</p>`) +
        `</div>`;
      document.getElementById('lobby-start')?.addEventListener('click', onStart);
    },
    remove() {
      el.remove();
    },
  };
}
