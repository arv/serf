import type {IncomingMessage} from 'node:http';
import {BlockList, isIP} from 'node:net';

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
  /** The host listed the room or took it off the list, from the council. */
  | 'room_visibility'
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
  return onRailway();
}

/** Whether this process is one Railway started, by the variables it
 * stamps into every deployment's environment. */
function onRailway(): boolean {
  return Object.keys(process.env).some(k => k.startsWith('RAILWAY_'));
}

/**
 * Cloudflare's own addresses, as it publishes them
 * (https://www.cloudflare.com/ips/). A request whose last hops include one
 * of these came through Cloudflare, and only then is CF-Connecting-IP
 * something Cloudflare wrote rather than something the caller typed.
 */
const CLOUDFLARE = new BlockList();
for (const [net, prefix] of [
  ['173.245.48.0', 20],
  ['103.21.244.0', 22],
  ['103.22.200.0', 22],
  ['103.31.4.0', 22],
  ['141.101.64.0', 18],
  ['108.162.192.0', 18],
  ['190.93.240.0', 20],
  ['188.114.96.0', 20],
  ['197.234.240.0', 22],
  ['198.41.128.0', 17],
  ['162.158.0.0', 15],
  ['104.16.0.0', 13],
  ['104.24.0.0', 14],
  ['172.64.0.0', 13],
  ['131.0.72.0', 22],
] as const)
  CLOUDFLARE.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['2400:cb00::', 32],
  ['2606:4700::', 32],
  ['2803:f800::', 32],
  ['2405:b500::', 32],
  ['2405:8100::', 32],
  ['2a06:98c0::', 29],
  ['2c0f:f248::', 32],
] as const)
  CLOUDFLARE.addSubnet(net, prefix, 'ipv6');

function isCloudflare(ip: string | undefined): boolean {
  if (ip === undefined) return false;
  const family = isIP(ip);
  return family !== 0 && CLOUDFLARE.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * Whether Cloudflare was a hop this request really took, and so whether
 * the CF-* headers on it are Cloudflare's word rather than the caller's.
 * Read off what the proxy in front recorded — see clientIp — and never
 * true with no proxy to have recorded anything.
 */
export function cameThroughCloudflare(req: IncomingMessage): boolean {
  if (!trustsProxyHeaders()) return false;
  return (
    isCloudflare(headerValue(req, 'x-real-ip')) ||
    forwardedChain(req).slice(-2).some(isCloudflare)
  );
}

/** One header as a single trimmed value, or undefined when it is absent,
 * repeated, or nothing but spaces — none of which is an address. */
function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}

/**
 * The address the request came from. With no proxy to credit, that is the
 * socket peer: the only address the process actually observed.
 *
 * Behind a proxy we believe, the peer is that proxy and the client rides
 * in a header. Which header depends on what is in front, and getting it
 * wrong is quiet: every line still carries an address, just not the
 * player's. Three arrangements, most specific first.
 *
 * Cloudflare in front of the proxy. Cloudflare writes the visitor's
 * address into CF-Connecting-IP, overwriting whatever arrived, so it is
 * believed — but only when the request demonstrably came through
 * Cloudflare, which is read off the hops the proxy itself recorded: one of
 * the last two forwarded entries, or X-Real-IP, is an address Cloudflare
 * owns. A caller who reaches the origin some other way can type the
 * header but cannot make the proxy record a Cloudflare peer.
 *
 * Railway. Its edge sets X-Real-IP to the client and documents that as
 * the header to read. The forwarded chain there ends in the edge's OWN
 * address — measured: every production line named a CDN node in Czechia
 * whoever was playing, which is how one player's game came to be filed
 * under a village they had never heard of, and how every player came to
 * share one upload budget.
 *
 * Any other proxy (SERF_TRUST_PROXY). The rightmost forwarded entry is
 * the one the nearest proxy appended — a client can prepend anything it
 * likes, but it cannot append after the proxy has. X-Real-IP is only the
 * fallback here: nothing appends to it, so with a proxy not known to
 * overwrite it, one that arrives carrying a value is indistinguishable
 * from one the proxy wrote.
 */
export function clientIp(req: IncomingMessage): string {
  if (trustsProxyHeaders()) {
    const chain = forwardedChain(req);
    const real = headerValue(req, 'x-real-ip');
    const visitor = headerValue(req, 'cf-connecting-ip');
    if (visitor !== undefined && cameThroughCloudflare(req)) return visitor;
    if (real !== undefined && onRailway()) return real;
    const last = chain[chain.length - 1];
    if (last) return last;
    if (real !== undefined) return real;
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
