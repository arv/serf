import { buildingDef } from '../defs/buildings.ts';
import { GOODS } from '../defs/goods.ts';
import { PathLevel } from '../map.ts';
import { destroyBuilding, type World } from '../world.ts';
import { tileIdx } from '../../shared/grid.ts';

/**
 * Sites whose materials are fully delivered tick a build timer, then become
 * real buildings (no builder units — Settlers-style materials + time).
 * Staffing them is the staffing system's job.
 */
export function constructionSystem(world: World): void {
  for (const b of world.buildings.values()) {
    if (b.dead || b.state !== 'site' || !b.siteNeeds || b.paused) continue;

    // Sandbox: sites need nothing and finish now (reconcile cancels any
    // in-flight material hauls via the "site no longer needs good" rule).
    if (world.admin.instantBuild) {
      b.siteNeeds = {};
      b.buildProgress = buildingDef(b.type).buildTicks;
    }

    const needsLeft = GOODS.some((g) => (b.siteNeeds![g] ?? 0) > 0);
    if (needsLeft) continue;

    const def = buildingDef(b.type);
    // Raising the frame needs hands: the staffing system's recruited
    // builder must be on site (roads pave themselves; sandbox skips).
    if (!def.isRoad && !world.admin.instantBuild) {
      const builder = b.workerId !== undefined ? world.units.get(b.workerId) : undefined;
      if (!builder || builder.dead) continue;
    }
    b.buildProgress = (b.buildProgress ?? 0) + 1;
    // The structure firms up as it rises — hp grows in step with progress
    // (an increment, so raid damage taken meanwhile is not healed).
    b.hp = Math.min(def.hp, b.hp + (def.hp * 0.85) / def.buildTicks);
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
    delete b.builderWantedSince;
    // The builder stays on as the building's worker; buildings that keep
    // no resident (barracks, abbey) release them back to the serf pool.
    if (def.workerKind === undefined && b.workerId !== undefined) {
      const builder = world.units.get(b.workerId);
      if (builder && !builder.dead) {
        builder.kind = 'serf';
        builder.homeId = undefined;
      }
      b.workerId = undefined;
    }
  }
}
