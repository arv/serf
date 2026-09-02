import {inBounds, tileIdx, tileX, tileY} from '../../shared/grid.ts';
import {hash2} from '../../shared/math.ts';
import {UNIT_DEFS} from '../defs/units.ts';
import {findPath} from '../path.ts';
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
 * standers, split the difference.
 *
 * The one hard edge is the enemy's line. Against a standing ENEMY the hold
 * is absolute: a walker is put back outside arm's length however far his
 * stride carried him in (see holdOff), so a rank of knights standing their
 * ground is a wall the spearmen behind it are actually behind. Within a
 * side the push stays soft and capped — allies always squeeze past each
 * other in the end, so an army can never wedge itself in its own doorway,
 * which is the failure hard occupancy is famous for. Hard occupancy on a tile grid is the
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
  // Last tick's holds are over whatever happens below: combat reads
  // heldIds after this, and a stale entry would have a man fight a wall
  // that is no longer there. The one soldier left on a map has nobody to
  // be held by, so his count ends too.
  heldIds.clear();
  if (n < 2) {
    if (n === 1 && soldiers[0]!.heldTicks !== undefined)
      soldiers[0]!.heldTicks = undefined;
    return;
  }
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
  gridSize = size;
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
      // A walker against a standing enemy is holdOff's, below: no soft
      // push at all, so the two cannot add up to a shove past the line.
      if (aMoving !== bMoving && a.owner !== b.owner) continue;
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
    // A man in a crowd is pushed by everyone around him. Uncapped, the
    // middle of a mob would be flung clear of it in a tick; capped, the
    // crowd squeezes outward at a walk, which is what a crowd does.
    const m2 = px * px + py * py;
    if (m2 > MAX_PUSH_SQ) {
      const s = MAX_PUSH / Math.sqrt(m2);
      px *= s;
      py *= s;
    }
    const u = soldiers[i]!;
    if (moving[i]!) holdOff(soldiers, i, px, py);
    else {
      holdX = px;
      holdY = py;
    }
    if (heldIds.has(u.id)) {
      u.heldTicks = (u.heldTicks ?? 0) + 1;
      if (u.heldTicks >= DETOUR_AFTER) {
        detour(world, u, soldiers);
        u.heldTicks = undefined; // the count starts over on the new route
      }
    } else if (u.heldTicks !== undefined) u.heldTicks = undefined;
    if (holdX === 0 && holdY === 0) continue;
    nudge(world, u, holdX, holdY);
  }
}

/**
 * Round the wall, not through it. A walker the enemy's rank has held for
 * DETOUR_AFTER ticks running is not going to slide his way past — a rank
 * standing a tile apart wedges him in a gap he cannot fit through, his
 * stride and the hold cancelling exactly, for as long as the rank stands.
 * That is the deadlock this whole design exists to avoid, so he re-plans:
 * the same route to the same goal, with every standing enemy soldier's
 * tile taken as ground he cannot walk, which is what Warcraft's pathfinder
 * knows about everyone all the time. A rank a tile apart has no gap tile,
 * so the route goes round its end; a goal under an enemy, or a walker
 * boxed in, finds no route and keeps pressing — combat's fightTheWall has
 * him fight the man in front of him meanwhile.
 *
 * The tiles are marked on the shared blocked grid for the one search and
 * unmarked after, rather than teaching the pathfinder an occupancy layer:
 * this runs once per pinned walker per half second, not per step.
 */
function detour(world: World, u: Unit, soldiers: readonly Unit[]): void {
  const path = u.path;
  if (path === null || u.pathIdx >= path.length) return;
  const goal = path[path.length - 1]!;
  const map = world.map;
  const size = map.size;
  const blocked = map.blocked;
  const marked: number[] = [];
  for (let j = 0; j < soldiers.length; j++) {
    const s = soldiers[j]!;
    if (moving[j]! || s.owner === u.owner) continue;
    const tx = Math.floor(s.x);
    const ty = Math.floor(s.y);
    if (!inBounds(tx, ty, size)) continue;
    const t = tileIdx(tx, ty, size);
    if (!blocked[t]) {
      blocked[t] = 1;
      marked.push(t);
    }
  }
  // Search from the nearest tile nobody stands on. A wedged man is often
  // inside the wall's own tile column — a body of 0.6 reaches 0.1 past a
  // tile edge from the far side of the tile it stands on, and the corner of
  // a gap sits inside that — and a search that starts on a stander's tile
  // is already through the wall as far as the grid can see: it planned
  // straight on through the line, and he walked into it again.
  let sx = Math.floor(u.x);
  let sy = Math.floor(u.y);
  if (blocked[tileIdx(sx, sy, size)]) {
    let best = Infinity;
    const cx = sx;
    const cy = sy;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!inBounds(nx, ny, size) || blocked[tileIdx(nx, ny, size)]) continue;
        const ox = nx + 0.5 - u.x;
        const oy = ny + 0.5 - u.y;
        const d2 = ox * ox + oy * oy;
        if (d2 < best) {
          best = d2;
          sx = nx;
          sy = ny;
        }
      }
    }
    if (best === Infinity) {
      for (const t of marked) blocked[t] = 0;
      return; // boxed in on every side: keep pressing, and fighting
    }
  }
  const p = blocked[goal]
    ? null
    : findPath(map, sx, sy, tileX(goal, size), tileY(goal, size));
  for (const t of marked) blocked[t] = 0;
  if (p && p.length > 0) {
    u.path = p;
    u.pathIdx = 0;
  }
}

/**
 * The enemy's line, held. Starting from where the soft pushes leave walker
 * `i` (his position plus `px, py`), put him back outside SEPARATION of
 * every standing enemy near him, and write the total move to holdX/holdY.
 *
 * Not a push but a projection, and not capped: a stride of 0.08 into the
 * line is undone in full, every tick, so the line is a wall rather than
 * something a man grinds through at the speed difference. Several passes,
 * because being put outside one man can put you inside his neighbour — a
 * rank standing a tile apart leaves gaps of 0.4 between bodies of 0.6, and
 * a man in such a gap is inside both circles; the later passes settle him
 * back out in front, to within a hair (alternating projections converge
 * rather than land). The first pass also slides him along the line (the
 * same turn-aside as deflect, by his own lean, the ids deciding a dead-on
 * charge) so he works toward the end of it instead of standing pinned.
 *
 * Standers are read where they are now: the soft pass has not moved
 * anyone yet, and a stander is at most MAX_PUSH from where he will be
 * once it does, which the soft cap makes far too little to open a gap.
 * The sweep runs both ways from `i` with a wide margin, since the sort
 * is over pre-push x and the projection itself moves him.
 *
 * Every walker held is noted in heldIds for combat, which runs next:
 * a man walking at something behind the wall fights the wall instead.
 * The result is written to holdX/holdY (a pair of numbers per soldier
 * per tick is an allocation).
 */
function holdOff(
  soldiers: readonly Unit[],
  i: number,
  px: number,
  py: number,
): void {
  const a = soldiers[i]!;
  projX = a.x + px;
  projY = a.y + py;
  const n = soldiers.length;
  const reach = SEPARATION * 2;
  let held = false;
  for (let pass = 0; pass < HOLD_PASSES; pass++) {
    for (let j = i - 1; j >= 0 && a.x - soldiers[j]!.x < reach; j--)
      if (project(soldiers, i, j, pass === 0)) held = true;
    for (let j = i + 1; j < n && soldiers[j]!.x - a.x < reach; j++)
      if (project(soldiers, i, j, pass === 0)) held = true;
  }
  if (held) heldIds.add(a.id);
  holdX = projX - a.x;
  holdY = projY - a.y;
}

/**
 * One step of holdOff: if the running position projX/projY is inside
 * SEPARATION of soldier `other` and he is a standing enemy of `self`, move
 * it back out to the circle's edge. True when it was.
 */
function project(
  units: readonly Unit[],
  self: number,
  other: number,
  slide: boolean,
): boolean {
  const b = units[other]!;
  if (moving[other]! || b.owner === units[self]!.owner) return false;
  const dx = projX - b.x;
  const dy = projY - b.y;
  const d2 = dx * dx + dy * dy;
  if (d2 >= SEPARATION_SQ) return false;
  const selfId = units[self]!.id;
  let nx: number;
  let ny: number;
  let d: number;
  if (d2 === 0) {
    const k = ((hash2(selfId, b.id) * STACK_DIRS.length) | 0) & ~1;
    nx = STACK_DIRS[k]!;
    ny = STACK_DIRS[k + 1]!;
    d = 0;
  } else {
    d = Math.sqrt(d2);
    nx = dx / d;
    ny = dy / d;
  }
  projX = b.x + nx * SEPARATION;
  projY = b.y + ny * SEPARATION;
  if (slide) {
    // A waypoint under the man holding him off can never be consumed —
    // movement wants him within a stride of its center, and he is kept a
    // body away from it — so he aims past it at the one beyond. A route
    // whose END is under an enemy ends here: movement sees the cursor
    // past the last waypoint and finishes the walk where he stands, which
    // is beside the man he was sent at. Without this a knight ordered
    // through a lone bandit circled him for as long as he had blood to.
    const u = units[self]!;
    if (u.path !== null && u.pathIdx < u.path.length) {
      const wp = u.path[u.pathIdx]!;
      const wx = tileX(wp, gridSize) + 0.5 - b.x;
      const wy = tileY(wp, gridSize) + 0.5 - b.y;
      if (wx * wx + wy * wy < SEPARATION_SQ) u.pathIdx++;
    }
    // Slide along the line by as much as he was put back, on the side he
    // leans to — see deflect for why a walker needs somewhere to go.
    const hx = headX[self]!;
    const hy = headY[self]!;
    if (hx * nx + hy * ny < 0) {
      let tx = -ny;
      let ty = nx;
      const lean = tx * hx + ty * hy;
      if (lean < 0 || (lean === 0 && hash2(selfId, b.id) < 0.5)) {
        tx = -tx;
        ty = -ty;
      }
      projX += tx * (SEPARATION - d);
      projY += ty * (SEPARATION - d);
    }
  }
  return true;
}
let holdX = 0;
let holdY = 0;
let projX = 0;
let projY = 0;
/** The map's grid side, for reading a waypoint's tile back to a center. */
let gridSize = 0;

/** How long a walker is held at an enemy's rank before he goes round it
 * (see detour): half a second, long enough that a lone man in the road is
 * simply slid past (that takes a second and never pins) and short enough
 * that a wedged man reads as re-thinking rather than stuck. */
const DETOUR_AFTER = 10;

/** Projection rounds per held walker (see holdOff). The first pass's slides
 * can carry a man in a gap a tenth of a tile into both neighbours at once,
 * and each pass after settles him back out by about a fifth of what is left:
 * eight leave him within a millionth of a tile of both edges, for the price
 * of a few multiplies on the handful of men pinned at a wall. */
const HOLD_PASSES = 8;

/** Soldiers put back outside an enemy's arm's length this tick. */
const heldIds = new Set<number>();

/**
 * Was this soldier held off by a standing enemy this tick? Read by combat,
 * which runs right after separation: a man who cannot get past the wall
 * should fight the wall.
 */
export function heldByEnemy(id: number): boolean {
  return heldIds.has(id);
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
