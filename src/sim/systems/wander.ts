import { Rng } from '../../shared/rng.ts';
import { inBounds, tileIdx } from '../../shared/grid.ts';
import { findPath } from '../path.ts';
import type { World } from '../world.ts';

/**
 * Placeholder M1 behavior: idle serfs occasionally stroll to a nearby tile.
 * Replaced by the job system in M2 (this then only fires for truly idle
 * serfs, which keeps villages feeling alive).
 */
export function wanderSystem(world: World, rng: Rng): void {
  for (const unit of world.units.values()) {
    // Only truly idle, jobless serfs stroll; workers are run by production
    // and anyone with a job is owned by logistics.
    if (unit.dead || unit.kind !== 'serf' || unit.jobId !== undefined) continue;
    if (unit.task.t !== 'idle' || world.tick < unit.task.until) continue;

    // Mostly loiter; occasionally stroll. Keeps villages alive, not frantic.
    if (rng.next() < 0.65) {
      unit.task = { t: 'idle', until: world.tick + 40 + rng.int(80) };
      continue;
    }

    const tx = Math.floor(unit.x) + rng.int(9) - 4;
    const ty = Math.floor(unit.y) + rng.int(9) - 4;
    if (!inBounds(tx, ty) || world.map.blocked[tileIdx(tx, ty)]) {
      unit.task = { t: 'idle', until: world.tick + 20 + rng.int(40) };
      continue;
    }
    const path = findPath(world.map, Math.floor(unit.x), Math.floor(unit.y), tx, ty);
    if (path && path.length > 0) {
      unit.path = path;
      unit.pathIdx = 0;
      unit.task = { t: 'move' };
    } else {
      unit.task = { t: 'idle', until: world.tick + 60 + rng.int(120) };
    }
  }
}
