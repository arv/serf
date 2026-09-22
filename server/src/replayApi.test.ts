import {mkdtempSync, rmSync} from 'node:fs';
import {createServer, type Server} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  REPLAY_FORMAT,
  serializeReplay,
  type ReplayData,
} from '../../src/app/replay.ts';
import {REPLAY_VERSION} from '../../src/shared/replayVersion.ts';
import * as CommandKind from '../../src/sim/commandKindEnum.ts';
import * as PlayerKind from '../../src/sim/playerKindEnum.ts';
import {setLogSink} from './log.ts';
import {REPLAY_API_PREFIX, handleReplayApi} from './replayApi.ts';
import {MAX_UPLOAD_BYTES, resetUploadBudgets} from './replayUploads.ts';

/**
 * The replay shelf over a real socket: the routes a browser actually
 * speaks to, answered by the same handler index.ts mounts.
 *
 * A live server rather than a fake request object, because most of what
 * this module does is HTTP — status codes, the body cap that has to bite
 * before the body finishes arriving, CORS headers the cross-origin dev
 * setup depends on, and a path that must never reach outside the shelf.
 */

let server: Server;
let base: string;
let dir: string;
let priorStateDir: string | undefined;
let priorKey: string | undefined;

beforeEach(async () => {
  priorStateDir = process.env.SERF_STATE_DIR;
  priorKey = process.env.SERF_REPLAY_KEY;
  delete process.env.SERF_REPLAY_KEY;
  dir = mkdtempSync(join(tmpdir(), 'serf-replay-api-'));
  process.env.SERF_STATE_DIR = dir;
  resetUploadBudgets();
  // The upload path logs a line per request; the suite is not where they
  // belong.
  setLogSink(() => undefined);
  server = createServer((req, res) => {
    void handleReplayApi(req, res).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(async () => {
  setLogSink(null);
  await new Promise<void>(resolve => void server.close(() => resolve()));
  if (priorStateDir === undefined) delete process.env.SERF_STATE_DIR;
  else process.env.SERF_STATE_DIR = priorStateDir;
  if (priorKey === undefined) delete process.env.SERF_REPLAY_KEY;
  else process.env.SERF_REPLAY_KEY = priorKey;
  rmSync(dir, {recursive: true, force: true});
});

function sampleReplay(over: Partial<ReplayData> = {}): string {
  return serializeReplay({
    format: REPLAY_FORMAT,
    replayVersion: REPLAY_VERSION,
    config: {
      seed: 7,
      players: [{kind: PlayerKind.human}, {kind: PlayerKind.ai}],
      myPlayerId: 0,
    },
    commands: [
      {tick: 2, commands: [{playerId: 0, cmd: {kind: CommandKind.hireSerf}}]},
    ],
    endTick: 400,
    ...over,
  });
}

/** What the game's own upload looks like on the wire: a text/plain POST,
 * which is a CORS-simple request and so costs no preflight. */
function post(body: string, query = '?source=solo'): Promise<Response> {
  return fetch(`${base}${REPLAY_API_PREFIX}${query}`, {
    method: 'POST',
    headers: {'content-type': 'text/plain;charset=UTF-8'},
    body,
  });
}

describe('uploading', () => {
  it('takes a recording and hands back its id', async () => {
    const res = await post(sampleReplay());
    expect(res.status).toBe(201);
    const {id} = (await res.json()) as {id: string};
    expect(id).toMatch(/^\d{8}-\d{9}-[0-9a-f]{6}$/);

    const listed = await fetch(`${base}${REPLAY_API_PREFIX}`);
    const {replays} = (await listed.json()) as {
      replays: {id: string; source: string; endTick: number}[];
    };
    expect(replays).toHaveLength(1);
    expect(replays[0]!.id).toBe(id);
    expect(replays[0]!.source).toBe('solo');
    expect(replays[0]!.endTick).toBe(400);
  });

  it('believes the source only where it is one of the two', async () => {
    await post(sampleReplay(), '?source=net');
    await post(sampleReplay(), '?source=nonsense');
    const {replays} = (await (
      await fetch(`${base}${REPLAY_API_PREFIX}`)
    ).json()) as {replays: {source: string}[]};
    expect(replays.map(r => r.source).sort()).toEqual(['net', 'solo']);
  });

  it('refuses a body that is not a replay', async () => {
    expect((await post('{"not":"a replay"}')).status).toBe(400);
    const {replays} = (await (
      await fetch(`${base}${REPLAY_API_PREFIX}`)
    ).json()) as {replays: unknown[]};
    expect(replays).toEqual([]);
  });

  it('refuses a body past the cap', async () => {
    // Padding inside a valid replay, so what is being refused is the size
    // and nothing else.
    const huge = sampleReplay({savedAt: 'x'.repeat(MAX_UPLOAD_BYTES + 1024)});
    expect((await post(huge)).status).toBe(413);
  });

  it('stops an address that will not stop', async () => {
    // The budget is per address and the loopback is one address, so the
    // run itself exhausts it — which is the behaviour: a client looping
    // uploads fills a volume, and a refusal costs it nothing it can see.
    let refused = 0;
    for (let i = 0; i < 25; i++) {
      if ((await post(sampleReplay())).status === 429) refused++;
    }
    expect(refused).toBeGreaterThan(0);
  });
});

describe('reading', () => {
  it('serves one recording back as a replay document', async () => {
    const {id} = (await (await post(sampleReplay())).json()) as {id: string};
    const res = await fetch(`${base}${REPLAY_API_PREFIX}/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const doc = (await res.json()) as ReplayData;
    expect(doc.format).toBe(REPLAY_FORMAT);
    expect(doc.endTick).toBe(400);
  });

  it('answers an empty shelf rather than failing', async () => {
    const res = await fetch(`${base}${REPLAY_API_PREFIX}`);
    expect(res.status).toBe(200);
    expect((await res.json()) as {replays: unknown[]}).toEqual({replays: []});
  });

  it('will not be walked out of the shelf', async () => {
    // An id is joined onto a directory path. These are the shapes that
    // would otherwise name the room snapshot beside it — or anything else.
    for (const bad of [
      '..%2Frooms',
      '..%2F..%2Fetc%2Fpasswd',
      'rooms',
      'not-an-id',
    ]) {
      expect((await fetch(`${base}${REPLAY_API_PREFIX}/${bad}`)).status).toBe(
        404,
      );
    }
  });

  it('carries the headers a cross-origin page needs', async () => {
    // Development serves the game from vite on another port, and the page
    // is cross-origin isolated — without these it cannot read a word.
    const res = await fetch(`${base}${REPLAY_API_PREFIX}`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cross-origin-resource-policy')).toBe(
      'cross-origin',
    );
    const pre = await fetch(`${base}${REPLAY_API_PREFIX}`, {method: 'OPTIONS'});
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-methods')).toContain('POST');
  });
});

describe('with SERF_REPLAY_KEY set', () => {
  beforeEach(() => {
    process.env.SERF_REPLAY_KEY = 'open-sesame';
  });

  it('shuts the reading half and leaves uploading open', async () => {
    // Uploading cannot want the key: every copy of the game would have to
    // carry it, which is no secret at all.
    const res = await post(sampleReplay());
    expect(res.status).toBe(201);
    const {id} = (await res.json()) as {id: string};

    expect((await fetch(`${base}${REPLAY_API_PREFIX}`)).status).toBe(404);
    expect((await fetch(`${base}${REPLAY_API_PREFIX}?key=wrong`)).status).toBe(
      404,
    );
    expect((await fetch(`${base}${REPLAY_API_PREFIX}/${id}`)).status).toBe(404);

    const opened = await fetch(`${base}${REPLAY_API_PREFIX}?key=open-sesame`);
    expect(opened.status).toBe(200);
    expect(
      (await fetch(`${base}${REPLAY_API_PREFIX}/${id}?key=open-sesame`)).status,
    ).toBe(200);
  });
});
