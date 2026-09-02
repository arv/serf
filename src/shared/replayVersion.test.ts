import {describe, expect, it} from 'vitest';
import {REPLAY_VERSION} from './replayVersion';

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
// Still 33 after oxfmt formatted the tree (.oxfmtrc.json): 80-column
// wrapping, no space inside braces, and sorted import lists. Whitespace
// and import order — same constants, same tables, same statements, so
// every tick runs as it did. Side-effect imports are left unsorted by
// config, so nothing's evaluation order moved either. The hash is over
// raw bytes, which is why it moved anyway.
// Still 33 after the stance engine (systems/ai.ts #updateStance, the
// posture table's move into defs/aiPostures.ts, and the playbooks'
// stances field): all of it is brain and playbook data, and playback
// never runs a brain — the log already holds every move the seats made.
// The seats DECIDE differently now; yesterday's logs still play back
// exactly, because the sim that executes their logged commands is
// untouched.
// Still 33 after the war behaviors (warBehaviorIdEnum.ts, AI_WAR,
// harassment sorties, outpost defense, the retreating march, the fleeing
// scout, the grudge): the same reasoning one layer wider. Every verb
// speaks in commands the sim already took; the tick that executes them
// did not move.
// 34 for the herald: a new command kind and a new game event — pure
// format, and format is half of what this version promises (see
// replayVersion.ts).
// Still 34 after the first matchup sweep's two corrections (brain and
// playbook data only): sorties stand down once the impatience ramp is
// walking the bar — the fletcher-abbot standoff was bleeding archers
// into towers past the 120k horizon — and the fletcher's harass clock
// eased from 500 to 900, which returned the deck to a contest.
// Still 34 after oxfmt caught up with the arc's files (CI's
// format:check): whitespace and wrapping only, same statements, same
// tick. The hash is over raw bytes, which is why it moved anyway —
// the same story the "Still 33 after oxfmt" entry above tells.
// 34 also for mixed squads forming up (merged from main): a group move
// deals its spread tiles by arm now (knights front, archers rear) and
// marches at its slowest member's pace, so the same logged order stands
// the same soldiers on different tiles on a different clock (see
// replayVersion.ts). One bump for both halves — they shipped together.
// Still 34 after the pace moved to effective speeds (a booted serf counts
// as the 1.73 he walks, not his raw 1.5): the same behavior the version
// already describes, computed right — and 34 has never shipped a replay.
// Still 34 across the merge that joined the herald arc with the
// formation change: two "34 for" stories above, one version — neither
// half ever recorded a replay without the other, so there is nothing a
// 35 would tell apart (replayVersion.ts tells both stories in full).
// Still 34 after the herald case's comment learned to say where the
// wire screen actually lives (tick.ts, words only): same statements,
// same tick. The hash is over raw bytes, which is why it moved anyway.
// Still 34 after three war-behavior corrections a replayed skirmish
// surfaced (systems/ai.ts, brain only — playback never runs a brain):
// a sortie now reads the defenders' odds at launch instead of one beat
// after, the mid-march homeGuard recall wants a real force at the gates
// rather than any straggler, and a scout lost on a doorstep errand
// doubles that rival's refresh clock. The seats DECIDE differently;
// yesterday's logs hold the commands they decided then, and the tick
// that executes them did not move.
// Still 34 after that arc's review round (brain only again): the burn
// counter caps as it counts instead of at the read, and the stretch
// multiplies by a shifted small factor instead of shifting the clock —
// the same numbers for every reachable value, spelled safely.
// 35 for the sale leaving salvage on the field: the refund and the
// whole shelf are piled where the building stood (a new building type,
// id 20) and carted home by serfs instead of teleporting — retiring the
// two-good rescue set. Death drops ride the same bump: a killed serf's
// cargo and a killed worker's tool fall as salvage where he stood
// instead of dying with him. A logged sale or serf loss re-runs
// differently from that tick on (see replayVersion.ts).
// 36 for the reserve silver seam: every start on every map now has a
// second seam out past its home ring, so a generated world re-rolls
// differently from the same seed and four mission maps' tiles moved
// outright (see replayVersion.ts). The seat that opens it is brain and
// rule work, which playback never runs — the bump is the ground.
// Still 36 after the road techs (systems/ai.ts AI_HAUL): a seat hauling
// from a post out in the country now researches Cobbled Boots and then
// Masonry ahead of its printed line. Brain only — playback never runs a
// brain — so yesterday's logs play back exactly; the hash is over raw
// bytes, which is why it moved anyway.
// Still 36 after oxlint swept the tree (.oxlintrc.json): four sim files
// dropped imports nothing read (hash.ts, world.ts, systems/ai.ts,
// systems/objectives.ts) and one spread lost an empty fallback that
// never added a key. Same constants, same tables, same statements, so
// every tick runs as it did — the hash is over raw bytes, which is why
// it moved anyway.
// 37 for the hire that can be called back: a new command kind (16,
// cancelHire) refunds a queued recruit's silver and, at the head of the
// queue, hands the next man a fresh walk. A new kind is pure format — no
// older log can hold one — and the only new behavior sits behind it, so
// yesterday's logs play back exactly (see replayVersion.ts).
// Still 37 after a unit began carrying his own full health (Unit.maxHp,
// units.ts): armour research already sent a soldier out of the barracks
// above his kind's number, and the field only writes that number down so
// the published health byte can be a fraction of the right thing. He
// musters at exactly the hp he always did, nothing in a tick reads the new
// field, and the save fills it in from the kind for a file that predates
// it — so yesterday's logs play back exactly. The hash is over raw bytes,
// which is why it moved anyway. (Still 37 with the fill-in corrected to
// take what the man is carrying as its floor: armour research is older
// than the field, so an older file already holds soldiers above their
// kind's number. Load-time reading only; no tick moved.)
// 39 for the difficulty setting — and specifically for its campaign half.
// The computer seats playing harder or easier is brain only (a transform
// over composed knobs, plus a slower decision beat on easy), which moves no
// recorded tick; a commission scaling the human seat's larder, hands and
// raid clock by the tier is config the world is BUILT from, and an older
// build drops the field and rebuilds a different opening — as does the
// commission's raid pressure, which moves waves onto different ticks at a
// different size, and a seventeenth command kind (`focusTarget`) that an
// older sanitizeCommand would screen out of a log recorded here. See
// replayVersion.ts. It sits on top of main's own 38 (the seats dealt
// their start spots), which is why this is 39 and not 38.
// (Still 39 after `easy` was retuned — spears only, a
// muster bar it cannot reach, its village at the clamps — and after the
// stance cascade became tierable: all of it is brain-only, and playback
// never runs a brain. Still 39 after the beat stagger was generalized from a
// fixed 5-tick stride to slots across the interval — the same offsets, 0, 5,
// 10, 15, at the printed cadence, so a normal seat's beats did not move; and
// brains do not run in playback anyway.)
// (Still 39 after the stuck-scout fix, resiteExtractor reading its own
// condition, and the build order's gatherer reserve: systems/ai.ts and
// economyRules.ts, which is brain and rule layer — the same reasoning the
// "Still 33 after the glut-forge rule" entry above sets out. A seat now
// stops re-ordering a walk it cannot make, sells a hut standing on bare
// ground, and holds its planks for the woodcutter rather than the well;
// all three speak in commands the sim already took, and playback replays
// the logged commands rather than re-deriving them.)
// 40 for silver's evacuation tier (defs/balance.ts EVAC_PRIORITY, read
// by systems/logistics.ts): the haul board is the sim, and a serf who
// used to shoulder the oldest plank now shoulders the silver instead —
// and for the bed count learning to see a recruit inside the barracks
// (sim/population.ts), which moves the hire gate. In replayVersion.ts
// at length.
// 41 for soldiers taking up room (systems/separation.ts, a new tick
// system between movement and combat): every soldier holds every other
// soldier off, standers hold their ground and walkers go round, an enemy
// rank standing its ground is a wall the men held at it fight, and serfs
// walk through everyone. Positions are the surface — a squad on one enemy
// stands in a ring now instead of a stack, so every strike, chase and
// acquisition in a logged battle lands from different ground (see
// replayVersion.ts). It lands on top of main's 40, the silver tier, which
// is why this is 41: the two shipped in different PRs.
const EXPECTED_VERSION = 41;
const EXPECTED_HASH = 'a28ff456f91021706f2aaf813fdd68a2';

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
  [
    '/src/sim/**/*.ts',
    '/src/sim/defs/maps/*.json',
    '/src/shared/*.ts',
    '/src/app/replay.ts',
  ],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
);

/** Repo-relative and sorted, so the hash is stable across machines. */
function surface(): [string, string][] {
  return Object.entries(SOURCES)
    .map(
      ([path, raw]) =>
        [path.replace(/^\/src\//, ''), raw as string] as [string, string],
    )
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
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(joined),
  );
  return [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

describe('replay version', () => {
  it('is bumped when the compatibility surface changes', async () => {
    const actual = {version: REPLAY_VERSION, surfaceHash: await surfaceHash()};
    expect(
      actual,
      'The replay compatibility surface changed. If sim behavior or the replay format ' +
        'moved, bump REPLAY_VERSION in src/shared/replayVersion.ts; either way, pin the ' +
        `new hash in this test. Current surface hash: ${actual.surfaceHash}`,
    ).toEqual({version: EXPECTED_VERSION, surfaceHash: EXPECTED_HASH});
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
