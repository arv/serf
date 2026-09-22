import type {IncomingMessage} from 'node:http';

/**
 * Structured event log for the things an operator wants to count and look
 * up later: who connected, from where, which rooms were made, and every
 * multiplayer match that started. One JSON object per line on stdout, which
 * is what Railway's log explorer parses — `level` and `message` are the
 * keys it recognizes, and every other key becomes a filterable attribute
 * (`@event:match_start`, `@ip:1.2.3.4`). Plain text keeps working for the
 * lines that are only ever read by a human (`[serf] ...`), so those stay
 * as they are.
 */

export type LogEvent =
  /** A WebSocket client arrived. Every room action below carries its ip. */
  | 'connect'
  /** ...and left. Says how long it stayed and which room it was in. */
  | 'disconnect'
  /** The game's document was served: a person opened the page. Solo play
   * never touches the socket, so this is the only trace of most visits. */
  | 'page_view'
  | 'room_create'
  | 'room_join'
  | 'rejoin'
  /** A multiplayer match began. Count these to count games. */
  | 'match_start'
  /** A client handed up a finished match's recording — filed, or refused.
   * Solo play's only line in this log besides its page view, and the one
   * that says a game was actually played. */
  | 'replay_upload';

export type LogFields = Record<string, unknown>;

/** Swappable for tests; production writes to stdout. */
let sink: (line: string) => void = line => process.stdout.write(line + '\n');

export function setLogSink(next: ((line: string) => void) | null): void {
  sink = next ?? (line => process.stdout.write(line + '\n'));
}

/** The keys the line's own shape owns. An event that names one of these
 * would rewrite the very fields the log explorer filters and groups on,
 * so the fixed values win and the caller's copy is dropped. */
const RESERVED = new Set(['level', 'time', 'message', 'event']);

export function formatLogLine(
  event: LogEvent,
  message: string,
  fields: LogFields,
): string {
  // Fixed keys first so the line reads the same way every time, then the
  // event's own. `event` last among the fixed ones because it is the key
  // an operator filters on and it should sit next to what describes it.
  const own: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!RESERVED.has(key)) own[key] = value;
  }
  return JSON.stringify({
    level: 'info',
    time: new Date().toISOString(),
    message,
    event,
    ...own,
  });
}

export function logEvent(
  event: LogEvent,
  message: string,
  fields: LogFields = {},
): void {
  sink(formatLogLine(event, message, fields));
}

/**
 * Whether anything in front of this process is writing the forwarded
 * headers, and so whether they are evidence or just something the caller
 * typed.
 *
 * Behind Railway's edge they are evidence: the proxy appends the peer it
 * actually accepted, and a client cannot append after it. Run directly —
 * `node server/src/index.ts` on a public port, which the README documents
 * as a way to run this — nothing appends anything, and X-Forwarded-For is
 * whatever the request felt like claiming. Believing it there hands every
 * request a fresh identity for the asking, which costs the per-address
 * upload budget (replayUploads.ts) the whole of what it is for.
 *
 * So the headers are disbelieved unless something says otherwise.
 * SERF_TRUST_PROXY says so for any deployment that puts a proxy in front;
 * a Railway one says so by stamping its own variables into the
 * environment, so the arrangement this repo documents deploying to keeps
 * working without a new setting to forget on the day it is deployed.
 */
function trustsProxyHeaders(): boolean {
  const flag = process.env.SERF_TRUST_PROXY;
  if (flag !== undefined && flag !== '')
    return flag !== '0' && flag.toLowerCase() !== 'false';
  return Object.keys(process.env).some(k => k.startsWith('RAILWAY_'));
}

/**
 * The address the request came from. Behind a proxy we believe, the socket
 * peer is that proxy and the client's address rides in X-Forwarded-For:
 * the rightmost entry is the one the nearest proxy appended — a client can
 * prepend anything it likes, but it cannot append after the proxy has,
 * which is what makes that entry the one worth believing and why it is
 * consulted first. X-Real-IP is the same address in one field when a proxy
 * sets it, but nothing appends to it: a request that arrives carrying its
 * own is indistinguishable from one a proxy wrote, so it is only ever the
 * fallback, ahead of the bare socket peer.
 *
 * With no proxy to credit, none of that is true and the socket peer is the
 * only address the process actually observed.
 */
export function clientIp(req: IncomingMessage): string {
  if (trustsProxyHeaders()) {
    const parts = forwardedChain(req);
    const last = parts[parts.length - 1];
    if (last) return last;
    const real = req.headers['x-real-ip'];
    // Trimmed before it is judged: a header of nothing but spaces is not
    // an address, and taking it at its length would blank the ip rather
    // than fall through to the socket peer.
    if (typeof real === 'string' && real.trim().length > 0) return real.trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * X-Forwarded-For as a list of hops. Node joins repeated headers into one
 * comma-separated string, so the array arm is only ever belt and braces —
 * but it lives here, in one place, so that everything reading the chain
 * reads the same chain.
 */
function forwardedChain(req: IncomingMessage): string[] {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  if (!raw) return [];
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/** What a request says about the client, as the fields every event with a
 * request behind it carries. The user agent is kept whole: it is the one
 * clue to phone vs. desktop, and to a script that is not a browser. */
export interface ClientFields extends LogFields {
  ip: string;
  ua: string;
  /** The whole X-Forwarded-For chain, present only when it has more than
   * one hop — one hop is the ip already logged. */
  forwardedFor?: string;
}

export function clientFields(req: IncomingMessage): ClientFields {
  const chain = forwardedChain(req);
  const fields: ClientFields = {
    ip: clientIp(req),
    ua: req.headers['user-agent'] ?? '',
  };
  // Only when it says something the ip does not: more than one hop behind
  // a proxy we believe, and any hop at all when we do not, since a claim
  // that was disbelieved is the most interesting thing about the request
  // that made it and the one a log would otherwise lose.
  if (chain.length > 1 || (chain.length === 1 && chain[0] !== fields.ip))
    fields.forwardedFor = chain.join(', ');
  return fields;
}
