/**
 * The HTTP face of the replay shelf: one upload route the game posts to
 * without being asked, and two read routes the /replays page uses.
 *
 *   POST /api/all-replays?source=solo|net   file a finished match's recording
 *   GET  /api/all-replays                   the shelf, newest first
 *   GET  /api/all-replays/<id>              one recording, as playback reads it
 *
 * The upload is deliberately the least ceremonious thing here. The client
 * sends it silently and never looks at the answer (src/app/replayUpload.ts),
 * so the status codes below are for whoever is reading the logs, not for
 * the game — nothing a refusal says ever reaches a player.
 *
 * Reading is the half that can be shut: set SERF_REPLAY_KEY and both GETs
 * want `?key=` to match. Uploading cannot be, since every copy of the game
 * would have to carry the secret to do it — which is no secret at all.
 * Left unset, the shelf is open to anyone who knows the path, which is the
 * honest description of what a URL nobody links to buys you.
 */

import type {IncomingMessage, ServerResponse} from 'node:http';
import {clientIp, logEvent} from './log.ts';
import {
  MAX_UPLOAD_BYTES,
  claimUploadSlot,
  isReplayId,
  listStoredReplays,
  pruneStoredReplays,
  readStoredReplay,
  storeReplay,
  type ReplaySource,
} from './replayUploads.ts';

/** Everything under this prefix belongs to this module, and nothing else
 * does — index.ts hands the whole family over in one check. */
export const REPLAY_API_PREFIX = '/api/all-replays';

function readKey(): string | undefined {
  const key = process.env.SERF_REPLAY_KEY;
  return key !== undefined && key.length > 0 ? key : undefined;
}

/**
 * Headers every answer here carries.
 *
 * CORS because in development the game is served by vite on its own port
 * while this process listens on another, so every one of these requests is
 * cross-origin — and the page is cross-origin isolated, which leaves it no
 * way to talk to an origin that has not said it may. In production the
 * game is served from this very process and the header costs nothing.
 *
 * Not the COOP/COEP pair the game's own documents carry: those describe a
 * top-level document, and these responses are data.
 */
function apiHeaders(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cross-origin-resource-policy', 'cross-origin');
  res.setHeader('x-content-type-options', 'nosniff');
  // Nothing here is worth a second copy: the shelf changes with every
  // match played, and a recording is fetched once and then watched.
  res.setHeader('cache-control', 'no-store');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  apiHeaders(res);
  res.writeHead(status, {'content-type': 'application/json'});
  res.end(JSON.stringify(body));
}

/**
 * The request body, up to the cap.
 *
 * Resolves null the moment the cap is passed rather than after the whole
 * thing has arrived: the point of a limit is not to read what it refuses.
 * The socket is left for the caller to answer on and close.
 */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: string | null): void => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        req.pause();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    // A connection that dies mid-body is an upload that never happened;
    // the promise must still settle or the handler leaks.
    req.on('error', () => finish(null));
    req.on('aborted', () => finish(null));
  });
}

/** 'solo' or 'net' as the client claimed, and 'solo' for anything else —
 * the field is a label on a chart, and a garbled one is not worth a
 * refusal that would cost the recording. */
function sourceFrom(params: URLSearchParams): ReplaySource {
  return params.get('source') === 'net' ? 'net' : 'solo';
}

/**
 * Answer a replay-shelf request. The caller has already established that
 * the URL is under REPLAY_API_PREFIX.
 */
export async function handleReplayApi(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rest = url.pathname.slice(REPLAY_API_PREFIX.length);

  // A preflight only happens when a client sends something a simple form
  // post could not; the game's own upload avoids one by posting text.
  if (req.method === 'OPTIONS') {
    apiHeaders(res);
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-max-age', '86400');
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && (rest === '' || rest === '/')) {
    await handleUpload(req, res, url.searchParams);
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    const key = readKey();
    if (key !== undefined && url.searchParams.get('key') !== key) {
      sendJson(res, 404, {error: 'not found'});
      return;
    }
    if (rest === '' || rest === '/') {
      sendJson(res, 200, {replays: await listStoredReplays()});
      return;
    }
    const id = rest.slice(1);
    const raw = isReplayId(id) ? await readStoredReplay(id) : null;
    if (raw === null) {
      sendJson(res, 404, {error: 'not found'});
      return;
    }
    apiHeaders(res);
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(raw);
    return;
  }

  sendJson(res, 405, {error: 'method not allowed'});
}

async function handleUpload(
  req: IncomingMessage,
  res: ServerResponse,
  params: URLSearchParams,
): Promise<void> {
  const ip = clientIp(req);
  const now = Date.now();
  if (!claimUploadSlot(ip, now)) {
    sendJson(res, 429, {error: 'too many uploads'});
    return;
  }
  const body = await readBody(req, MAX_UPLOAD_BYTES);
  if (body === null) {
    sendJson(res, 413, {error: 'too large'});
    return;
  }
  const stored = await storeReplay(body, {
    source: sourceFrom(params),
    nowMs: now,
  });
  if (!stored.ok) {
    // Logged, because this is where a client that broke its recording
    // shows up — and nothing else would ever say so, the game having
    // thrown the answer away.
    logEvent('replay_upload', `replay upload refused (${stored.reason})`, {
      ip,
      ok: false,
      reason: stored.reason,
      bytes: Buffer.byteLength(body),
    });
    sendJson(res, stored.reason === 'unreadable' ? 400 : 500, {
      error: stored.reason,
    });
    return;
  }
  const {summary} = stored;
  logEvent(
    'replay_upload',
    `replay ${summary.id} uploaded (${summary.source}, ${summary.endTick} ticks)`,
    {
      ip,
      ok: true,
      id: summary.id,
      source: summary.source,
      replayVersion: summary.replayVersion,
      endTick: summary.endTick,
      bytes: summary.bytes,
      commands: summary.commands,
      seats: summary.seats.length,
      mission: summary.mission ?? null,
      difficulty: summary.difficulty ?? null,
    },
  );
  sendJson(res, 201, {id: summary.id});
  // After the answer: the client is not waiting on it, and a prune that
  // walks five hundred summaries has no business holding the socket.
  try {
    const dropped = await pruneStoredReplays();
    if (dropped > 0) console.log(`[serf] pruned ${dropped} uploaded replay(s)`);
  } catch (err) {
    console.warn('[serf] pruning uploaded replays failed:', err);
  }
}
