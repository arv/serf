import { buildingDef } from '../defs/buildings';
import { GOODS } from '../defs/goods';
import { PathLevel } from '../map';
import { destroyBuilding, spawnUnit, type World } from '../world';
import { bindWorker } from './production';
import { findStorehouse } from './logistics';
import { nearestWalkable } from '../path';
import { tileIdx, tileX, tileY } from '../../shared/grid';
import { centerOf } from '../entities';

/**
 * Sites whose materials are fully delivered tick a build timer, then become
 * real buildings (no builder units — Settlers-style materials + time). A
 * completed producer spawns its resident worker at the door.
 */
export function constructionSystem(world: World): void {
  for (const b of world.buildings.values()) {
    if (b.dead || b.state !== 'site' || !b.siteNeeds) continue;

    // Sandbox: sites need nothing and finish now (reconcile cancels any
    // in-flight material hauls via the "site no longer needs good" rule).
    if (world.admin.instantBuild) {
      b.siteNeeds = {};
      b.buildProgress = buildingDef(b.type).buildTicks;
    }

    const needsLeft = GOODS.some((g) => (b.siteNeeds![g] ?? 0) > 0);
    if (needsLeft) continue;

    const def = buildingDef(b.type);
    b.buildProgress = (b.buildProgress ?? 0) + 1;
    if (b.buildProgress < def.buildTicks) continue;

    if (def.isRoad) {
      // Road "sites" don't become buildings — they pave their tile and vanish.
      world.map.pathLevel[tileIdx(b.x, b.y)] = PathLevel.Road;
      destroyBuilding(world, b);
      continue;
    }

    b.state = 'built';
    b.hp = def.hp;
    delete b.siteNeeds;
    delete b.buildProgress;

    if (def.workerKind) {
      const door = doorTile(world, b.x, b.y, b.w, b.h);
      const worker = spawnUnit(world, def.workerKind, b.owner, door.x + 0.5, door.y + 0.5);
      bindWorker(b, worker);
    }
  }
}

function doorTile(
  world: World,
  x: number,
  y: number,
  w: number,
  h: number,
): { x: number; y: number } {
  // Prefer the tile south of the footprint center; fall back to any walkable
  // tile near the building, then to the storehouse door as a last resort.
  const idx = nearestWalkable(world.map, Math.floor(x + w / 2), y + h, 6);
  if (idx >= 0) return { x: tileX(idx), y: tileY(idx) };
  const sh = findStorehouse(world);
  if (sh) {
    const c = centerOf(sh);
    return { x: Math.floor(c.x), y: sh.y + sh.h };
  }
  return { x, y };
}
