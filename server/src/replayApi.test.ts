import {mkdtempSync, rmSync} from 'node:fs';
import {createServer, type Server} from 'node:http';
import {connect} from 'node:net';
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
let priorTrust: string | undefined;

beforeEach(async () => {
  priorStateDir = process.env.SERF_STATE_DIR;
  priorKey = process.env.SERF_REPLAY_KEY;
  priorTrust = process.env.SERF_TRUST_PROXY;
  delete process.env.SERF_REPLAY_KEY;
  // Pinned rather than left to whatever the suite happens to run under:
  // these are the routes as a directly exposed server answers them, which
  // is the deployment where a forwarded header is only a claim.
  process.env.SERF_TRUST_PROXY = '0';
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
  if (priorTrust === undefined) delete process.env.SERF_TRUST_PROXY;
  else process.env.SERF_TRUST_PROXY = priorTrust;
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

  it('believes the two labels only where they name a value', async () => {
    // Neither is worth refusing a recording over: they are columns on a
    // listing, and a garbled one costs a sort key rather than a game.
    await post(sampleReplay(), '?source=net&ending=abandoned');
    await post(sampleReplay(), '?source=nonsense&ending=nonsense');
    // An older client says neither, and a match on the shelf at least got
    // as far as being filed.
    await post(sampleReplay(), '');
    const {replays} = (await (
      await fetch(`${base}${REPLAY_API_PREFIX}`)
    ).json()) as {replays: {source: string; ending: string}[]};
    expect(replays.map(r => r.source).sort()).toEqual(['net', 'solo', 'solo']);
    expect(replays.map(r => r.ending).sort()).toEqual([
      'abandoned',
      'decided',
      'decided',
    ]);
  });

  it('refuses a body that is not a replay', async () => {
    expect((await post('{"not":"a replay"}')).status).toBe(400);
    const {replays} = (await (
      await fetch(`${base}${REPLAY_API_PREFIX}`)
    ).json()) as {replays: unknown[]};
    expect(replays).toEqual([]);
  });

  it('refuses a recording that would never stop playing', async () => {
    // The shelf is an anonymous drop box, and a Watch link on it opens in
    // the author's browser. A ten-line replay claiming the end of time
    // costs nothing to post, lists as an ordinary row, and then plays
    // until the tab is closed. Screened on the way in, so no such row
    // ever reaches the shelf to be clicked.
    const forever = sampleReplay({endTick: Number.MAX_SAFE_INTEGER});
    expect((await post(forever)).status).toBe(400);
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

  it('takes the connection with it when it refuses an oversized body', async () => {
    // Stopping the read leaves the rest of the body unread on the socket,
    // and node will not drain a body the handler has already touched. The
    // 413 used to go out under keep-alive on a connection whose parser
    // was still sitting on the abandoned body: the next request on it was
    // never answered, and a client repeating the trick tied up one
    // connection apiece.
    //
    // Driven down a raw socket rather than through fetch, because what is
    // under test is the connection itself: the header a proxy would read,
    // and whether the server actually hangs up.
    const port = Number(new URL(base).port);
    const sock = connect(port, '127.0.0.1');
    await new Promise<void>(r => void sock.once('connect', () => r()));
    let seen = '';
    sock.on('data', d => {
      seen += d.toString();
    });
    // The hang-up under test arrives mid-write, so the pump below is
    // resetting a socket the server has already destroyed. That ECONNRESET
    // is the behaviour being asserted, not a failure.
    sock.on('error', () => undefined);
    const claimed = MAX_UPLOAD_BYTES * 2;
    sock.write(
      `POST ${REPLAY_API_PREFIX}?source=solo HTTP/1.1\r\n` +
        `Host: x\r\nContent-Type: text/plain\r\n` +
        `Content-Length: ${claimed}\r\n\r\n`,
    );
    // Dribbled, so the cap trips long before the body is finished.
    const chunk = Buffer.alloc(256 * 1024, 0x61);
    let sent = 0;
    const pump = setInterval(() => {
      if (sent >= claimed || sock.destroyed || sock.writableEnded) {
        clearInterval(pump);
        return;
      }
      sock.write(chunk);
      sent += chunk.length;
    }, 1);
    // Wait for the refusal, then for the hang-up that must follow it.
    await new Promise<void>(resolve => {
      const done = (): void => {
        clearInterval(pump);
        resolve();
      };
      sock.once('close', done);
      setTimeout(done, 5_000);
    });
    clearInterval(pump);

    // The hang-up is the assertion. Under keep-alive this socket stayed
    // open with its parser stuck on the abandoned body, and a second
    // request on it was never answered; `destroyed` was false here.
    //
    // Deliberately NOT asserting the 413 reached this client: closing
    // while bytes are still arriving is answered by an RST, which
    // discards whatever was in flight, so a client mid-body may see the
    // hang-up and nothing else. The test above covers the status for a
    // client that finished sending, which is the case a person debugging
    // with curl is in.
    expect(sock.destroyed).toBe(true);
    sock.destroy();
  }, 15_000);

  it('does not sell a fresh budget for the price of a header', async () => {
    // X-Forwarded-For is only evidence when a proxy wrote it. Exposed
    // directly, as the README documents running this, nothing appends
    // anything and the header is whatever the caller typed — so believing
    // it let one client claim a new address per request and upload
    // without limit, replacing a 256 MB shelf as often as it liked.
    //
    // No proxy in front (the suite pins SERF_TRUST_PROXY off), so the
    // socket peer is the only address this process observed and every one
    // of these requests shares it however they are labelled.
    let refused = 0;
    for (let i = 0; i < 25; i++) {
      const res = await fetch(`${base}${REPLAY_API_PREFIX}?source=solo`, {
        method: 'POST',
        headers: {
          'content-type': 'text/plain;charset=UTF-8',
          'x-forwarded-for': `203.0.113.${i}`,
        },
        body: sampleReplay(),
      });
      if (res.status === 429) refused++;
    }
    expect(refused).toBeGreaterThan(0);
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
