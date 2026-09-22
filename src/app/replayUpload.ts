/**
 * Handing a finished match up to the server, and reading the shelf back.
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
 * The other half is the shelf: server/src/replayApi.ts lists what has been
 * uploaded, and areas/replays puts it on a page at /all-replays.
 */

import {relayUrl} from '../net/lobbyClient';

/** What the client calls a recording's origin when it files one. Solo and
 * networked matches produce identical documents — a one-human room looks
 * exactly like a solo skirmish — so the shelf can only know which it was
 * if the uploader says. */
export type ReplaySource = 'solo' | 'net';

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
 * Not `keepalive`: that caps a body at 64 KB and a replay is megabytes.
 * Which means an upload fired as the page is going away may not finish —
 * acceptable, because the call that matters is the one at the end card,
 * with the page still open behind it.
 */
export async function uploadReplay(
  data: string,
  source: ReplaySource,
): Promise<void> {
  // Empty is what the worker answers when it has no recording to hand out
  // (it is playing one back) and what the server answers while a room's
  // outcome is undecided. Neither is a replay, and neither is an error.
  if (data === '') return;
  try {
    await fetch(`${apiOrigin()}/api/all-replays?source=${source}`, {
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
