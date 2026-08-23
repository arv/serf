import { REPAIR_MEND_TICKS } from '../defs/balance.ts';
import { buildingDef, repairBill } from '../defs/buildings.ts';
import { GOODS, type GoodId } from '../defs/goods.ts';
import { PathLevel } from '../map.ts';
import { abortJob, availableOut } from './logistics.ts';
import { consumePostTool } from './production.ts';
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
    if (!b.dead) {
      // A running repair spends anything it needs that is already inside the
      // building (see spendOwnStores) before it waits on a hauler, and the
      // masons put in a tick on whatever has been delivered (see mendRepair).
      if (b.repairNeeds) spendOwnStores(world, b);
      if (b.repairPending !== undefined) mendRepair(world, b);
    }
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
    // A tower comes up stood down — an empty roof, waiting to be manned.
    // Villagers are the whole village's hands, and a running tower would put
    // two of them on the wall the moment the masons stepped off and hold
    // them through every quiet hour after; a soldier who climbs up is two
    // hands taken off the army the same way. Manning it is a decision, so
    // the tower waits to be told, and the card says so in as many words.
    if (def.garrison) b.paused = true;
    delete b.siteNeeds;
    delete b.buildProgress;
    delete b.builderWantedSince;
    // The borrowed hammer comes back: off the site's hands and onto the
    // shelf, where evacuation hauls it home for the next site. This is
    // what makes hammers a cap on concurrent construction rather than a
    // cost — the only way to lose one is to lose the site itself.
    if ((b.inputs.hammer ?? 0) > 0) {
      b.stock.hammer = (b.stock.hammer ?? 0) + (b.inputs.hammer ?? 0);
      b.inputs.hammer = 0;
    }
    // The builder stays on as the building's worker — if the post's tool
    // is here to hand him (sites pre-order it, so it usually arrived with
    // the planks). Buildings that keep no resident (barracks, abbey), and
    // tool-gated posts whose tool is still on the road, release him back
    // to the serf pool; the post then recruits normally once equipped.
    if (b.workerId !== undefined && (def.workerKind === undefined || !consumePostTool(world, b))) {
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
 * mends as they are carried in and worked into the walls.
 *
 * A repair costs two things, and both of them are time. The haulage is the
 * first — serfs walking stone out to the wall instead of flour to the
 * bakery — and the masonry is the second: a delivered material banks the hp
 * it bought (repairPending) and the building climbs back at a fixed pace
 * from there. So a wall does not snap back to full the instant the last
 * plank lands, and a building caught mid-mend by the next wave is a wall
 * that is still half down. There is no second builder, though: the post
 * that is already there does the work.
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

/**
 * Put one tick of masonry into the walls. The pace is the building's own
 * size over REPAIR_MEND_TICKS, so mending scales with the damage: a scratch
 * is done almost at once and a near-ruin takes the full stretch. Sandbox
 * skips the wait, as it does the build timer.
 */
function mendRepair(world: World, b: Building): void {
  const def = buildingDef(b.type);
  const pending = b.repairPending!;
  const step = world.admin.instantBuild ? pending : def.hp / REPAIR_MEND_TICKS;
  const mend = Math.min(step, pending);
  b.hp = Math.min(def.hp, b.hp + mend);
  if (pending > mend) {
    b.repairPending = pending - mend;
    return;
  }
  delete b.repairPending;
  // A mend that bought the whole building back leaves float dust behind
  // (the hp went on in twentieths of a point); a building that paid for
  // every point of it should read as whole.
  if (def.hp - b.hp < 1e-6) b.hp = def.hp;
}

/** Damage nobody has paid for yet: what is broken now, less the hp a
 * running repair already bought and the masons have still to put on. */
function unpaidDamage(b: Building): number {
  return buildingDef(b.type).hp - b.hp - (b.repairPending ?? 0);
}

/** Can this building be told to mend itself right now? */
export function canRepair(b: Building): boolean {
  const def = buildingDef(b.type);
  if (b.dead || b.state !== 'built' || def.isRoad || def.systemOnly) return false;
  // A site heals as it rises (constructionSystem), a building nobody has
  // scratched has nothing to pay for, and damage a running repair has
  // already bought is waiting on the masons, not on a second order.
  return unpaidDamage(b) > 0;
}

/**
 * Place the order: the bill is struck from the damage standing now that no
 * running repair has paid for yet, and each material it names buys a fixed
 * slice of the hp back. Ordering again while a repair runs re-strikes the
 * bill against whatever has been broken since — the way to catch up on a
 * building that kept taking hits, and never a second charge for damage the
 * masons are already working on.
 */
export function orderRepair(world: World, b: Building): void {
  if (!canRepair(b)) return;
  const missing = unpaidDamage(b);
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
 * plank. Masonry already bought and paid for is finished all the same: the
 * stone is in the wall, and prising it out again would only waste it.
 *
 * Only the hauls this repair booked are stopped, which is what the
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
