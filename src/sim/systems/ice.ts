import {tileIdx, tileX, tileY} from '../../shared/grid.ts';
import {iceBears} from '../defs/balance.ts';
import {isLake, layIce} from '../ice.ts';
import {nearestWalkable} from '../path.ts';
import type {World} from '../world.ts';
import {routeAround} from './movement.ts';

/**
 * PROTOTYPE: the lakes freeze and open with the year.
 *
 * While the ice bears (defs/balance.ts), every water tile of the play
 * square is ground to the pathfinder, so a haul, a march or a raid takes
 * the lake if the lake is the short way. When it stops bearing, whoever is
 * still out there is stood on the nearest shore and sent on from it. That
 * is a rescue rather than a rule — nobody drowns in this version, and the
 * few seconds the ice holds into the thaw are there so it is rarely used.
 */
export function iceSystem(world: World): void {
  const map = world.map;
  if (!layIce(map, world.tick)) return;
  // The thaw is read off the tick, never off what this map remembers: the
  // grid is not saved or copied, so a world that was loaded or cloned a
  // tick ago remembers nothing, and it has to pull the same men out of the
  // same water as the world it was taken from.
  if (world.tick === 0 || iceBears(world.tick) || !iceBears(world.tick - 1))
    return;

  const size = map.size;
  for (const unit of world.units.values()) {
    if (unit.dead) continue;
    const tx = Math.floor(unit.x);
    const ty = Math.floor(unit.y);
    // Only off what was ice a tick ago: water under a building never was.
    if (!isLake(map, tileIdx(tx, ty, size))) continue;
    // As far as it takes: left where he is he could never walk again.
    const shore = nearestWalkable(map, tx, ty, size);
    if (shore < 0) continue;
    unit.x = tileX(shore, size) + 0.5;
    unit.y = tileY(shore, size) + 0.5;
    unit.lastTile = shore;
    if (unit.path) routeAround(world, unit, unit.path[unit.path.length - 1]!);
  }
}
