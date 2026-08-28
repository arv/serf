import {inBounds, tileIdx, tileX, tileY} from '../../shared/grid.ts';
import {Rng} from '../../shared/rng.ts';
import * as UnitTypeId from '../defs/unitTypeIdEnum.ts';
import {findPath} from '../path.ts';
import * as PathLevel from '../pathLevelEnum.ts';
import * as UnitTaskKind from '../unitTaskKindEnum.ts';
import type {World} from '../world.ts';

/** How far from itself an idle serf will look for somewhere to go. */
const RANGE = 4;
/**
 * How often a serf with a lane in sight strolls along it rather than off
 * into the meadow. People walk on the road: the paths a village wears are
 * where its life happens, and a village whose idle serfs cut across the
 * grass reads as a village that ignores its own roads.
 */
const LANE_CHANCE = 0.6;

/**
 * Pick somewhere to stroll: a nearby trail or road if there is one in
 * range, otherwise any nearby tile. Roads count twice — paved lanes pull
 * harder than worn dirt. Returns the tile, or -1 if nothing suits.
 */
function strollTarget(world: World, from: number, rng: Rng): number {
  const map = world.map;
  const size = map.size;
  const ox = tileX(from, size);
  const oy = tileY(from, size);

  // Look before drawing: a serf with no lane in reach must consume no
  // randomness deciding that, or the whole sim's stream shifts the moment
  // this file exists — and saves, replays and lockstep peers all judge each
  // other by ticking identically.
  const lanes: number[] = [];
  for (let dy = -RANGE; dy <= RANGE; dy++) {
    for (let dx = -RANGE; dx <= RANGE; dx++) {
      const tx = ox + dx;
      const ty = oy + dy;
      if (!inBounds(tx, ty, size)) continue;
      const idx = tileIdx(tx, ty, size);
      if (idx === from || map.blocked[idx]) continue;
      const level = map.pathLevel[idx]!;
      if (level === PathLevel.None) continue;
      lanes.push(idx);
      if (level === PathLevel.Road) lanes.push(idx);
    }
  }
  if (lanes.length > 0 && rng.next() < LANE_CHANCE)
    return lanes[rng.int(lanes.length)]!;

  const tx = ox + rng.int(RANGE * 2 + 1) - RANGE;
  const ty = oy + rng.int(RANGE * 2 + 1) - RANGE;
  if (!inBounds(tx, ty, size) || map.blocked[tileIdx(tx, ty, size)]) return -1;
  return tileIdx(tx, ty, size);
}

/**
 * Placeholder M1 behavior: idle serfs occasionally stroll to a nearby tile.
 * Replaced by the job system in M2 (this then only fires for truly idle
 * serfs, which keeps villages feeling alive).
 */
export function wanderSystem(world: World, rng: Rng): void {
  const size = world.map.size;
  for (const unit of world.units.values()) {
    // Only truly idle, jobless serfs stroll; workers are run by production
    // and anyone with a job is owned by logistics.
    if (unit.dead || unit.kind !== UnitTypeId.serf || unit.jobId !== undefined)
      continue;
    if (unit.task.t !== UnitTaskKind.idle || world.tick < unit.task.until)
      continue;

    // Mostly loiter; occasionally stroll. Keeps villages alive, not frantic.
    if (rng.next() < 0.65) {
      unit.task = {t: UnitTaskKind.idle, until: world.tick + 40 + rng.int(80)};
      continue;
    }

    const ux = Math.floor(unit.x);
    const uy = Math.floor(unit.y);
    const target = strollTarget(world, tileIdx(ux, uy, size), rng);
    if (target < 0) {
      unit.task = {t: UnitTaskKind.idle, until: world.tick + 20 + rng.int(40)};
      continue;
    }
    // A* already charges less for trails and roads, so a serf headed for a
    // lane joins it early and follows it in rather than cutting across.
    const path = findPath(
      world.map,
      ux,
      uy,
      tileX(target, size),
      tileY(target, size),
    );
    if (path && path.length > 0) {
      unit.path = path;
      unit.pathIdx = 0;
      unit.task = {t: UnitTaskKind.move};
    } else {
      unit.task = {t: UnitTaskKind.idle, until: world.tick + 60 + rng.int(120)};
    }
  }
}
