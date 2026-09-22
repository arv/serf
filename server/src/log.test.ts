import type {IncomingMessage} from 'node:http';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  clientFields,
  clientIp,
  formatLogLine,
  logEvent,
  setLogSink,
} from './log.ts';

function request(
  headers: Record<string, string | string[]>,
  remoteAddress = '10.0.0.9',
): IncomingMessage {
  return {headers, socket: {remoteAddress}} as unknown as IncomingMessage;
}

/** Say which deployment a case is about, rather than inheriting it from
 * whatever variables the suite happens to run under. */
function trustProxy(yes: boolean): void {
  process.env.SERF_TRUST_PROXY = yes ? '1' : '0';
}

describe('structured log', () => {
  afterEach(() => setLogSink(null));

  it('writes one JSON object per line with level, message and event', () => {
    const lines: string[] = [];
    setLogSink(line => lines.push(line));
    logEvent('match_start', 'match started', {room: 'ABCD', humans: 2});
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({
      level: 'info',
      message: 'match started',
      event: 'match_start',
      room: 'ABCD',
      humans: 2,
    });
    expect(Number.isNaN(Date.parse(parsed.time))).toBe(false);
  });

  it('keeps the fixed keys ahead of the event fields', () => {
    const keys = Object.keys(
      JSON.parse(formatLogLine('connect', 'm', {ip: 'x'})),
    );
    expect(keys).toEqual(['level', 'time', 'message', 'event', 'ip']);
  });
});

describe('clientIp', () => {
  let prior: string | undefined;

  beforeEach(() => {
    prior = process.env.SERF_TRUST_PROXY;
    // The deployment these were all written for. The cases that are about
    // the other one say so.
    trustProxy(true);
  });

  afterEach(() => {
    if (prior === undefined) delete process.env.SERF_TRUST_PROXY;
    else process.env.SERF_TRUST_PROXY = prior;
  });

  it('falls back to the socket peer with no proxy headers', () => {
    expect(clientIp(request({}))).toBe('10.0.0.9');
  });

  it('believes no forwarded header with no proxy to have written it', () => {
    // The whole point of the switch. Run directly, X-Forwarded-For is not
    // evidence of anything — it is a string the caller chose, and a caller
    // that gets to choose its own address gets a fresh upload budget every
    // time it asks for one.
    trustProxy(false);
    expect(clientIp(request({'x-forwarded-for': '1.1.1.1, 203.0.113.7'}))).toBe(
      '10.0.0.9',
    );
    expect(clientIp(request({'x-real-ip': '198.51.100.4'}))).toBe('10.0.0.9');
  });

  it('keeps a disbelieved claim in the log line anyway', () => {
    // Dropped rather than believed, but not dropped from sight: a request
    // claiming to come from somewhere else is the most interesting thing
    // in the line it wrote, and the ip beside it is now the socket peer.
    trustProxy(false);
    expect(clientFields(request({'x-forwarded-for': '203.0.113.7'}))).toEqual({
      ip: '10.0.0.9',
      ua: '',
      forwardedFor: '203.0.113.7',
    });
  });

  it('credits a Railway deployment without being told to', () => {
    // The one arrangement this repo documents deploying to puts an edge
    // proxy in front, and a setting that has to be remembered on the day
    // of the deploy is a setting that silently buckets the whole internet
    // under one address when it is not. Railway stamps its own variables
    // into the environment, so the deployment says so itself.
    delete process.env.SERF_TRUST_PROXY;
    const priorRailway = process.env.RAILWAY_VOLUME_MOUNT_PATH;
    process.env.RAILWAY_VOLUME_MOUNT_PATH = '/data';
    try {
      expect(clientIp(request({'x-forwarded-for': '203.0.113.7'}))).toBe(
        '203.0.113.7',
      );
    } finally {
      if (priorRailway === undefined)
        delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
      else process.env.RAILWAY_VOLUME_MOUNT_PATH = priorRailway;
    }
  });

  it('lets the setting overrule the deployment either way', () => {
    // An explicit answer is always the answer: a Railway service put
    // behind nothing, or a self-hosted one behind a proxy of its own.
    const priorRailway = process.env.RAILWAY_VOLUME_MOUNT_PATH;
    process.env.RAILWAY_VOLUME_MOUNT_PATH = '/data';
    try {
      trustProxy(false);
      expect(clientIp(request({'x-forwarded-for': '203.0.113.7'}))).toBe(
        '10.0.0.9',
      );
      process.env.SERF_TRUST_PROXY = 'false';
      expect(clientIp(request({'x-forwarded-for': '203.0.113.7'}))).toBe(
        '10.0.0.9',
      );
    } finally {
      if (priorRailway === undefined)
        delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
      else process.env.RAILWAY_VOLUME_MOUNT_PATH = priorRailway;
    }
  });

  it('takes the rightmost X-Forwarded-For entry — the proxy-appended one', () => {
    expect(clientIp(request({'x-forwarded-for': '1.1.1.1, 203.0.113.7'}))).toBe(
      '203.0.113.7',
    );
    expect(clientIp(request({'x-forwarded-for': ' 203.0.113.7 '}))).toBe(
      '203.0.113.7',
    );
  });

  it('ignores an X-Real-IP that is only whitespace', () => {
    // Judging it by its length before trimming blanked the address.
    expect(clientIp(request({'x-real-ip': '  '}))).toBe('10.0.0.9');
  });

  it('falls back to X-Real-IP only when nothing was forwarded', () => {
    expect(clientIp(request({'x-real-ip': '198.51.100.4'}))).toBe(
      '198.51.100.4',
    );
  });

  it('believes the forwarded chain over a client-supplied X-Real-IP', () => {
    // Nothing appends to X-Real-IP, so a request can arrive carrying one;
    // the rightmost forwarded entry is the hop the proxy itself wrote.
    expect(
      clientIp(
        request({'x-real-ip': '198.51.100.4', 'x-forwarded-for': '1.1.1.1'}),
      ),
    ).toBe('1.1.1.1');
  });

  it('reports forwardedFor only for a chain of more than one hop', () => {
    expect(clientFields(request({'user-agent': 'ua'}))).toEqual({
      ip: '10.0.0.9',
      ua: 'ua',
    });
    expect(
      clientFields(request({'x-forwarded-for': '1.1.1.1, 203.0.113.7'})),
    ).toEqual({
      ip: '203.0.113.7',
      ua: '',
      forwardedFor: '1.1.1.1, 203.0.113.7',
    });
  });

  it('reads a repeated header the same way clientIp does', () => {
    // Node joins duplicates into one string, so this is belt and braces —
    // but the chain must not vanish from the fields while the ip resolves.
    const req = request({'x-forwarded-for': ['1.1.1.1', '203.0.113.7']});
    expect(clientIp(req)).toBe('203.0.113.7');
    expect(clientFields(req).forwardedFor).toBe('1.1.1.1, 203.0.113.7');
  });
});

describe('reserved keys', () => {
  it("keeps the line's own fields authoritative", () => {
    const parsed = JSON.parse(
      formatLogLine('connect', 'real message', {
        level: 'error',
        message: 'spoofed',
        event: 'match_start',
        time: 'nonsense',
        room: 'ABCD',
      }),
    );
    expect(parsed).toEqual({
      level: 'info',
      time: parsed.time,
      message: 'real message',
      event: 'connect',
      room: 'ABCD',
    });
    expect(Number.isNaN(Date.parse(parsed.time))).toBe(false);
  });
});
