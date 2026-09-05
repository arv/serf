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
// Still 49 after the Mason: a fifth playbook, an economy rule that stands a
// full garrison's barracks down, and a build-order anchor that counts spoil.
// Playbook data and the rule layer that reads it are brain-side, and
// playback never runs a brain — a replay stores the seats' commands rather
// than re-deriving them (app/replay.ts), so a seat that would decide
// differently today replays as it decided then. The same reasoning the
// "Still 32 after the Warlord's gold line" and "Still 33 after the stance
// engine" entries below record. `nearestSeamGround` is in map.ts and so
// hashes with the sim, but nothing in a tick calls it: the build order does,
// once a beat, and the build order is the brain.
// Still 49 after the worked-out gold seam (TileResource.GoldSpoil): a byte
// in map.resource no earlier build ever wrote, which is format as much as
// behavior — but 49 is this build's own bump and has never shipped, so
// again there is nothing older to break.
// Still 49 after the mission checklist latches before either win is
// declared (systems/victory.ts): 49 is this build's own bump and has
// never shipped, so there is nothing older to break. The change is real
// sim behavior all the same — a commission that asks for a Monument now
// ends with its last line ticked instead of unticked, because the
// monument win used to return before the latch ran.
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
// 42 for the haul tiers becoming shares of the hands (defs/balance.ts
// HAUL_SHARE, read by dispatch in systems/logistics.ts): which serf takes
// which errand is the sim, and lower priority now means less often rather
// than never. In replayVersion.ts at length.
// Still 42 after the seats learned whose ground a seam is (sim/siting.ts
// rivalGround, nearestClaimableResource) and to keep off ground their own
// foundations were just razed on (systems/ai.ts AI_SITING): brain and
// rule work, which playback never runs — a seat that now refuses to dig
// in a rival's yard replays as it dug. economyRules.ts, siting.ts and
// map.ts (an export and a shared scan, no draw moved) are on the surface
// for the sim they are, so the hash moved anyway.
// 43 for the reserve iron seam (map.ts IRON_RESERVE_WORTH): every start
// on every generated map now has a second iron seam out past its home
// ring. Drawn last, so the valley lies as it did — but the ore is there,
// and a replay's mines go looking for it (see replayVersion.ts). The seats
// keeping to their own side of the valley, and off ground their
// foundations were razed on, is brain and rule work playback never runs.
// Still 43 after the wiped march (systems/ai.ts `wipedMarch`,
// Difficulty.remembersWipes): a seat that lost every man of a march
// wants more than that many before it marches on the same castle again.
// Brain and tier-table work, which playback never runs — the logged
// marches re-run as they were marched. Both files are under src/sim, so
// the hash moved anyway.
// Still 43 after the flanking march (systems/ai.ts `flankMarch`,
// Difficulty.flanksTowers): a hard seat plans its own road round the
// towers it knows of and walks it in legs. Brain and tier-table work,
// playback never runs a brain — the legs it logged re-run as legs.
// 44 for holding ground: an eighteenth command kind (`holdGround`) that an
// older sanitizeCommand would screen out of a log recorded here, so the
// squad it stopped keeps marching there — the focusTarget reasoning under
// 39. The stance itself (UnitTaskKind.hold, systems/combat.ts holdGround)
// is a branch no older log can reach. On top of main's 43, the reserve
// iron seam, which is why this is 44 and not 43. In replayVersion.ts at
// length.
// 45 for the Shift-click route: a `queue` flag on the move command and a
// per-unit waypoint list behind it (Unit.orders, tick.ts waypointSystem).
// A new field on the wire is pure format — no older log holds one, and a
// log without one plays back exactly (see replayVersion.ts). On top of
// main's 44, which is why this is 45.
// 46 for the patrol: a `patrol` flag on the move command and on a
// waypoint, which comes round again once taken instead of being spent
// (tick.ts takeLeg). A log that names it plays a single attack-move on
// any build that screens the flag off (see replayVersion.ts).
// Still 46 after the towers learned which way to look (sim/siting.ts
// findSpot `toward`, `nearestRivalStart`; systems/ai.ts `facing`): a seat
// sites a building that fights on the side of its castle the nearest
// stronghold it has found is on. Brain and siting work, which playback
// never runs — a log's towers were placed by command and re-run where
// they were placed. siting.ts is on the surface for the sim it is, so the
// hash moved anyway.
// 47 for seams a player can find (map.ts): a home seam is drawn from a
// center with a clearing around it, and no seam settles for a stub while
// the band still holds a center that can take a whole one. Ore lies on
// different tiles on every generated seed and the rejected centers re-roll
// what is drawn after them, so a replay recorded before this re-runs in a
// different valley (see replayVersion.ts).
// Still 47 after seamFor's comment learned to say that a later pass stops
// at the first center that clears the bar (map.ts, words only): same
// statements, same draws, same valley. The hash is over raw bytes, which
// is why it moved anyway.
// Still 47 after the seam budget's check moved to seamRoom (map.ts): the
// same throw on the same inputs, one function earlier, where the center
// weighing also passes through it. No draw and no tile moved; the hash is
// over raw bytes.
// Still 47 after placeSeam's narrative moved back above placeSeam, where
// extracting seamRoom had left it stranded a function early (map.ts,
// comment placement only). Same statements, same draws, same valleys.
// Still 47 after canPlace grew a reason (world.ts, placementRefusal): the
// rules and their order are untouched — each refusal that returned false
// now returns the name of the rule that fired, and canPlace is that
// function asked whether the name is null. Every site legal yesterday is
// legal today, so a log's placements re-run tile for tile.
// 48 for the miners' ration: a gather recipe may now carry one (defs/
// buildings.ts), the three mines do, production charges it and logistics
// hauls it (systems/), and a mine with an empty pantry stops. That is
// sim behavior in the plainest sense — the same commands on the same
// ground produce a different valley — so the version moves with the hash.
// Still 48 after the four playbooks stopped gating the mill and the bakery
// behind the barracks (defs/aiStrategies.ts): playbook data, and playback
// never runs a brain — a replay stores the seats' commands rather than
// re-deriving them (app/replay.ts), so a seat that would build in a
// different order today replays as it built then. The hash is over raw
// bytes, which is why it moved anyway.
// Still 48 after the opening peace stretched 540s -> 610s (defs/balance.ts
// FIRST_RAID_TICK): the first wave spawns on a different tick, which is
// sim behavior of the plainest kind — but it ships in the same unreleased
// build as the ration that made it necessary, and one build is one
// version. There is no build in the wild that has the ration and the old
// clock, so there is nothing for a 49 to tell apart.
// Still 48 after RATION_STOCK's comment stopped calling the pantry a shelf
// (defs/balance.ts, words only): a shelf is `stock` everywhere else in the
// sim, and the loaves were never there. Same bytes hashed, same behavior.
// Still 48 after the second half of that same correction (systems/
// logistics.ts) and after FIRST_RAID_TICK's note said which side of the
// stretch its 13.4% was measured on. Comments both times.
// Still 48 after rationLeft's doc stopped saying a meal tops the counter
// up to `per` (sim/entities.ts): chargeRation sets `per - 1`, because the
// load that found the pantry empty is the first of the `per` its loaf
// buys. Words; the counter always did this.
// 49 for the Monument: a building type, a placement rule keyed on the gold
// seam, a hold clock in the victory system, and a reveal that puts a
// finished one on every rival's map. The last two are the sharp end — a
// match can now end on a tick and for a reason no earlier build had, and
// the AI's target picture reads the explored grid the reveal writes to, so
// a replay recorded before this diverges in outcome and not just in scenery.
// Still 49 after the Monument's win moved from holding it to finishing it,
// and its reveal from completion to the site's first delivery (systems/
// victory.ts, visibility.ts, defs/balance.ts, entities.ts). Both are sim
// behavior of the plainest kind — a different tick ends the match, and a
// different tick tells rivals where to march — but they ship in the same
// unreleased build as the Monument itself, so there is no build in the wild
// holding the old rule for a 50 to tell apart.
// Still 49 after `holdsGround` (systems/ai.ts, defs/aiStrategies.ts): a seat
// that sets it never marches, which changes what the brain decides — but no
// shipped playbook sets it, so every dealt seat plays exactly as it did.
const EXPECTED_VERSION = 49;
const EXPECTED_HASH = '10d6fc0fbc6445e92470d27d18153157';

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
