import {tileCount, tileIdx, tileX, tileY} from '../../shared/grid.ts';
import {iceBears} from '../defs/balance.ts';
import {inPlayArea} from '../map.ts';
import {nearestWalkable} from '../path.ts';
import * as Terrain from '../terrainEnum.ts';
import type {World} from '../world.ts';
import {routeAround} from './movement.ts';

/** How far a man caught on the ice is looked for a shore, in tiles. */
const RESCUE_REACH = 24;

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
  const bears = iceBears(world.tick);
  if (map.ice && map.iceBears === bears) return;

  // Only a lake that was bearing can strand anyone. A world's first tick
  // builds the grid from nothing, and whoever stands on water then was put
  // there by hand.
  const thawed = map.iceBears === true && !bears;
  const size = map.size;
  const ice = (map.ice ??= new Uint8Array(tileCount(size)));
  map.iceBears = bears;
  for (let i = 0; i < ice.length; i++) {
    ice[i] =
      bears &&
      map.terrain[i] === Terrain.Water &&
      map.buildingAt[i]! < 0 &&
      inPlayArea(map, tileX(i, size), tileY(i, size))
        ? 1
        : 0;
  }
  if (!thawed) return;

  for (const unit of world.units.values()) {
    if (unit.dead) continue;
    const tx = Math.floor(unit.x);
    const ty = Math.floor(unit.y);
    if (map.terrain[tileIdx(tx, ty, size)] !== Terrain.Water) continue;
    const shore = nearestWalkable(map, tx, ty, RESCUE_REACH);
    if (shore < 0) continue;
    unit.x = tileX(shore, size) + 0.5;
    unit.y = tileY(shore, size) + 0.5;
    unit.lastTile = shore;
    if (unit.path) routeAround(world, unit, unit.path[unit.path.length - 1]!);
  }
}
