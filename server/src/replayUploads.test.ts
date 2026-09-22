import {mkdtempSync, rmSync} from 'node:fs';
import {readdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  REPLAY_FORMAT,
  parseReplay,
  serializeReplay,
  type ReplayData,
} from '../../src/app/replay.ts';
import {REPLAY_VERSION} from '../../src/shared/replayVersion.ts';
import * as CommandKind from '../../src/sim/commandKindEnum.ts';
import * as PlayerKind from '../../src/sim/playerKindEnum.ts';
import {
  MAX_UPLOADS_PER_HOUR,
  claimUploadSlot,
  isReplayId,
  listStoredReplays,
  mintReplayId,
  pruneStoredReplays,
  readStoredReplay,
  replayDir,
  resetUploadBudgets,
  storeReplay,
} from './replayUploads.ts';

/**
 * The shelf of uploaded replays: what gets filed, what gets refused, what
 * the listing says about it, and what falls off the end.
 *
 * Every test runs against a scratch state dir — the same SERF_STATE_DIR
 * seam the room-snapshot tests use — so nothing here touches a real one.
 */

let dir: string;
let priorStateDir: string | undefined;

beforeEach(() => {
  priorStateDir = process.env.SERF_STATE_DIR;
  dir = mkdtempSync(join(tmpdir(), 'serf-replays-'));
  process.env.SERF_STATE_DIR = dir;
  resetUploadBudgets();
});

afterEach(() => {
  if (priorStateDir === undefined) delete process.env.SERF_STATE_DIR;
  else process.env.SERF_STATE_DIR = priorStateDir;
  rmSync(dir, {recursive: true, force: true});
});

/** A recording of the shape a client actually uploads: this build's
 * version stamp, a two-seat table, and a couple of orders. */
function sampleReplay(over: Partial<ReplayData> = {}): ReplayData {
  return {
    format: REPLAY_FORMAT,
    replayVersion: REPLAY_VERSION,
    savedAt: '2026-01-01T00:00:00.000Z',
    config: {
      seed: 4242,
      players: [{kind: PlayerKind.human}, {kind: PlayerKind.ai}],
      myPlayerId: 0,
    },
    commands: [
      {tick: 5, commands: [{playerId: 0, cmd: {kind: CommandKind.hireSerf}}]},
      {tick: 9, commands: [{playerId: 1, cmd: {kind: CommandKind.hireSerf}}]},
    ],
    endTick: 1200,
    ...over,
  };
}

describe('filing an uploaded replay', () => {
  it('keeps a real recording and describes it', async () => {
    const stored = await storeReplay(serializeReplay(sampleReplay()), {
      source: 'solo',
      nowMs: Date.UTC(2026, 0, 2, 3, 4, 5, 6),
    });
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    const {summary} = stored;
    expect(isReplayId(summary.id)).toBe(true);
    expect(summary.source).toBe('solo');
    expect(summary.replayVersion).toBe(REPLAY_VERSION);
    expect(summary.endTick).toBe(1200);
    expect(summary.seed).toBe(4242);
    expect(summary.seat).toBe(0);
    // Named, not numbered: the shelf is read by a person, and the enum
    // values behind these are free to move.
    expect(summary.seats.map(s => s.kind)).toEqual(['human', 'ai']);
    expect(summary.commands).toBe(2);
    expect(summary.chat).toBe(0);
    expect(summary.bytes).toBeGreaterThan(0);

    // And the document itself comes back as a replay, not as whatever the
    // uploader happened to send.
    const raw = await readStoredReplay(summary.id);
    expect(raw).not.toBeNull();
    expect(parseReplay(raw!)?.endTick).toBe(1200);
  });

  it('refuses anything that is not a replay, and files nothing', async () => {
    for (const body of ['', 'not json', '{}', '{"format":"something-else"}']) {
      const stored = await storeReplay(body, {source: 'solo', nowMs: 1});
      expect(stored.ok).toBe(false);
    }
    expect(await listStoredReplays()).toEqual([]);
  });

  it('stores the screened replay, not the bytes that arrived', async () => {
    // The uploader is a browser we do not control. A field nobody asked
    // for must not reach the disk — what is written is parseReplay's
    // output, which is exactly what playback will read back.
    const doc = {
      ...sampleReplay(),
      smuggled: 'x'.repeat(5000),
    };
    const stored = await storeReplay(JSON.stringify(doc), {
      source: 'solo',
      nowMs: 1,
    });
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    const raw = (await readStoredReplay(stored.summary.id))!;
    expect(raw).not.toContain('smuggled');
    expect(stored.summary.bytes).toBe(Buffer.byteLength(raw));
  });

  it('drops a command the sim would not accept', async () => {
    // Same screen a network frame gets. A replay half of whose log is junk
    // is still worth keeping — the rest of the match is real — but the
    // junk does not get filed with it.
    const doc = sampleReplay({
      commands: [
        {tick: 3, commands: [{playerId: 0, cmd: {kind: 'nonsense'}}]},
        {
          tick: 4,
          commands: [{playerId: 0, cmd: {kind: CommandKind.hireSerf}}],
        },
      ] as ReplayData['commands'],
    });
    const stored = await storeReplay(JSON.stringify(doc), {
      source: 'net',
      nowMs: 1,
    });
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.summary.commands).toBe(1);
  });
});

describe('the shelf', () => {
  it('lists newest first', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const stored = await storeReplay(
        serializeReplay(sampleReplay({endTick: 100 + i})),
        {source: 'solo', nowMs: 1_000 + i * 1_000},
      );
      expect(stored.ok).toBe(true);
      if (stored.ok) ids.push(stored.summary.id);
    }
    const listed = await listStoredReplays();
    expect(listed.map(r => r.id)).toEqual([...ids].reverse());
    expect(listed[0]!.endTick).toBe(102);
  });

  it('answers nothing at all before anything is uploaded', async () => {
    // No directory yet — a relay that has never been played on must not
    // fail the listing, it must say the shelf is empty.
    expect(await listStoredReplays()).toEqual([]);
  });

  it('will not read an id that names a file outside the shelf', async () => {
    // Ids are joined onto a directory path, so this is the one place a
    // request could otherwise walk out of it.
    expect(await readStoredReplay('../rooms')).toBeNull();
    expect(await readStoredReplay('../../etc/passwd')).toBeNull();
    expect(await readStoredReplay('20260101-000000000-abcdef')).toBeNull();
    expect(isReplayId('../rooms')).toBe(false);
    expect(isReplayId(mintReplayId(new Date()))).toBe(true);
  });

  it('leaves out a recording whose summary never landed', async () => {
    // What an interrupted store leaves behind: the replay under its real
    // name, no meta beside it. Invisible to the listing rather than a row
    // that cannot describe itself.
    const id = mintReplayId(new Date(1));
    await storeReplay(serializeReplay(sampleReplay()), {
      source: 'solo',
      nowMs: 2,
    });
    await writeFile(join(replayDir(), `${id}.json`), '{}');
    const listed = await listStoredReplays();
    expect(listed.map(r => r.id)).not.toContain(id);
    expect(listed).toHaveLength(1);
  });
});

describe('pruning', () => {
  async function fileSome(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const stored = await storeReplay(serializeReplay(sampleReplay()), {
        source: 'solo',
        nowMs: 1_000 + i * 1_000,
      });
      if (stored.ok) ids.push(stored.summary.id);
    }
    return ids;
  }

  it('drops the oldest past the count', async () => {
    const ids = await fileSome(4);
    expect(await pruneStoredReplays({count: 2})).toBe(2);
    const left = await listStoredReplays();
    expect(left.map(r => r.id)).toEqual([ids[3]!, ids[2]!]);
    // Both halves of a dropped record go with it.
    const files = await readdir(replayDir());
    expect(files.filter(f => f.startsWith(ids[0]!))).toEqual([]);
  });

  it('drops the oldest past the byte budget', async () => {
    const ids = await fileSome(3);
    const one = (await listStoredReplays())[0]!.bytes;
    // Room for two, not three.
    expect(await pruneStoredReplays({bytes: one * 2 + 1})).toBe(1);
    expect((await listStoredReplays()).map(r => r.id)).toEqual([
      ids[2]!,
      ids[1]!,
    ]);
  });

  it('sweeps the debris of an interrupted store', async () => {
    // A replay with no summary counts as nothing on the byte budget, so
    // it is only the count that ever clears it — which it must, or the
    // wreckage accumulates forever, invisible to the listing that would
    // have shown it.
    const orphan = mintReplayId(new Date(1));
    await fileSome(2);
    await writeFile(join(replayDir(), `${orphan}.json`), '{}');
    expect(await pruneStoredReplays({count: 2})).toBe(1);
    expect(await readStoredReplay(orphan)).toBeNull();
  });

  it('does nothing while the shelf is inside its limits', async () => {
    await fileSome(2);
    expect(await pruneStoredReplays({count: 10})).toBe(0);
    expect(await listStoredReplays()).toHaveLength(2);
  });
});

describe('the per-address upload budget', () => {
  it('spends, and refuses when spent', () => {
    for (let i = 0; i < MAX_UPLOADS_PER_HOUR; i++) {
      expect(claimUploadSlot('1.2.3.4', 1000)).toBe(true);
    }
    expect(claimUploadSlot('1.2.3.4', 1000)).toBe(false);
    // One address's spending is its own.
    expect(claimUploadSlot('5.6.7.8', 1000)).toBe(true);
  });

  it('refills as the hour rolls off', () => {
    for (let i = 0; i < MAX_UPLOADS_PER_HOUR; i++) {
      claimUploadSlot('1.2.3.4', 1000);
    }
    expect(claimUploadSlot('1.2.3.4', 1000)).toBe(false);
    expect(claimUploadSlot('1.2.3.4', 1000 + 60 * 60 * 1000)).toBe(true);
  });
});
