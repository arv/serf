import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {TICK_MS} from '../sim/defs/balance';
import {
  MIN_ABANDONED_TICKS,
  apiOrigin,
  fetchUploadedReplay,
  fetchUploadedReplays,
  uploadReplay,
  worthUploading,
} from './replayUpload';

/**
 * The client half of the replay shelf.
 *
 * Two things are worth pinning down here. One is where the upload is
 * aimed: the relay's own origin, which is what makes the same build work
 * against a vite dev server on one port and a self-hosting relay in
 * production. The other is the contract that matters more than any of it
 * — nothing in this module is allowed to throw, whatever the network does,
 * because the player is never told any of it happened.
 */

/** Calls recorded off a stubbed fetch, as [url, init] pairs. */
let calls: [string, RequestInit | undefined][];

function stubFetch(impl: () => Promise<Response>): void {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push([url, init]);
    return impl();
  });
}

function jsonResponse(body: unknown, ok = true): Promise<Response> {
  return Promise.resolve({
    ok,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

beforeEach(() => {
  calls = [];
  // The dev arrangement: the page on vite's port, the relay beside it.
  vi.stubGlobal('location', {
    hostname: 'localhost',
    host: 'localhost:5173',
    protocol: 'http:',
    search: '',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('where the server is', () => {
  it('is the relay, over http', () => {
    expect(apiOrigin('')).toBe('http://localhost:8787');
  });

  it('follows a ?relay= this origin is allowed to name', () => {
    // The relay's own allowlist decides — a URL parameter does not get to
    // pick whose server this cross-origin-isolated page talks to. Loopback
    // from loopback is the one case a link may redirect, and it is the one
    // developing against a second relay needs.
    expect(apiOrigin('?relay=ws://127.0.0.1:9000')).toBe(
      'http://127.0.0.1:9000',
    );
    expect(apiOrigin('?relay=wss://someone-elses-server.example')).toBe(
      'http://localhost:8787',
    );
  });

  it('keeps the scheme in step with the socket’s', () => {
    vi.stubGlobal('location', {
      hostname: 'serf.example',
      host: 'serf.example',
      protocol: 'https:',
      search: '',
    });
    expect(apiOrigin('?relay=wss://serf.example')).toBe('https://serf.example');
  });
});

describe('which matches are worth filing', () => {
  it('files every decided match, however short', () => {
    // Somebody won. How fast is one of the things the shelf is kept to
    // answer, so a quick game is data rather than noise.
    expect(worthUploading('decided', 0)).toBe(true);
    expect(worthUploading('decided', 5)).toBe(true);
  });

  it('holds an abandoned one to half a minute of play', () => {
    // A launch opened and backed straight out of is the commonest thing
    // that happens to the match screen, and the shelf is finite.
    expect(worthUploading('abandoned', 0)).toBe(false);
    expect(worthUploading('abandoned', MIN_ABANDONED_TICKS - 1)).toBe(false);
    expect(worthUploading('abandoned', MIN_ABANDONED_TICKS)).toBe(true);
  });

  it('puts that floor at thirty seconds of sim time', () => {
    // Stated in seconds rather than ticks, so a change to the tick rate
    // moves the constant rather than the rule.
    expect(MIN_ABANDONED_TICKS * TICK_MS).toBe(30_000);
  });
});

describe('uploading a finished match', () => {
  it('posts the recording as text, with the source and ending named', async () => {
    stubFetch(() => jsonResponse({id: 'x'}));
    await uploadReplay('{"format":"serf-replay"}', {
      source: 'net',
      ending: 'decided',
      origin: 'http://localhost:8787',
    });
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(url).toBe(
      'http://localhost:8787/api/all-replays?source=net&ending=decided',
    );
    expect(init?.method).toBe('POST');
    // text/plain keeps it a CORS-simple request, so the dev setup costs no
    // preflight round trip.
    expect(
      (init?.headers as Record<string, string> | undefined)?.['content-type'],
    ).toContain('text/plain');
    expect(init?.body).toBe('{"format":"serf-replay"}');
    expect(init?.credentials).toBe('omit');
  });

  it('sends nothing when there is no recording to send', async () => {
    // Empty is what the worker answers while it is playing a replay back,
    // and what the relay answers while a room's outcome is undecided.
    stubFetch(() => jsonResponse({}));
    await uploadReplay('', {
      source: 'solo',
      ending: 'decided',
      origin: 'http://localhost:8787',
    });
    expect(calls).toEqual([]);
  });

  it('says so when the match was walked out of', async () => {
    // The shelf keeps the two apart: a game someone quit is different
    // evidence from a game they played to a winner.
    stubFetch(() => jsonResponse({id: 'x'}));
    await uploadReplay('{"a":1}', {
      source: 'solo',
      ending: 'abandoned',
      origin: 'http://localhost:8787',
    });
    expect(calls[0]![0]).toBe(
      'http://localhost:8787/api/all-replays?source=solo&ending=abandoned',
    );
  });

  it('swallows a network that is not there', async () => {
    // The whole contract: a player with no network plays the game they
    // would have played anyway, and hears nothing about this.
    stubFetch(() => Promise.reject(new Error('offline')));
    await expect(
      uploadReplay('{"a":1}', {
        source: 'solo',
        ending: 'decided',
        origin: 'http://localhost:8787',
      }),
    ).resolves.toBeUndefined();
  });

  it('swallows a server that refuses', async () => {
    stubFetch(() => jsonResponse({error: 'too many uploads'}, false));
    await expect(
      uploadReplay('{"a":1}', {
        source: 'solo',
        ending: 'decided',
        origin: 'http://localhost:8787',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('reading the shelf', () => {
  it('asks for the listing and hands back its rows', async () => {
    stubFetch(() => jsonResponse({replays: [{id: 'a'}, {id: 'b'}]}));
    const rows = await fetchUploadedReplays(null);
    expect(calls[0]![0]).toBe('http://localhost:8787/api/all-replays');
    expect(rows?.map(r => r.id)).toEqual(['a', 'b']);
  });

  it('carries the key onto both read routes', async () => {
    stubFetch(() => jsonResponse({replays: []}));
    await fetchUploadedReplays('s3cret/key');
    await fetchUploadedReplay('20260101-000000000-abcdef', 's3cret/key');
    expect(calls[0]![0]).toBe(
      'http://localhost:8787/api/all-replays?key=s3cret%2Fkey',
    );
    expect(calls[1]![0]).toBe(
      'http://localhost:8787/api/all-replays/20260101-000000000-abcdef?key=s3cret%2Fkey',
    );
  });

  it('answers null rather than throwing when the shelf cannot be read', async () => {
    stubFetch(() => Promise.reject(new Error('offline')));
    expect(await fetchUploadedReplays(null)).toBeNull();
    expect(await fetchUploadedReplay('20260101-000000000-abcdef', null)).toBe(
      null,
    );
    stubFetch(() => jsonResponse({error: 'not found'}, false));
    expect(await fetchUploadedReplays(null)).toBeNull();
    expect(await fetchUploadedReplay('20260101-000000000-abcdef', null)).toBe(
      null,
    );
  });

  it('answers null for a listing that is not a listing', async () => {
    stubFetch(() => jsonResponse({replays: 'nope'}));
    expect(await fetchUploadedReplays(null)).toBeNull();
  });
});
