import { buildingDef } from '../defs/buildings';
import { GOODS } from '../defs/goods';
import { PathLevel } from '../map';
import { destroyBuilding, type World } from '../world';
import { tileIdx } from '../../shared/grid';

/**
 * Sites whose materials are fully delivered tick a build timer, then become
 * real buildings (no builder units — Settlers-style materials + time).
 * Staffing them is the staffing system's job.
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
    // No free workers: the staffing system recruits an idle serf who walks
    // over and takes the post (the population economy).
  }
}
