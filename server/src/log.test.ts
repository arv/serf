import type {IncomingMessage} from 'node:http';
import {afterEach, describe, expect, it} from 'vitest';
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
  it('falls back to the socket peer with no proxy headers', () => {
    expect(clientIp(request({}))).toBe('10.0.0.9');
  });

  it('takes the rightmost X-Forwarded-For entry — the proxy-appended one', () => {
    expect(clientIp(request({'x-forwarded-for': '1.1.1.1, 203.0.113.7'}))).toBe(
      '203.0.113.7',
    );
    expect(clientIp(request({'x-forwarded-for': ' 203.0.113.7 '}))).toBe(
      '203.0.113.7',
    );
  });

  it('prefers X-Real-IP when a proxy sets it', () => {
    expect(
      clientIp(
        request({'x-real-ip': '198.51.100.4', 'x-forwarded-for': '1.1.1.1'}),
      ),
    ).toBe('198.51.100.4');
  });

  it('reports the whole chain only when there is one', () => {
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
});
