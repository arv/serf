import { createSignal } from 'solid-js';
import { mountWarCouncil, type CouncilView } from '../ui/WarCouncil';
import { sanitizeLobbyConfig, defaultLobbyConfig, type LobbyConfig } from '../protocol/lobby';
import type { NetInfo } from '../protocol/messages';

/**
 * Main-thread lobby flow: a short-lived JSON WebSocket for room setup. On
 * match start it hands over a seat token and closes — the net worker then
 * opens its own binary socket straight to the server.
 *
 * The match settings live on the room, host-edited from the War Council
 * and echoed to every seat; the server builds the world from its own copy
 * of them. Nothing about the world reaches this client except through the
 * filtered state frames it receives once the match is running.
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

/** What the relay broadcasts while the room waits. Everything in it is the
 * relay's word — it only ever reaches the screen as text (see WarCouncil's
 * security note), and the config passes the same sanitizer the server uses. */
interface RoomMsg {
  t: 'room';
  code: string;
  yourSeat: number;
  seats: { kind: 'human' | 'ai'; connected: boolean }[];
  config?: unknown;
}

/**
 * Run the lobby until the match starts. `mp` is 'new' (host) or a room
 * code (joiner); `init` seeds the room's settings from the launch URL, and
 * from there the host tunes them in the council. Resolves when the server
 * says 'begin'.
 */
export function runLobby(
  mp: string,
  url: string,
  opts: { open: boolean; init: LobbyConfig },
): Promise<LobbyResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const isHost = mp === 'new';

    const [view, setView] = createSignal<CouncilView>({
      phase: 'connecting',
      code: '',
      yourSeat: isHost ? 0 : -1,
      seats: [],
      config: opts.init,
    });

    const unmount = mountWarCouncil({
      view,
      onConfig(patch) {
        // Optimistic: the relay echoes the room right back, and its copy —
        // run through the same sanitizer — wins.
        setView((s) => ({ ...s, config: sanitizeLobbyConfig(s.config, patch) }));
        ws.send(JSON.stringify({ t: 'config', config: patch }));
      },
      onStart() {
        ws.send(JSON.stringify({ t: 'start' }));
      },
      onShare() {
        const code = view().code;
        return shareInvite(
          `${location.origin}${location.pathname}?mp=${encodeURIComponent(code)}`,
        );
      },
      onLeave() {
        // Back to the start menu; closing the socket on unload releases the
        // seat (the relay removes lobby chairs on disconnect).
        location.href = location.pathname;
      },
    });

    const fail = (message: string): void => {
      unmount();
      ws.close();
      reject(new Error(message));
    };

    ws.onerror = () => fail(`cannot reach the relay at ${url}`);
    ws.onopen = () => {
      ws.send(
        isHost
          ? JSON.stringify({ t: 'create', open: opts.open, config: opts.init })
          : JSON.stringify({ t: 'join', code: mp }),
      );
    };
    ws.onmessage = (e: MessageEvent<string>) => {
      const msg = JSON.parse(e.data) as
        | RoomMsg
        | {
            t: 'begin';
            playerId: number;
            token: string;
            seats: { kind: 'human' | 'ai' }[];
          }
        | { t: 'error'; message: string }
        | { t: 'peer' };
      if (msg.t === 'room') {
        setView({
          phase: 'lobby',
          code: String(msg.code ?? ''),
          yourSeat: Number(msg.yourSeat ?? -1),
          // Sliced because the length is the relay's word too, and a table
          // only ever seats four.
          seats: Array.isArray(msg.seats) ? msg.seats.slice(0, 8) : [],
          config: sanitizeLobbyConfig(defaultLobbyConfig(), msg.config),
        });
      } else if (msg.t === 'begin') {
        unmount();
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
