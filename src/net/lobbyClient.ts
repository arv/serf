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

/** Loopback in the spellings a URL can produce. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Is this a relay a link may point us at?
 *
 * Only our own host, or loopback while developing from loopback (vite and
 * the relay run side by side on different ports there). Everything the
 * lobby shows — the room code, the seat list, error text — is written by
 * the relay, and this page is cross-origin isolated with the saves and the
 * seat token in it. A URL parameter is not allowed to choose whose server
 * gets to write that.
 */
function allowedRelay(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return false;
  if (url.hostname === location.hostname) return true;
  return LOOPBACK.has(url.hostname) && LOOPBACK.has(location.hostname);
}

export function relayUrl(search: string): string {
  const params = new URLSearchParams(search);
  const fromParam = params.get('relay');
  if (fromParam && allowedRelay(fromParam)) return fromParam;
  if (fromParam) console.warn('[lobby] ignoring ?relay= pointing off this origin:', fromParam);
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
export function runLobby(
  mp: string,
  aiSeats: number,
  seed: number,
  url: string,
  open = true,
): Promise<LobbyResult> {
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
        isHost
          ? JSON.stringify({ t: 'create', ai: aiSeats, open })
          : JSON.stringify({ t: 'join', code: mp }),
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

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  css?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (css) node.style.cssText = css;
  return node;
}

/**
 * The lobby view. Every word of it that is not a literal here — the room
 * code, the seat count — is written by the relay, so it goes in as text
 * nodes rather than through innerHTML. That used to be an origin-wide hole:
 * a crafted `?mp=…&relay=…` invite chose the relay (see allowedRelay, which
 * no longer lets it), the relay answered `{t:'room', code:'<img
 * onerror=…>'}`, and the markup ran in a cross-origin-isolated page holding
 * the saves and the seat token.
 */
function makeOverlay(): Overlay {
  const root = el(
    'div',
    undefined,
    'position:fixed;inset:0;display:grid;place-items:center;background:rgba(10,12,10,0.92);' +
      'z-index:50;color:#e8e4d8;font-family:Georgia,serif;text-align:center;',
  );
  const card = el('div');
  card.appendChild(el('h1', 'Reaching the relay…'));
  root.appendChild(card);
  document.body.appendChild(root);
  return {
    render(room, isHost, onStart) {
      // The code alone makes the other player retype it; the link is the
      // thing you actually paste into a chat window.
      const code = String(room.code ?? '');
      const invite = `${location.origin}${location.pathname}?mp=${encodeURIComponent(code)}`;

      const codeLine = el('p', 'Room code: ');
      codeLine.appendChild(el('strong', code, 'font-size:1.6em;letter-spacing:0.2em'));

      const copyBtn = el('button', 'Copy invite link', 'font:inherit;padding:6px 14px');
      copyBtn.addEventListener('click', () => {
        void shareInvite(invite).then((how) => {
          if (how === 'shared') return; // the share sheet is its own feedback
          copyBtn.textContent = 'Copied!';
          setTimeout(() => {
            copyBtn.textContent = 'Copy invite link';
          }, 1600);
        });
      });
      const copyLine = el('p');
      copyLine.appendChild(copyBtn);

      const list = el('ul', undefined, 'list-style:none;padding:0');
      // Sliced because the length is the relay's word too, and a table only
      // ever seats four.
      const seats = Array.isArray(room.seats) ? room.seats.slice(0, 8) : [];
      seats.forEach((s, i) => {
        const who = s.kind === 'ai' ? 'Computer' : s.connected ? 'Ready' : 'Away';
        list.appendChild(el('li', `Seat ${i}${i === room.yourSeat ? ' (you)' : ''} — ${who}`));
      });

      let action: HTMLElement;
      if (isHost) {
        const start = el('button', 'Begin the match', 'font-size:1.2em;padding:8px 24px');
        start.addEventListener('click', onStart);
        action = start;
      } else {
        action = el('p', 'Waiting for the host…');
      }

      card.replaceChildren(el('h1', 'War Council'), codeLine, copyLine, list, action);
    },
    remove() {
      root.remove();
    },
  };
}
