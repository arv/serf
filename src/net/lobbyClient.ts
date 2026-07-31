import type { NetInfo } from '../protocol/messages';

/**
 * Main-thread lobby flow: a short-lived JSON WebSocket for room setup. On
 * match start it hands over a seat token and closes — the net worker then
 * opens its own binary socket straight to the server.
 *
 * The server builds the world from the seed the host sends. Nothing about
 * the world reaches this client except through the filtered state frames it
 * receives once the match is running.
 */

export interface LobbyResult {
  net: NetInfo;
  seats: { kind: 'human' | 'ai' }[];
  myPlayerId: number;
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
            seats: { kind: 'human' | 'ai' }[];
          }
        | { t: 'error'; message: string }
        | { t: 'peer' };
      if (msg.t === 'room') {
        room = msg;
        // The seed is all the host contributes; the server builds the world.
        overlay.render(msg, isHost, () => ws.send(JSON.stringify({ t: 'start', seed })));
      } else if (msg.t === 'begin') {
        overlay.remove();
        ws.close();
        resolve({
          net: { relayUrl: url, token: msg.token, playerId: msg.playerId },
          seats: msg.seats,
          myPlayerId: msg.playerId,
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

/**
 * Hand the invite link over by whatever route this device offers: the
 * native share sheet on phones, the clipboard everywhere else. The
 * clipboard is always available here — SharedArrayBuffer already forces
 * cross-origin isolation, so the page is necessarily a secure context.
 *
 * The url is the whole payload. Share sheets splice `title`/`text` in
 * front of the link, so a recipient who copies from one ends up with a
 * sentence wrapped around the URL instead of something pasteable.
 */
async function shareInvite(url: string): Promise<'shared' | 'copied'> {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ url });
      return 'shared';
    } catch {
      // Dismissed, or this payload is unshareable — fall through to copying.
    }
  }
  await navigator.clipboard.writeText(url);
  return 'copied';
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
      // The code alone makes the other player retype it; the link is the
      // thing you actually paste into a chat window.
      const invite = `${location.origin}${location.pathname}?mp=${room.code}`;
      el.innerHTML =
        `<div><h1>War Council</h1>` +
        `<p>Room code: <strong style="font-size:1.6em;letter-spacing:0.2em">${room.code}</strong></p>` +
        `<p><button id="lobby-copy" style="font:inherit;padding:6px 14px">` +
        `Copy invite link</button></p>` +
        `<ul style="list-style:none;padding:0">${seatRows}</ul>` +
        (isHost
          ? `<button id="lobby-start" style="font-size:1.2em;padding:8px 24px">Begin the match</button>`
          : `<p>Waiting for the host…</p>`) +
        `</div>`;
      document.getElementById('lobby-start')?.addEventListener('click', onStart);

      const copyBtn = document.getElementById('lobby-copy');
      copyBtn?.addEventListener('click', () => {
        void shareInvite(invite).then((how) => {
          if (how === 'shared') return; // the share sheet is its own feedback
          copyBtn.textContent = 'Copied!';
          setTimeout(() => {
            copyBtn.textContent = 'Copy invite link';
          }, 1600);
        });
      });
    },
    remove() {
      el.remove();
    },
  };
}
