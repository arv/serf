import {tileIdx} from '../../shared/grid.ts';
import * as BuildingState from '../buildingStateEnum.ts';
import {REPAIR_MEND_TICKS} from '../defs/balance.ts';
import {buildingDef, repairBill, type BuildingDef} from '../defs/buildings.ts';
import * as GoodId from '../defs/goodIdEnum.ts';
import {GOODS, goodKeys} from '../defs/goods.ts';
import * as UnitTypeId from '../defs/unitTypeIdEnum.ts';
import type {Building} from '../entities.ts';
import * as PathLevel from '../pathLevelEnum.ts';
import {
  applyRepairMaterial,
  clearRepairOrder,
  destroyBuilding,
  type World,
} from '../world.ts';
import {abortJob, availableOut} from './logistics.ts';
import {consumePostTool} from './production.ts';

/**
 * Sites rise as they are paid for, then become real buildings (no builder
 * units of their own — Settlers-style materials + time). Staffing them is
 * the staffing system's job.
 *
 * A site may be raised as far as its bill has been settled: two thirds of
 * the planks delivered buys two thirds of the frame, and the last tick of
 * work waits on the last plank. It used to be all or nothing — not one tick
 * of progress until every good had landed — which made a big building a long
 * silence followed by a sudden roof, and made the Monument in particular
 * (sixty-odd goods hauled to the middle of the map) look broken while it was
 * working perfectly.
 *
 * The hammer is a precondition rather than a share of the bill. It is a
 * loan, not a cost — borrowed at placement and handed back at completion
 * (placeSite, and the return below) — so it is the builder's tool, not part
 * of what the building is made of, and no frame rises without one.
 *
 * Completion still needs the whole bill: a paid share of 1 is the only thing
 * that lifts the cap to `buildTicks`. Nothing is bought cheaper this way,
 * and nothing is banked either — a site that falls still loses everything,
 * which is what keeps a half-built Monument worth marching on.
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
    if (b.dead || b.state !== BuildingState.site || !b.siteNeeds || b.paused)
      continue;

    // Sandbox: sites need nothing and finish now (reconcile cancels any
    // in-flight material hauls via the "site no longer needs good" rule).
    if (world.admin.instantBuild) {
      b.siteNeeds = {};
      b.buildProgress = buildingDef(b.type).buildTicks;
    }

    const def = buildingDef(b.type);
    // A frame already at its full height is only waiting to be topped out,
    // and nothing below may stand in the way of that — the sandbox sets the
    // progress outright rather than working up to it, so a gate that read
    // "no more work to do here" would hold an instant build open forever.
    if ((b.buildProgress ?? 0) < def.buildTicks) {
      // How far this frame has been paid up to. Only the sandbox is exempt:
      // it pays nothing for anything and is capped at the full height.
      //
      // A road is NOT exempt, and the exemption it briefly had here was a
      // bug: a road site costs a stone (defs/buildings.ts) and the rule this
      // replaced made it wait for that stone like everything else, so
      // shortcutting roads to full height paved them for free — and
      // cancelled the stone already on its way, since a finished site's
      // hauls are reconciled away. What roads skip is the BUILDER below,
      // not the bill.
      const cap = world.admin.instantBuild
        ? def.buildTicks
        : paidBuildTicks(b, def);
      if ((b.buildProgress ?? 0) >= cap) continue; // waiting on the next load

      // Raising the frame needs hands and a hammer: the staffing system's
      // recruited builder must be on site, with the borrowed tool in his
      // hand (roads pave themselves; sandbox skips both).
      if (!def.isRoad && !world.admin.instantBuild) {
        const builder =
          b.workerId !== undefined ? world.units.get(b.workerId) : undefined;
        if (!builder || builder.dead) continue;
        if ((b.inputs[GoodId.hammer] ?? 0) <= 0) continue;
      }
      b.buildProgress = (b.buildProgress ?? 0) + 1;
      // The structure firms up as it rises — hp grows in step with progress
      // (an increment, so raid damage taken meanwhile is not healed).
      b.hp = Math.min(def.hp, b.hp + (def.hp * 0.85) / def.buildTicks);
      if (b.buildProgress < def.buildTicks) continue;
    }

    if (def.isRoad) {
      // Road "sites" don't become buildings — they pave their tile and vanish.
      world.map.pathLevel[tileIdx(b.x, b.y, world.map.size)] = PathLevel.Road;
      destroyBuilding(world, b);
      continue;
    }

    b.state = BuildingState.built;
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
    if ((b.inputs[GoodId.hammer] ?? 0) > 0) {
      b.stock[GoodId.hammer] =
        (b.stock[GoodId.hammer] ?? 0) + (b.inputs[GoodId.hammer] ?? 0);
      b.inputs[GoodId.hammer] = 0;
    }
    // The builder stays on as the building's worker — if the post's tool
    // is here to hand him (sites pre-order it, so it usually arrived with
    // the planks). Buildings that keep no resident (barracks, abbey), and
    // tool-gated posts whose tool is still on the road, release him back
    // to the serf pool; the post then recruits normally once equipped.
    if (
      b.workerId !== undefined &&
      (def.workerKind === undefined || !consumePostTool(world, b))
    ) {
      const builder = world.units.get(b.workerId);
      if (builder && !builder.dead) {
        builder.kind = UnitTypeId.serf;
        builder.homeId = undefined;
      }
      b.workerId = undefined;
    }
  }
}

/**
 * How far this frame has been paid up to, in build ticks.
 *
 * The share is counted over the goods the building is MADE of — `def.cost` —
 * and not over `siteNeeds`, which also carries the borrowed hammer
 * (placeSite). Counting the hammer would let a site with nothing but a tool
 * on the ground raise a fraction of itself, and would make the same fraction
 * mean different things to a two-good hut and a three-good Monument.
 *
 * By units of goods rather than by kind: thirty stone owed out of a
 * thirty-stone-and-twelve-gold bill is most of the building still to pay
 * for, not half of it.
 *
 * Floored, so a part-paid frame never reaches its last tick by rounding —
 * only a settled bill lifts the cap to `buildTicks`. Exported because the
 * staffing system asks the same question to decide when a builder is worth
 * recruiting, and two answers that could drift would be a builder standing
 * at a frame he is not allowed to raise.
 */
export function paidBuildTicks(b: Building, def: BuildingDef): number {
  let total = 0;
  let owed = 0;
  for (const g of goodKeys(def.cost)) {
    total += def.cost[g] ?? 0;
    owed += Math.min(b.siteNeeds?.[g] ?? 0, def.cost[g] ?? 0);
  }
  if (total <= 0) return def.buildTicks; // costs nothing: nothing to wait for
  return Math.floor((def.buildTicks * (total - owed)) / total);
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
  if (b.dead || b.state !== BuildingState.built || def.isRoad || def.systemOnly)
    return false;
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
  clearRepairOrder(world, b, goodKeys(needs));
  for (const job of world.jobs.values()) {
    if (job.repair && job.to === b.id)
      abortJob(world, job, 'repair called off', true);
  }
}
