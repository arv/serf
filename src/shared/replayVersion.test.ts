import { describe, expect, it } from 'vitest';
import { REPLAY_VERSION } from './replayVersion';

/**
 * The guard that keeps REPLAY_VERSION honest. A replay only plays back
 * faithfully if the sim ticks exactly as it did when the log was written,
 * so the version must move whenever that behavior (or the file format)
 * does — and "must" enforced by memory is no enforcement at all. This test
 * hashes every file the compatibility rests on and compares it against the
 * hash pinned below, so any change to the surface fails CI until someone
 * has made the call the failure message asks for.
 *
 * Deliberately strict: the hash is over raw file contents, so a comment or
 * formatting edit fails too. That is the acceptable cost of never missing
 * a real change — the resolution is a ten-second hash update when nothing
 * behavioral moved.
 */

/** The pinned surface. When this test fails:
 *  1. Decide whether the change alters sim behavior or the replay format.
 *     Balance numbers, worldgen, tick systems, command semantics, the
 *     serialized shape — all yes. Comments, formatting, error text — no.
 *  2. If yes: bump REPLAY_VERSION in replayVersion.ts (old replays stop
 *     playing on the new build, which is the honest outcome).
 *  3. Either way: update EXPECTED_HASH to the value the failure prints.
 */
// 32 for the campaign's ground being composed rather than rolled: every
// tile of every mission map moved, so a mission log re-run on an older
// build is a log played on different ground (see replayVersion.ts).
// Still 32 after the Warlord's gold line and the Abbot's reordered ale:
// both are AI playbook data, and playback never runs a brain — a replay
// stores the seats' commands rather than re-deriving them (app/replay.ts),
// so a seat that would decide differently today replays as it decided then.
// Still 32 again across the glut-forge rule (sim/economyRules.ts), on that
// same reasoning one step further in: not playbook data this time but the
// rule layer that reads it, which is equally outside playback. A seat that
// now halts a forge it used to leave running emits orders whose tick
// semantics are untouched, so yesterday's logs still play back exactly.
// Still 33 after the enums moved to direct imports: every sim file's
// import list changed, and nothing else did — same constants, same
// tables, same order. The hash is over raw bytes, so it moved anyway.
// 33 for the ids themselves becoming numbers: a logged command names its
// kind in a word the screen no longer reads, and a shelf keyed by number
// enumerates in id order rather than in the order it was written. Both
// are in replayVersion.ts at length.
// Still 33 after oxfmt formatted the tree: the formatter rewrapped a few
// lines in sim/arrival.ts and sim/visibility.ts and touched nothing else.
// Whitespace, so every tick runs exactly as it did — the hash is over raw
// bytes, which is the one thing that moved.
const EXPECTED_VERSION = 33;
const EXPECTED_HASH = 'ee61e2bf9a26476b8e33e83fe0179bd9';

/**
 * Everything a replay's playback depends on, as raw source:
 * - the sim — the machine the log re-runs through: systems, defs,
 *   worldgen, pathfinding, command application;
 * - the authored mission maps (defs/maps/*.json) — a mission replay's
 *   world is built from the file, so a tile tweak reshapes the playback
 *   the same way a worldgen change does;
 * - the shared primitives it computes with — a new Rng constant or grid
 *   rule reshapes every tick downstream;
 * - the replay format itself: shape, screening, serialization.
 */
const SOURCES = import.meta.glob(
  ['/src/sim/**/*.ts', '/src/sim/defs/maps/*.json', '/src/shared/*.ts', '/src/app/replay.ts'],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
);

/** Repo-relative and sorted, so the hash is stable across machines. */
function surface(): [string, string][] {
  return Object.entries(SOURCES)
    .map(([path, raw]) => [path.replace(/^\/src\//, ''), raw as string] as [string, string])
    .filter(([path]) => !path.endsWith('.test.ts'))
    .filter(([path]) => path !== 'sim/testUtils.ts') // test scaffolding, never ticks
    .filter(([path]) => !path.startsWith('sim/debug/')) // DEV-only observers of the world
    .filter(([path]) => path !== 'shared/replayVersion.ts') // the version is the output, not the surface
    .sort(([a], [b]) => (a < b ? -1 : 1));
}

async function surfaceHash(): Promise<string> {
  let joined = '';
  for (const [path, raw] of surface()) {
    // Normalized newlines: the hash must say "the code changed", never
    // "this checkout's line endings differ".
    joined += path + '\0' + raw.replaceAll('\r\n', '\n') + '\0';
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(joined));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

describe('replay version', () => {
  it('is bumped when the compatibility surface changes', async () => {
    const actual = { version: REPLAY_VERSION, surfaceHash: await surfaceHash() };
    expect(
      actual,
      'The replay compatibility surface changed. If sim behavior or the replay format ' +
        'moved, bump REPLAY_VERSION in src/shared/replayVersion.ts; either way, pin the ' +
        `new hash in this test. Current surface hash: ${actual.surfaceHash}`,
    ).toEqual({ version: EXPECTED_VERSION, surfaceHash: EXPECTED_HASH });
  });

  it('covers the files that exist (a moved surface must not silently vanish)', () => {
    const files = surface().map(([path]) => path);
    // Spot anchors, not a full listing: if these are present the glob is
    // rooted right, and the hash covers whatever sits beside them.
    expect(files).toContain('sim/tick.ts');
    expect(files).toContain('sim/defs/balance.ts');
    expect(files).toContain('shared/rng.ts');
    expect(files).toContain('app/replay.ts');
    expect(files.length).toBeGreaterThan(30);
  });
});
