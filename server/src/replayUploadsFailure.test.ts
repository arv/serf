import {mkdtempSync, rmSync} from 'node:fs';
import {readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  REPLAY_FORMAT,
  serializeReplay,
  type ReplayData,
} from '../../src/app/replay.ts';
import {REPLAY_VERSION} from '../../src/shared/replayVersion.ts';
import * as CommandKind from '../../src/sim/commandKindEnum.ts';
import * as PlayerKind from '../../src/sim/playerKindEnum.ts';

/**
 * What a half-finished store leaves on the volume.
 *
 * The interesting failure is the summary's write, because by the time it
 * runs the replay itself has already been renamed into its real name and
 * the megabytes are on disk. The failure that causes it in the wild is a
 * full volume — which is exactly when leaving anything behind is worst,
 * and when no later upload will succeed to trigger a prune.
 *
 * It lives in its own file because reaching that state needs the fs
 * module mocked, and a mock hoisted over the main suite would sit under
 * twenty tests that have no use for it. Everything here passes through to
 * the real filesystem except the one write being failed on purpose.
 */

const state = vi.hoisted(() => ({failMetaWrites: false}));

vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    writeFile: (path: unknown, ...rest: never[]) => {
      // Only a plain path is inspected: the real signature also takes a
      // URL or an open handle, and neither is something the store passes
      // or this mock has any business stringifying.
      const named = typeof path === 'string' ? path : '';
      if (state.failMetaWrites && named.endsWith('.meta.json')) {
        return Promise.reject(
          Object.assign(new Error('ENOSPC: no space left on device'), {
            code: 'ENOSPC',
          }),
        );
      }
      return (real.writeFile as (...a: unknown[]) => Promise<void>)(
        path,
        ...rest,
      );
    },
  };
});

// Imported after the mock so the store gets the patched module.
const {listStoredReplays, replayDir, storeReplay} =
  await import('./replayUploads.ts');

let dir: string;
let priorStateDir: string | undefined;

beforeEach(() => {
  priorStateDir = process.env.SERF_STATE_DIR;
  dir = mkdtempSync(join(tmpdir(), 'serf-replay-fail-'));
  process.env.SERF_STATE_DIR = dir;
  state.failMetaWrites = false;
});

afterEach(() => {
  state.failMetaWrites = false;
  if (priorStateDir === undefined) delete process.env.SERF_STATE_DIR;
  else process.env.SERF_STATE_DIR = priorStateDir;
  rmSync(dir, {recursive: true, force: true});
});

function sampleReplay(over: Partial<ReplayData> = {}): ReplayData {
  return {
    format: REPLAY_FORMAT,
    replayVersion: REPLAY_VERSION,
    config: {
      seed: 11,
      players: [{kind: PlayerKind.human}, {kind: PlayerKind.ai}],
      myPlayerId: 0,
    },
    commands: [
      {tick: 4, commands: [{playerId: 0, cmd: {kind: CommandKind.hireSerf}}]},
    ],
    endTick: 900,
    ...over,
  };
}

describe('a store that fails after the replay is already on disk', () => {
  it('takes the replay back off with it', async () => {
    // Without the cleanup this leaves `<id>.json` with no summary beside
    // it: unlistable, and only swept by a prune that runs behind a
    // SUCCESSFUL upload — which a full volume never produces.
    state.failMetaWrites = true;
    const stored = await storeReplay(serializeReplay(sampleReplay()), {
      source: 'solo',
      ending: 'decided',
      nowMs: 1_000,
    });
    expect(stored.ok).toBe(false);
    if (stored.ok) return;
    expect(stored.reason).toBe('storage');

    // Nothing at all: not the replay, not a half-written summary, and not
    // the scratch file the rename should already have consumed.
    expect(await readdir(replayDir())).toEqual([]);
    expect(await listStoredReplays()).toEqual([]);
  });

  it('leaves the shelf it failed on exactly as it found it', async () => {
    // One good recording, then a failed one on top. The failure is not
    // allowed to cost the shelf anything it was already holding.
    const first = await storeReplay(serializeReplay(sampleReplay()), {
      source: 'solo',
      ending: 'decided',
      nowMs: 1_000,
    });
    expect(first.ok).toBe(true);

    state.failMetaWrites = true;
    const second = await storeReplay(
      serializeReplay(sampleReplay({endTick: 4_000})),
      {source: 'net', ending: 'abandoned', nowMs: 2_000},
    );
    expect(second.ok).toBe(false);

    const left = await listStoredReplays();
    expect(left).toHaveLength(1);
    if (first.ok) expect(left[0]!.id).toBe(first.summary.id);
    // Two files for the one survivor, and no debris from the other.
    expect((await readdir(replayDir())).sort()).toEqual(
      first.ok
        ? [`${first.summary.id}.json`, `${first.summary.id}.meta.json`].sort()
        : [],
    );
  });
});
