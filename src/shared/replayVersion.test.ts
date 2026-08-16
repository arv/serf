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
const EXPECTED_VERSION = 3;
const EXPECTED_HASH = 'ab2a8190dc88354933497968aec81598';

/**
 * Everything a replay's playback depends on, as raw source:
 * - the sim — the machine the log re-runs through: systems, defs,
 *   worldgen, pathfinding, command application;
 * - the shared primitives it computes with — a new Rng constant or grid
 *   rule reshapes every tick downstream;
 * - the replay format itself: shape, screening, serialization.
 */
const SOURCES = import.meta.glob(['/src/sim/**/*.ts', '/src/shared/*.ts', '/src/app/replay.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

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
