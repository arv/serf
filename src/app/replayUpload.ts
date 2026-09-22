/**
 * Handing a match up to the server, and reading the shelf back.
 *
 * The upload is silent and it is allowed to fail. Nobody asked for it, so
 * nobody is told about it: no toast, no spinner, no line on the end card,
 * and every error below is swallowed where it happens. A player with no
 * network, a relay that is down, a server built without the route — all of
 * them play exactly the game they would have played anyway. That is the
 * whole contract, and it is why every function here resolves rather than
 * rejects.
 *
 * What it buys is the one thing the server cannot otherwise see. Solo play
 * is a local sim that never opens a socket, so a match played start to
 * finish leaves no more trace on the relay than a page that was opened and
 * closed. The recording says the game was played, by whom, on what, and
 * move by move how — which is also, in time, a training set.
 *
 * Both endings are filed, and worthUploading below is where the one rule
 * about which matches are worth a row lives. A game walked out of is not
 * a failed recording: it is the commoner event, and the one that says
 * where the game loses someone.
 *
 * The other half is the shelf: server/src/replayApi.ts lists what has been
 * uploaded, and areas/replays puts it on a page at /all-replays.
 */

import {relayUrl} from '../net/lobbyClient';
import {TICK_MS} from '../sim/defs/balance';

/** What the client calls a recording's origin when it files one. Solo and
 * networked matches produce identical documents — a one-human room looks
 * exactly like a solo skirmish — so the shelf can only know which it was
 * if the uploader says. */
export type ReplaySource = 'solo' | 'net';

/**
 * How the match the recording came from stopped.
 *
 * `decided` is a match played to a winner. `abandoned` is one walked out
 * of — Quit to menu, Back, a launch into another screen — and it is not
 * the lesser record: a game people leave says as much about how the game
 * plays as a game they finish, and it is most of what actually happens.
 * The shelf keeps them apart because the two are different evidence.
 */
export type ReplayEnding = 'decided' | 'abandoned';

/** How the server describes one uploaded recording. Mirrors
 * ReplaySummary in server/src/replayUploads.ts; the shelf page is the
 * only reader, and it treats everything here as text to print. */
export interface UploadedReplay {
  id: string;
  uploadedMs: number;
  bytes: number;
  source: ReplaySource;
  replayVersion: number;
  endTick: number;
  seed: number;
  seat?: number;
  mission?: string;
  difficulty?: string;
  seats: {kind: string; strategy?: string; difficulty?: string}[];
  commands: number;
  chat: number;
  /** Absent on recordings filed before the shelf drew the distinction;
   * the page reads a missing one as `decided`. */
  ending?: ReplayEnding;
}

/**
 * How far a match has to have got before quitting it is worth filing.
 *
 * Thirty seconds at the sim's own rate. The shelf a recording lands on is
 * finite (server/src/replayUploads.ts prunes oldest-first), so a launch
 * opened and backed straight out of — the commonest thing that happens to
 * the match screen — would otherwise crowd out the games this exists to
 * collect. Thirty seconds is short enough that a genuine "I did not like
 * this" is still on the shelf, and long enough that a misclick is not.
 */
export const MIN_ABANDONED_TICKS = Math.round(30_000 / TICK_MS);

/**
 * Is a match that stopped here worth a row on the shelf?
 *
 * A decided match always is: however fast it went, somebody won, and how
 * long a game took is exactly the kind of thing the shelf is kept to
 * answer. An abandoned one has to clear the floor above — not because a
 * short game is uninteresting, but because a launch bounced off in three
 * seconds is not a game at all, and a hundred of them push real matches
 * off the end of a finite shelf.
 */
export function worthUploading(ending: ReplayEnding, endTick: number): boolean {
  return ending === 'decided' || endTick >= MIN_ABANDONED_TICKS;
}

/**
 * Where the server answers HTTP.
 *
 * The relay's own origin, since they are one process — so this inherits
 * the relay's rules about which host a URL may name (?relay=, and only
 * this origin or loopback while developing from loopback). ws:// and
 * wss:// map to http:// and https:// by construction.
 */
export function apiOrigin(search: string = location.search): string {
  return new URL(relayUrl(search).replace(/^ws/, 'http')).origin;
}

/** The read routes want `?key=` when the server was started with
 * SERF_REPLAY_KEY. The shelf page carries the key in its own URL and hands
 * it back; where the server has no key, an extra param is ignored. */
function withKey(url: string, key: string | null): string {
  if (key === null || key === '') return url;
  return `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`;
}

/**
 * File a finished match's recording, and never say a word about it.
 *
 * Text rather than JSON on the content-type: a `text/plain` POST is a
 * CORS-simple request, so the dev setup (vite on one port, the relay on
 * another) costs no preflight round trip. The body is the replay document
 * either way, and the server parses it as one.
 *
 * `origin` is passed in rather than read here, and that is the whole
 * point of it being a parameter: an abandoned match uploads from the
 * screen's teardown, and by then the router has ALREADY moved the address
 * bar to wherever the player went. Reading the relay off the URL at that
 * moment would aim a match played on one server at another one. The
 * caller takes it while the match's own URL is still current.
 *
 * Not `keepalive`: that caps a body at 64 KB and a replay is megabytes.
 * Which means an upload fired as the page is going away may not finish —
 * acceptable, because the call that matters is the one at the end card,
 * with the page still open behind it.
 */
export async function uploadReplay(
  data: string,
  opts: {source: ReplaySource; ending: ReplayEnding; origin: string},
): Promise<void> {
  // Empty is what the worker answers when it has no recording to hand out
  // (it is playing one back) and what the server answers while a room's
  // outcome is undecided. Neither is a replay, and neither is an error.
  if (data === '') return;
  try {
    const query = `?source=${opts.source}&ending=${opts.ending}`;
    await fetch(`${opts.origin}/api/all-replays${query}`, {
      method: 'POST',
      headers: {'content-type': 'text/plain;charset=UTF-8'},
      body: data,
      // No cookies, no credentials: this is an anonymous drop box.
      credentials: 'omit',
    });
  } catch {
    // Deliberately nothing. See the module comment.
  }
}

/** The shelf, newest first, or null when it cannot be read — no network,
 * no server, or a key the server does not accept. */
export async function fetchUploadedReplays(
  key: string | null,
): Promise<UploadedReplay[] | null> {
  try {
    const res = await fetch(withKey(`${apiOrigin()}/api/all-replays`, key), {
      credentials: 'omit',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {replays?: unknown};
    // Screened only as far as the page needs: every row is printed, and
    // parseReplay is still the gate on anything that reaches the sim.
    return Array.isArray(body.replays)
      ? (body.replays as UploadedReplay[])
      : null;
  } catch {
    return null;
  }
}

/** One uploaded recording's JSON, or null when it is not there. The caller
 * screens it with parseReplay like any other replay document. */
export async function fetchUploadedReplay(
  id: string,
  key: string | null,
): Promise<string | null> {
  try {
    const res = await fetch(
      withKey(`${apiOrigin()}/api/all-replays/${encodeURIComponent(id)}`, key),
      {credentials: 'omit'},
    );
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
