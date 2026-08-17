import { buildingDef, repairBill } from '../defs/buildings.ts';
import { GOODS, type GoodId } from '../defs/goods.ts';
import { PathLevel } from '../map.ts';
import { abortJob, availableOut } from './logistics.ts';
import {
  applyRepairMaterial,
  clearRepairOrder,
  destroyBuilding,
  type World,
} from '../world.ts';
import { tileIdx } from '../../shared/grid.ts';
import type { Building } from '../entities.ts';

/**
 * Sites whose materials are fully delivered tick a build timer, then become
 * real buildings (no builder units — Settlers-style materials + time).
 * Staffing them is the staffing system's job.
 */
export function constructionSystem(world: World): void {
  for (const b of world.buildings.values()) {
    // A running repair spends anything it needs that is already inside the
    // building (see spendOwnStores) before it waits on a hauler.
    if (!b.dead && b.repairNeeds) spendOwnStores(world, b);
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
      world.map.pathLevel[tileIdx(b.x, b.y, world.map.size)] = PathLevel.Road;
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

// --- Repairs ---------------------------------------------------------------

/**
 * Repairing is construction's short form: a standing building with battle
 * damage is ordered to mend, calls for materials the way a site does, and
 * heals as each one is carried in (logistics' deliver does the nailing).
 *
 * There is no repair timer and no second builder, on purpose. What a repair
 * actually costs a player is haulage — serfs walking stone out to the wall
 * instead of flour to the bakery — and that cost is already paid by the
 * hauls themselves. Adding a clock on top would only make the pace harder
 * to read without asking anything more of them.
 */

/**
 * Materials a repair needs and the building already holds go straight into
 * the wall — nobody carries a plank out of the castle's door to hand it back
 * in through the same door. Without this the keep, whose stores *are* the
 * village's stores, could never be mended at all: a haul needs a source
 * building that isn't the destination, and there is only one storehouse.
 *
 * Only unreserved stock is taken. What another haul has already booked is
 * spoken for, and spending it here would leave a serf arriving at an empty
 * shelf with a reservation that no longer matches anything.
 */
function spendOwnStores(world: World, b: Building): void {
  for (const good of GOODS) {
    // applyRepairMaterial drops repairNeeds when the bill is settled, so
    // the loop re-reads it every pass rather than caching what it owes.
    while ((b.repairNeeds?.[good] ?? 0) > 0 && availableOut(b, good) > 0) {
      b.stock[good] = (b.stock[good] ?? 0) - 1;
      applyRepairMaterial(world, b, good);
    }
  }
}

/** Can this building be told to mend itself right now? */
export function canRepair(b: Building): boolean {
  const def = buildingDef(b.type);
  if (b.dead || b.state !== 'built' || def.isRoad || def.systemOnly) return false;
  // A site heals as it rises (constructionSystem), and a building nobody has
  // scratched has nothing to pay for.
  return b.hp < def.hp;
}

/**
 * Place the order: the bill is struck from the damage standing now, and each
 * material it names buys a fixed slice of the hp back. Ordering again while
 * a repair runs re-strikes the bill against the damage as it stands then —
 * the way to catch up on a building that kept taking hits.
 */
export function orderRepair(world: World, b: Building): void {
  if (!canRepair(b)) return;
  const def = buildingDef(b.type);
  const missing = def.hp - b.hp;
  const bill = repairBill(b.type, missing);
  const total = GOODS.reduce((n, g) => n + (bill[g] ?? 0), 0);
  if (total === 0) return; // a building that costs nothing to mend (roads)
  cancelRepair(world, b); // an outstanding bill is replaced, not added to
  b.repairNeeds = bill;
  b.repairHpPerGood = missing / total;
  // Orders land at the top of the tick, before the matcher runs: settling
  // what the building already holds here means the hauls it calls for are
  // only ever for what it is actually short of.
  spendOwnStores(world, b);
}

/**
 * Call the repair off (or clear a finished one). Materials still walking
 * toward it stand down — the good stays in the serf's hands and logistics
 * finds it another home, since a cancelled order is no reason to burn a
 * plank. Only the hauls this repair booked are stopped, which is what the
 * mark on the job is for: a weaponsmith mends with the same wood it forges
 * from, and by the time a plank is on the road nothing else distinguishes
 * the errand it was sent on.
 */
export function cancelRepair(world: World, b: Building): void {
  const needs = b.repairNeeds;
  if (!needs) return;
  clearRepairOrder(b, Object.keys(needs) as GoodId[]);
  for (const job of world.jobs.values()) {
    if (job.repair && job.to === b.id) abortJob(world, job, 'repair called off', true);
  }
}
