import { createSignal } from 'solid-js';
import type { CouncilHooks, CouncilView } from '../ui/WarCouncil';
import { sanitizeLobbyConfig, defaultLobbyConfig, type LobbyConfig } from '../protocol/lobby';
import type { NetInfo } from '../protocol/messages';
import { PlayerKind } from '../sim/player';
import { CouncilPhase } from '../ui/WarCouncil.tsx';

/**
 * Main-thread lobby flow: a short-lived JSON WebSocket for room setup. On
 * match start it hands over a seat token and closes — the net worker then
 * opens its own binary socket straight to the server.
 *
 * The match settings live on the room, host-edited from the War Council
 * and echoed to every seat; the server builds the world from its own copy
 * of them. Nothing about the world reaches this client except through the
 * filtered state frames it receives once the match is running.
 *
 * The socket is all this module owns. It never puts the council on screen
 * itself — it hands the hooks to `present` and the menu shell decides where
 * they render, which is what lets the council be a screen of the menu
 * rather than a page of its own.
 */

export interface LobbyResult {
  net: NetInfo;
  seats: { kind: PlayerKind.human | 'ai' }[];
  myPlayerId: number;
}

/** Which room to sit down in, and the settings a new one opens with. */
export interface CouncilRequest {
  /** 'new' to host a room, or the code of one to join. */
  mp: string;
  /** Host only: list the room in everyone's browser. */
  open: boolean;
  /** Seed settings for a room being created; ignored when joining one. */
  init: LobbyConfig;
  /** One line of context from the journey here, shown above the lobby. */
  notice?: string;
}

export interface LobbyUi {
  /**
   * Put the council on screen and return its teardown. Not called for a
   * stashed rejoin, which resolves without the lobby ever being seen.
   */
  present(hooks: CouncilHooks): () => void;
  /** The player backed out. The socket is closed and the returned promise
   * is abandoned — it never settles, and the caller owns the screen. */
  onLeave(): void;
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
  seats: { kind: PlayerKind.human | 'ai'; connected: boolean }[];
  config?: unknown;
}

/**
 * The seat, stashed so a reload can sit back down. A phone that loses its
 * GPU process reloads mid-match (see main.ts) and lands here with ?mp=CODE
 * — without this it would try to join its own running match and be told
 * "already started". Stored in BOTH sessionStorage and localStorage: the
 * session copy keeps a same-tab reload honest, and the local copy lets a
 * CLOSED tab reopen its invite URL and reclaim the seat within the
 * server's grace window (the room lives ~5 minutes after the last human
 * leaves). Two tabs racing the local copy resolve server-side: the seat
 * binds to the newest socket.
 */
const SEAT_STASH = 'serf-seat';

interface SeatStash {
  code: string;
  token: string;
  playerId: number;
  seats: { kind: PlayerKind.human | 'ai' }[];
}

/**
 * One store, one guard. Where site data is blocked, touching storage itself
 * throws — and the two stores can fail one without the other (a full
 * session quota with room in local, an embedding that denies just one), so
 * a shared try would let the session copy's failure take the local copy —
 * the closed-tab rejoin — down with it.
 */
function stashRead(kind: 'session' | 'local'): string | null {
  try {
    return (kind === 'session' ? sessionStorage : localStorage).getItem(SEAT_STASH);
  } catch {
    return null;
  }
}

function stashWrite(kind: 'session' | 'local', value: string | null): void {
  try {
    const store = kind === 'session' ? sessionStorage : localStorage;
    if (value === null) store.removeItem(SEAT_STASH);
    else store.setItem(SEAT_STASH, value);
  } catch {
    // Denied or full: this copy of the seat just doesn't happen.
  }
}

function readSeatStash(code: string): SeatStash | null {
  const raw = stashRead('session') ?? stashRead('local');
  if (!raw) return null;
  try {
    const stash = JSON.parse(raw) as SeatStash;
    if (typeof stash.token !== 'string') return null;
    // 'new' is the host's URL — any stashed seat in this tab is the match
    // that reload interrupted. A room code must match exactly.
    return code === 'new' || stash.code === code.toUpperCase() ? stash : null;
  } catch {
    return null;
  }
}

/** The start menu calls this on every launch: choosing a game from the
 * menu is fresh intent, and a stashed seat from the last match must not
 * quietly sit back down in it. */
export function clearSeatStash(): void {
  stashWrite('session', null);
  stashWrite('local', null);
}

/**
 * Run the lobby until the match starts. `req.mp` is 'new' (host) or a room
 * code (joiner); `req.init` seeds a new room's settings, and from there the
 * host tunes them in the council. Resolves when the server says 'begin' —
 * or never, if the player leaves.
 */
export function runLobby(url: string, req: CouncilRequest, ui: LobbyUi): Promise<LobbyResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const isHost = req.mp === 'new';
    // A reload mid-match sits back down instead of knocking on the door.
    const stash = readSeatStash(req.mp);
    /**
     * The player left. Nothing this socket has to say matters after that,
     * and saying it anyway is worse than silence: a queued 'begin' would
     * start a match nobody is watching for, and closing a socket that has
     * not finished connecting fires `error` — which used to throw the
     * "cannot reach the relay" screen over the start menu the player had
     * just walked back to.
     */
    let abandoned = false;

    const [view, setView] = createSignal<CouncilView>({
      notice: req.notice,
      phase: CouncilPhase.connecting,
      code: '',
      yourSeat: isHost ? 0 : -1,
      seats: [],
      config: req.init,
    });

    // A stashed rejoin sits straight back down — showing the council for
    // the token round-trip flashed the lobby chrome over every mid-match
    // reload. It only appears if the rejoin fails and we fall back to
    // knocking normally (the recursion re-enters without a stash).
    const unmount = stash
      ? (): void => {}
      : ui.present({
          view,
          onConfig(patch) {
            // Optimistic: the relay echoes the room right back, and its
            // copy — run through the same sanitizer — wins.
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
            // Closing the socket releases the seat (the relay removes lobby
            // chairs on disconnect); this promise is simply dropped, and the
            // shell puts the start screen back.
            abandoned = true;
            ws.onopen = ws.onmessage = ws.onerror = null;
            unmount();
            ws.close();
            ui.onLeave();
          },
        });

    const fail = (message: string): void => {
      if (abandoned) return;
      unmount();
      ws.close();
      reject(new Error(message));
    };

    ws.onerror = () => fail(`cannot reach the relay at ${url}`);
    ws.onopen = () => {
      ws.send(
        stash
          ? JSON.stringify({ t: 'rejoin', token: stash.token })
          : isHost
            ? JSON.stringify({ t: 'create', open: req.open, config: req.init })
            : JSON.stringify({ t: 'join', code: req.mp }),
      );
    };
    ws.onmessage = (e: MessageEvent<string>) => {
      // Detaching the handlers on the way out is the real guard; this one
      // catches an event already queued behind that.
      if (abandoned) return;
      // The rejoin reply is chased by a binary init frame on this same
      // socket; the net worker will fetch its own once the match view
      // boots, so anything non-JSON here is simply not for us.
      if (typeof e.data !== 'string') return;
      const msg = JSON.parse(e.data) as
        | RoomMsg
        | {
            t: 'begin';
            playerId: number;
            token: string;
            seats: { kind: PlayerKind.human | 'ai' }[];
          }
        | { t: 'rejoined'; playerId: number; seats: { kind: PlayerKind.human | 'ai' }[] }
        | { t: 'error'; message: string }
        | { t: 'peer' };
      if (msg.t === 'rejoined' && stash) {
        unmount();
        ws.close();
        resolve({
          net: { relayUrl: url, token: stash.token, playerId: msg.playerId },
          seats: Array.isArray(msg.seats) ? msg.seats : stash.seats,
          myPlayerId: msg.playerId,
        });
      } else if (msg.t === 'room') {
        setView({
          notice: view().notice,
          phase: CouncilPhase.lobby,
          code: String(msg.code ?? ''),
          yourSeat: Number(msg.yourSeat ?? -1),
          // Sliced because the length is the relay's word too, and a table
          // only ever seats four.
          seats: Array.isArray(msg.seats) ? msg.seats.slice(0, 8) : [],
          config: sanitizeLobbyConfig(defaultLobbyConfig(), msg.config),
        });
      } else if (msg.t === 'begin') {
        const stashJson = JSON.stringify({
            code: view().code || req.mp.toUpperCase(),
            token: msg.token,
            playerId: msg.playerId,
            seats: msg.seats,
          } satisfies SeatStash);
        stashWrite('session', stashJson);
        stashWrite('local', stashJson);
        unmount();
        ws.close();
        resolve({
          net: { relayUrl: url, token: msg.token, playerId: msg.playerId },
          seats: msg.seats,
          myPlayerId: msg.playerId,
        });
      } else if (msg.t === 'error') {
        if (stash) {
          // The stash pointed at a room that no longer knows us — the
          // relay restarted, or the room was swept. That is not the
          // player's problem: forget the seat and knock normally on a
          // fresh socket (the relay closes this one after an error) —
          // but SAY so, or the old match seems to vanish without a word.
          clearSeatStash();
          unmount();
          ws.close();
          resolve(runLobby(url, { ...req, notice: 'Your previous match has ended.' }, ui));
        } else {
          fail(msg.message);
        }
      }
    };
  });
}
