import type {Enum} from '../shared/enum.ts';
import {BUILDING_DEFS} from './defs/buildings.ts';
import * as BuildingTypeIdNs from './defs/buildingTypeIdEnum.ts';
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
 */
export function findSpot(
  world: World,
  type: BuildingTypeId,
  cx: number,
  cy: number,
  maxR = 14,
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
  for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (canPlace(world.map, type, x, y) && spaced(x, y)) return {x, y};
      }
    }
  }
  return null;
}
