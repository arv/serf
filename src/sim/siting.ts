import type {Enum} from '../shared/enum.ts';
import {BUILDING_DEFS} from './defs/buildings.ts';
import * as BuildingTypeIdNs from './defs/buildingTypeIdEnum.ts';
import type {Owner} from './entities.ts';
import {
  anchorOf,
  nearestResourceOutside,
  nearestResourceWhere,
  type TileResourceKind,
} from './map.ts';
import * as TileResource from './tileResourceEnum.ts';
import {canPlace, type World} from './world.ts';

type BuildingTypeId = Enum<typeof BuildingTypeIdNs>;

/**
 * Nearest placeable footprint origin around a point (spiral search) that
 * also keeps a one-tile gap from every other building — packing tighter can
 * seal a neighbor's doorway and strangle its deliveries. The sim does not
 * enforce this; a careless builder can wall itself in.
 *
 * Lives here rather than in the brain because two layers site buildings
 * now: the build order placing the next step of a playbook, and the
 * economy rules opening a mine on the reserve seam before the working one
 * runs dry. Both have to spiral the same way or the same seat would pick
 * two different tiles for the same job.
 *
 * `toward` is the one thing that outranks pure nearness, and only a
 * building that fights ever passes it (systems/ai.ts `spotFor`): a wall is
 * built to stand between the village and something, and the spiral on its
 * own has no idea which side that is. It reads row by row from the
 * north-west corner of each ring, so it answered "the first legal tile"
 * — which on a packed base is whichever side of the castle happens to
 * have a gap, and a seat in the valley's south-east corner put its towers
 * on its north-west shoulder, looking at nobody, every game.
 *
 * Given a point, each ring instead yields the legal site NEAREST that
 * point, and only sites that stand nearer to it than the anchor itself
 * count as facing it at all — a ring whose gaps are all behind the castle
 * is skipped for the next one out. Rings are still walked inward-out, so
 * a facing tower is never further from home than it has to be, and a base
 * hemmed in on the threat side falls back to the plain nearest legal
 * tile, which is exactly what the search always gave.
 */
export function findSpot(
  world: World,
  type: BuildingTypeId,
  cx: number,
  cy: number,
  maxR = 14,
  toward?: {x: number; y: number} | null,
): {x: number; y: number} | null {
  const def = BUILDING_DEFS[type];
  const size = world.map.size;
  const spaced = (x: number, y: number): boolean => {
    for (let ty = y - 1; ty < y + def.h + 1; ty++) {
      for (let tx = x - 1; tx < x + def.w + 1; tx++) {
        if (tx < 0 || ty < 0 || tx >= size || ty >= size) continue;
        if (world.map.buildingAt[ty * size + tx]! >= 0) return false;
      }
    }
    return true;
  };
  // Squared, and never rooted: `-`, `*` and `+` are bit-exact on every
  // engine, where the square root's neighbours are not, and the nearer of
  // two points is the same either way (determinism.lint.test.ts, and the
  // same reasoning as `rivalGround` below).
  const toThreat = (px: number, py: number): number => {
    const dx = px - toward!.x;
    const dy = py - toward!.y;
    return dx * dx + dy * dy;
  };
  // What the anchor itself reads, and the bar a site clears to count as
  // facing the threat rather than merely standing beside it.
  const home = toward ? toThreat(cx, cy) : 0;
  let nearest: {x: number; y: number} | null = null;
  for (let r = 1; r <= maxR; r++) {
    let facing: {x: number; y: number} | null = null;
    let best = home;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (!canPlace(world.map, type, x, y) || !spaced(x, y)) continue;
        if (!toward) return {x, y};
        // Kept in case no ring ever faces the threat — this is the answer
        // the search gave before there was such a thing as facing.
        nearest ??= {x, y};
        const cost = toThreat(x + def.w / 2, y + def.h / 2);
        // Strictly nearer, so ties keep the ring's own reading order and
        // two hosts site the same tower.
        if (cost < best) {
          best = cost;
          facing = {x, y};
        }
      }
    }
    if (facing) return facing;
  }
  return nearest;
}

/**
 * Whose ground a tile is: the seats' castles split the valley between
 * them, and a tile that stands nearer a living rival's castle than this
 * seat's own is the rival's yard. Exact ties are nobody's, so ground half
 * way between two castles is open to both.
 *
 * The same partition worldgen deals the ore by (map.ts `isOwnGround`:
 * every home seam lies on the ground nearest its own start, and a reserve
 * seam a clear margin further from every rival), so a seat that keeps to
 * it is keeping to what the map dealt it, not measuring anything new. A
 * dead rival's yard is open: its castle is rubble and nothing defends the
 * seam it was dealt.
 *
 * Measured from the same anchors worldgen measures from, but as squared
 * whole distances rather than worldgen's `Math.hypot` and epsilon: the
 * nearer castle is the same either way, and whole numbers leave two hosts
 * nothing to round differently.
 */
export function rivalGround(
  world: World,
  owner: Owner,
): (x: number, y: number) => boolean {
  const home = world.starts[owner];
  if (!home) return () => false;
  const mine = anchorOf(home);
  const rivals: {x: number; y: number}[] = [];
  for (const p of world.players) {
    if (p.id === owner || !p.alive) continue;
    const start = world.starts[p.id];
    if (start) rivals.push(anchorOf(start));
  }
  if (rivals.length === 0) return () => false;
  const d2 = (a: {x: number; y: number}, x: number, y: number): number =>
    (x - a.x) * (x - a.x) + (y - a.y) * (y - a.y);
  return (x, y) => {
    const own = d2(mine, x, y);
    return rivals.some(r => d2(r, x, y) < own);
  };
}

/**
 * The nearest living rival's castle plateau, or null on a valley with
 * nobody else in it — where a seat should look when it has not yet FOUND
 * anything to look at (systems/ai.ts `facing`).
 *
 * Reads the dealt start spots, exactly as `rivalGround` above does and for
 * the same reason: the plateaus are drawn on the terrain every player is
 * shipped, so which corners are lived in is public, and only which rival
 * lives in which one has to be scouted (RivalPicture.home). A dead rival's
 * corner drops out — its castle is rubble and nothing marches out of it.
 *
 * Squared whole distances, the same as `rivalGround`, so two hosts pick
 * the same corner. Ties break on the lower seat, which is the order
 * `world.players` is walked in.
 */
export function nearestRivalStart(
  world: World,
  owner: Owner,
  cx: number,
  cy: number,
): {x: number; y: number} | null {
  let best: {x: number; y: number} | null = null;
  let bestD = Infinity;
  for (const p of world.players) {
    if (p.id === owner || !p.alive) continue;
    const start = world.starts[p.id];
    if (!start) continue;
    const a = anchorOf(start);
    const d = (a.x - cx) * (a.x - cx) + (a.y - cy) * (a.y - cy);
    if (d < bestD) {
      bestD = d;
      best = a;
    }
  }
  return best;
}

/**
 * The nearest live tile of a resource this seat may dig: `nearestResource`
 * held to the seat's own side of the valley (`rivalGround`), and outside
 * any ground its own gatherers already work (`worked`, as
 * `nearestResourceOutside` reads it).
 *
 * The line exists because of what a seat did without it. A warlord whose
 * home iron was dug out found the next nearest iron on the map — the
 * human's home seam, forty-six tiles from its own castle and five from
 * the human's guard tower — and laid a mine on it every beat for two
 * thousand ticks, forty-six foundations razed by the soldiers standing
 * beside them, and the wood, stone, tools and hands sent after each one
 * lost on the road. Nearest is not reachable when the ground between is
 * somebody else's yard.
 *
 * Gold is the one metal it does not hold back, because worldgen does not
 * either: the gold sits in the middle of the map, contested by design and
 * dealt to nobody, and on a three-seat valley the middle is nearer one
 * castle than another however it is drawn.
 */
export function nearestClaimableResource(
  world: World,
  owner: Owner,
  code: TileResourceKind,
  cx: number,
  cy: number,
  worked: readonly {x: number; y: number; radius: number}[] = [],
): number {
  if (code === TileResource.GoldDep)
    return nearestResourceOutside(world.map, code, cx, cy, worked);
  const theirs = rivalGround(world, owner);
  return nearestResourceWhere(
    world.map,
    code,
    cx,
    cy,
    (x, y) =>
      !theirs(x, y) &&
      !worked.some(
        w => Math.abs(x - w.x) <= w.radius && Math.abs(y - w.y) <= w.radius,
      ),
  );
}
