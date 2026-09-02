import {inBounds, tileIdx, tileX, tileY} from '../../shared/grid.ts';
import {hash2} from '../../shared/math.ts';
import {UNIT_DEFS} from '../defs/units.ts';
import type {Unit} from '../units.ts';
import type {World} from '../world.ts';

/**
 * Soldiers take up room; serfs do not.
 *
 * The Warcraft rule: an army cannot stand on one tile. Every soldier on the
 * map — yours, a rival's, a bandit's — holds every other soldier off at arm's
 * length, so a squad that converges on one target fans out into a ring
 * around it instead of piling onto the first point within reach. Civilians
 * are exempt both ways: a hauler walks through a parade and a parade walks
 * through a hauler, because the economy's errands must never jam behind a
 * crowd, and a serf standing in a doorway must never hold up an army.
 *
 * It is a soft push rather than a hard block. Tiles are not claimed: two
 * soldiers closer than SEPARATION are moved the shortfall apart, and that
 * is all. Who moves follows the Warcraft rule too — a man standing his
 * ground is not budged by one walking into him; the walker is held back and
 * turned aside, so he goes round (see deflect). Two walkers, or two
 * standers, split the difference. Hard occupancy on a tile grid is the
 * classic way to deadlock a column in a doorway (the front man waits for
 * the man in front of him, who waits for the man in front of him), and it
 * needs the pathfinder to know where everyone is standing this tick.
 * Pushing needs neither: a marching column stretches out, a mob relaxes
 * into a ring over a few ticks, and nothing ever waits on anything — a
 * walker with nowhere to go round still works his way through, slowly,
 * because the push is capped under his stride. Movement then walks every
 * unit toward its next waypoint from wherever it was pushed to, so a route
 * is never lost — only the stride is bent.
 *
 * Runs after movement and before combat, so combat reads the positions
 * everybody will actually be standing at this tick. Pushes are computed
 * from the tick's post-movement positions and applied together (Jacobi
 * rather than in place) so the result does not depend on who happened to be
 * looked at first; the pair order is nonetheless fixed — by x, then id — so
 * the arithmetic is bit-identical run to run, which save/load and the AI
 * regression tests both count on.
 */
export function separationSystem(world: World): void {
  const soldiers: Unit[] = [];
  for (const u of world.units.values()) {
    if (u.dead || !UNIT_DEFS[u.kind].combat) continue;
    soldiers.push(u);
  }
  const n = soldiers.length;
  if (n < 2) return;
  // Sort-and-sweep along x: a pair further apart in x alone than
  // SEPARATION cannot be within it, so the inner loop stops at the first
  // such neighbor. Ties broken by id so the order is a function of the
  // world, never of Map insertion history.
  soldiers.sort((a, b) => a.x - b.x || a.id - b.id);
  if (pushX.length < n) {
    pushX = new Float64Array(n * 2);
    pushY = new Float64Array(n * 2);
    headX = new Float64Array(n * 2);
    headY = new Float64Array(n * 2);
    moving = new Uint8Array(n * 2);
  } else {
    pushX.fill(0, 0, n);
    pushY.fill(0, 0, n);
  }
  const size = world.map.size;
  for (let i = 0; i < n; i++) {
    const u = soldiers[i]!;
    headX[i] = 0;
    headY[i] = 0;
    moving[i] = 0;
    if (u.path === null || u.pathIdx >= u.path.length) continue;
    moving[i] = 1;
    const wp = u.path[u.pathIdx]!;
    const dx = tileX(wp, size) + 0.5 - u.x;
    const dy = tileY(wp, size) + 0.5 - u.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 0) {
      headX[i] = dx / d;
      headY[i] = dy / d;
    }
  }

  for (let i = 0; i < n; i++) {
    const a = soldiers[i]!;
    for (let j = i + 1; j < n; j++) {
      const b = soldiers[j]!;
      const dx = b.x - a.x;
      if (dx >= SEPARATION) break;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= SEPARATION_SQ) continue;
      // The line from a to b, and how far short of SEPARATION they stand.
      let nx: number;
      let ny: number;
      let short: number;
      if (d2 === 0) {
        // Exactly stacked — fresh recruits at the same door, or a stack an
        // earlier build saved. There is no line between them to push along,
        // so pick one from the pair's ids (a is the lower id, by the sort):
        // stable across ticks, so the two keep parting the same way
        // instead of dithering.
        const k = ((hash2(a.id, b.id) * STACK_DIRS.length) | 0) & ~1;
        nx = STACK_DIRS[k]!;
        ny = STACK_DIRS[k + 1]!;
        short = SEPARATION;
      } else {
        const d = Math.sqrt(d2); // IEEE-exact, unlike hypot (see math.ts)
        nx = dx / d;
        ny = dy / d;
        short = SEPARATION - d;
      }
      // Who gives way. A man standing his ground is not moved by a man
      // walking into him — the walker goes round, the way a column parts
      // around a sentry rather than carrying him off with it. Two walkers,
      // or two standers, split the difference.
      const aMoving = moving[i]!;
      const bMoving = moving[j]!;
      const wa = aMoving === bMoving ? 0.5 : aMoving ? 1 : 0;
      const wb = 1 - wa;
      if (wa > 0) {
        deflect(-nx, -ny, i, a.id, b.id);
        pushX[i] = pushX[i]! + defX * short * wa;
        pushY[i] = pushY[i]! + defY * short * wa;
      }
      if (wb > 0) {
        deflect(nx, ny, j, b.id, a.id);
        pushX[j] = pushX[j]! + defX * short * wb;
        pushY[j] = pushY[j]! + defY * short * wb;
      }
    }
  }

  for (let i = 0; i < n; i++) {
    let px = pushX[i]!;
    let py = pushY[i]!;
    if (px === 0 && py === 0) continue;
    // A man in a crowd is pushed by everyone around him. Uncapped, the
    // middle of a mob would be flung clear of it in a tick; capped, the
    // crowd squeezes outward at a walk, which is what a crowd does.
    const m2 = px * px + py * py;
    if (m2 > MAX_PUSH_SQ) {
      const s = MAX_PUSH / Math.sqrt(m2);
      px *= s;
      py *= s;
    }
    nudge(world, soldiers[i]!, px, py);
  }
}

/**
 * The direction soldier `i` is pushed, given `ax, ay` — the unit vector
 * away from the man he is too close to. Written to defX/defY rather than
 * returned: this runs per pair, and a pair of numbers is an allocation.
 *
 * A walker heading into someone is turned aside as well as held back. A
 * push straight back along his own stride only cancels part of it — he
 * would grind forward through the other man a fraction of a tile a tick,
 * and a column that bunched up on a road (where everyone is on exactly one
 * line, so nothing ever pushes anyone sideways) would arrive as the stack
 * it left as. Bending the push halfway to the side gives the stride
 * somewhere to go: he slips past on the side he was already leaning to,
 * and a squad closing on one enemy down one road fans out round it.
 * Straight on, with no lean at all, the side comes from the pair's ids.
 */
function deflect(
  ax: number,
  ay: number,
  i: number,
  selfId: number,
  otherId: number,
): void {
  const hx = headX[i]!;
  const hy = headY[i]!;
  if (hx * ax + hy * ay >= 0) {
    // Standing, or already walking away from him: pushed straight off.
    defX = ax;
    defY = ay;
    return;
  }
  let tx = -ay;
  let ty = ax;
  const lean = tx * hx + ty * hy;
  if (lean < 0 || (lean === 0 && hash2(selfId, otherId) < 0.5)) {
    tx = -tx;
    ty = -ty;
  }
  defX = (ax + tx) * Math.SQRT1_2;
  defY = (ay + ty) * Math.SQRT1_2;
}
let defX = 0;
let defY = 0;

/**
 * Move a soldier by a push, but never onto ground he could not walk to. A
 * push that would land in a wall, a building or the water is tried along
 * each axis alone — sliding along the obstacle rather than into it — and
 * dropped when neither is open. Pathing already keeps every unit off
 * blocked tiles; this keeps a shove from undoing that.
 */
function nudge(world: World, unit: Unit, px: number, py: number): void {
  const map = world.map;
  const size = map.size;
  const x = unit.x;
  const y = unit.y;
  if (open(map.blocked, size, x + px, y + py)) {
    unit.x = x + px;
    unit.y = y + py;
  } else if (px !== 0 && open(map.blocked, size, x + px, y)) {
    unit.x = x + px;
  } else if (py !== 0 && open(map.blocked, size, x, y + py)) {
    unit.y = y + py;
  }
}

function open(
  blocked: Uint8Array,
  size: number,
  x: number,
  y: number,
): boolean {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  return inBounds(tx, ty, size) && !blocked[tileIdx(tx, ty, size)];
}

/**
 * How close two soldiers may stand, center to center, in tiles. A body is
 * about a third of a tile wide (the renderer's TARGET_HEIGHT scaled to a
 * shoulder), so this is a body and a gap: soldiers stand shoulder to
 * shoulder rather than inside one another, and a melee ring of a dozen
 * still fits inside a knight's 1.3-tile reach. Under 1, so the tiles a
 * formation order deals out — never closer than a tile apart — are left
 * exactly as dealt.
 */
export const SEPARATION = 0.6;
const SEPARATION_SQ = SEPARATION * SEPARATION;

/**
 * The most a soldier is shoved per tick, in tiles. Slower than the slowest
 * walk (1.4 tiles/sec is 0.07 a tick), so being pushed never outpaces
 * marching and two men on one spot take a few ticks to part rather than
 * springing away from each other.
 */
const MAX_PUSH = 0.06;
const MAX_PUSH_SQ = MAX_PUSH * MAX_PUSH;

/**
 * Eight unit directions for parting an exactly stacked pair, as x,y pairs
 * (so an index into it is rounded down to even before use). A table
 * because the sim may not call Math.sin/cos (see determinism.lint.test.ts):
 * those are engine-approximated, and these are the same bits everywhere.
 */
const STACK_DIRS: readonly number[] = [
  1,
  0,
  Math.SQRT1_2,
  Math.SQRT1_2,
  0,
  1,
  -Math.SQRT1_2,
  Math.SQRT1_2,
  -1,
  0,
  -Math.SQRT1_2,
  -Math.SQRT1_2,
  0,
  -1,
  Math.SQRT1_2,
  -Math.SQRT1_2,
];

/** Per-tick scratch, in sweep order: the push each soldier has coming,
 * whether he is walking, and which way. Grown on demand, never shrunk; the
 * sim ticks one world at a time (the same contract path.ts states for its
 * A* scratch). */
let pushX = new Float64Array(64);
let pushY = new Float64Array(64);
let headX = new Float64Array(64);
let headY = new Float64Array(64);
let moving = new Uint8Array(64);
