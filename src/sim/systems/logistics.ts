import type {Enum} from '../../shared/enum.ts';
import {atBuilding, walkToBuilding} from '../arrival.ts';
import * as BuildingState from '../buildingStateEnum.ts';
import {
  JOB_BLOCKED_BACKOFF,
  MATCHER_INTERVAL,
  ABBEY_ALE_CAP,
  BARRACKS_ALE_CAP,
  EVAC_PRIORITY,
  HAUL_SHARE,
  RATION_STOCK,
  type HaulPriority,
} from '../defs/balance.ts';
import {
  INPUT_CAP,
  TOOL_GOODS,
  TOOL_OF,
  buildingDef,
  convertRecipeOf,
  outputGoodsOf,
  rationOf,
} from '../defs/buildings.ts';
import * as BuildingTypeId from '../defs/buildingTypeIdEnum.ts';
import * as GoodId from '../defs/goodIdEnum.ts';
import {GOODS, goodEntries, goodKeys} from '../defs/goods.ts';
import * as TechId from '../defs/techIdEnum.ts';
import * as UnitTypeId from '../defs/unitTypeIdEnum.ts';
import {
  centerOf,
  isPlayerOwner,
  type Building,
  type EntityId,
  type Owner,
} from '../entities.ts';
import * as HaulPhase from '../haulPhaseEnum.ts';
import {findPathToAdjacent} from '../path.ts';
import type {Unit} from '../units.ts';
import * as UnitTaskKind from '../unitTaskKindEnum.ts';
import {applyRepairMaterial, type HaulJob, type World} from '../world.ts';
import {forgeDemandRecipe} from './production.ts';
import {trainingDemand} from './training.ts';

type GoodId = Enum<typeof GoodId>;

/**
 * The heart of the game: goods physically live in building buffers and on
 * serfs. A periodic matcher turns demand into HaulJobs with reservations
 * booked immediately; idle serfs claim jobs; a reconcile pass self-heals any
 * inconsistency loudly instead of letting the economy deadlock silently.
 *
 * Reservation bookkeeping rules (THE invariants — see debug/invariants.ts):
 * - job open/toPickup: reservedOut[good]++ at from, inbound[good]++ at to.
 * - job toDropoff (good on serf): only inbound at to remains booked.
 * - Release goes through releaseSource/releaseDest — nowhere else.
 */

export function logisticsSystem(world: World): void {
  if (world.tick % MATCHER_INTERVAL === 0) {
    reconcile(world);
    rehomeCarriedGoods(world);
    match(world);
  }
  dispatch(world);
  progress(world);
}

// --- Reservation accounting (the only two functions that release) ----------

function releaseSource(world: World, job: HaulJob): void {
  const from = world.buildings.get(job.from);
  if (from)
    from.reservedOut[job.good] = Math.max(
      0,
      (from.reservedOut[job.good] ?? 0) - 1,
    );
}

function releaseDest(world: World, job: HaulJob): void {
  const to = world.buildings.get(job.to);
  if (to) to.inbound[job.good] = Math.max(0, (to.inbound[job.good] ?? 0) - 1);
}

/**
 * Cancel a job from any phase, releasing exactly the outstanding reservations.
 *
 * `keepCargo` spares whatever the serf is holding: the job dies but the
 * good stays in his hands, and the matcher hands it on later (see the
 * carried-good rule in match). Callers pass it when the carrier is alive
 * and merely reassigned — destroying a barrel because the player told
 * someone to walk elsewhere is not a rule, it is a bug.
 */
export function abortJob(
  world: World,
  job: HaulJob,
  reason: string,
  keepCargo = false,
): void {
  if (job.phase !== HaulPhase.toDropoff) releaseSource(world, job);
  releaseDest(world, job);
  const serf =
    job.serfId !== undefined ? world.units.get(job.serfId) : undefined;
  if (serf && !serf.dead) {
    if (serf.carrying !== undefined && !keepCargo) {
      // Nobody is left to carry it: the good is destroyed, ledgered so the
      // conservation check stays honest.
      world.ledger.consumed[serf.carrying] =
        (world.ledger.consumed[serf.carrying] ?? 0) + 1;
      serf.carrying = undefined;
    }
    serf.jobId = undefined;
    serf.path = null;
    serf.task = {t: UnitTaskKind.idle, until: world.tick};
  }
  world.jobs.delete(job.id);
  // The sim compiles for two hosts: Vite (where import.meta.env exists) and
  // plain Node on the server (where it does not). Reading it through a cast
  // keeps this dev-only warning honest in both without a shim.
  if ((import.meta as {env?: {DEV?: boolean}}).env?.DEV) {
    console.warn(
      `[logistics] job ${job.id} (${job.good} ${job.from}->${job.to}) aborted: ${reason}`,
    );
  }
}

/** A serf died or was reassigned: put its job back on the board. */
export function unassignJob(world: World, job: HaulJob): void {
  if (job.phase === HaulPhase.toDropoff) {
    // The good left the source already; without a carrier it is lost.
    abortJob(world, job, 'carrier lost while hauling');
    return;
  }
  job.phase = HaulPhase.open;
  job.serfId = undefined;
  // Half-wound is not wound: the next serf to take this job starts the draw
  // from the top rather than inheriting a dead one's progress.
  job.drawUntil = undefined;
}

// --- Demand/supply matching ------------------------------------------------

interface Demand {
  building: Building;
  good: GoodId;
  want: number;
  priority: HaulPriority;
  since: number;
}

function availableOut(b: Building, good: GoodId): number {
  return (b.stock[good] ?? 0) - (b.reservedOut[good] ?? 0);
}

/** Demand suspended after repeated unreachable hauls (see dispatch). */
function suspended(world: World, b: Building, good: GoodId): boolean {
  return (b.demandBackoff?.[good] ?? 0) > world.tick;
}

/**
 * Forget when a demand went unmet, because it is met. The FIFO age is per
 * (building, good) while the demands are not: a damaged woodcutter wants
 * wood for its repair *and* has wood to evacuate, and the branch that has
 * nothing to say must not reset the other's clock — a demand whose age is
 * wiped every matcher pass sorts last forever.
 */
function clearDemandAge(b: Building, good: GoodId): void {
  if ((b.repairNeeds?.[good] ?? 0) > 0) return;
  // Only delete a key that is actually there. `delete` on an absent key is
  // already a no-op, so this is the same clear — but it is reached once per
  // good per building per matcher pass, and deleting from a building's
  // demandSince is what tips that object into V8's dictionary mode, which
  // then taxes every read of it everywhere else in the sim.
  if (b.demandSince[good] !== undefined) delete b.demandSince[good];
}

function match(world: World): void {
  const demands: DemandFull[] = [];
  // Evacuation targets resolve per producer owner; cache the lookup — it
  // used to be a full building scan inside the loop.
  const storehouses = new Map<Owner, Building | undefined>();
  const storehouseOf = (owner: Owner): Building | undefined => {
    if (!storehouses.has(owner))
      storehouses.set(owner, findStorehouse(world, owner));
    return storehouses.get(owner);
  };

  for (const b of world.buildings.values()) {
    if (b.dead || !isPlayerOwner(b.owner)) continue;
    const def = buildingDef(b.type);

    if (b.state === BuildingState.site && b.siteNeeds && !b.paused) {
      for (const good of GOODS) {
        const want = (b.siteNeeds[good] ?? 0) - (b.inbound[good] ?? 0);
        if (want > 0 && !suspended(world, b, good)) {
          demands.push(demandOf(world, b, good, want, 1));
        } else if (want <= 0) {
          clearDemandAge(b, good);
        }
      }
      // The post's tool is pre-ordered while the walls rise (priority 2 —
      // the planks matter more), so the axe usually lands with the last
      // load and the builder walks straight onto the post. Never a gate
      // on construction itself: a site missing its tool still tops out,
      // it just opens unstaffed.
      const siteTool = TOOL_OF[b.type];
      if (siteTool !== undefined) {
        const want = 1 - (b.inputs[siteTool] ?? 0) - (b.inbound[siteTool] ?? 0);
        if (want > 0 && !suspended(world, b, siteTool)) {
          demands.push(demandOf(world, b, siteTool, want, 2));
        } else if (want <= 0) {
          clearDemandAge(b, siteTool);
        }
      }
      continue;
    }

    if (b.state !== BuildingState.built) continue;

    // An ordered repair calls for its materials at construction priority:
    // a wall being patched under fire is not a lesser errand than the mill's
    // next sack of wheat. Deliberately outside the `paused` gate — halting a
    // workshop stops it working, it does not stop the masons.
    if (b.repairNeeds) {
      for (const good of GOODS) {
        const want = (b.repairNeeds[good] ?? 0) - (b.inbound[good] ?? 0);
        if (want > 0 && !suspended(world, b, good)) {
          demands.push({...demandOf(world, b, good, want, 1), repair: true});
        }
      }
    }

    // Convert recipes demand their input goods (priority 2). A Smith's
    // demand follows what it will actually forge next — the queue head,
    // else the standing order, else auto's pick — so a forge queued onto
    // bows does not sit calling for iron (and an auto Smith with every
    // tool gap covered calls for nothing at all).
    // A halted post raises no demand, so resolving what it would forge is
    // work for an answer the next line throws away — and at a Smith that
    // answer costs a census of the whole village (autoForgeIndex).
    const convert = b.paused
      ? undefined
      : def.recipeOptions
        ? forgeDemandRecipe(world, b, def)
        : convertRecipeOf(def, b);
    if (convert && !b.paused) {
      for (const good of goodKeys(convert.inputs)) {
        const want = INPUT_CAP - (b.inputs[good] ?? 0) - (b.inbound[good] ?? 0);
        if (want > 0 && !suspended(world, b, good)) {
          demands.push(demandOf(world, b, good, want, 2));
        } else if (want <= 0) {
          clearDemandAge(b, good);
        }
      }
    }

    // A mine keeps its pantry stocked (priority 2, with the mill's wheat
    // and the smith's iron). A short cap on purpose — RATION_STOCK, not
    // INPUT_CAP: three mines each hoarding five loaves would hold a whole
    // bakery's output as inventory, and the loaf that matters is the one
    // already in the shaft when the last one is eaten.
    const ration = b.paused ? undefined : rationOf(def);
    if (ration) {
      const want =
        RATION_STOCK -
        (b.inputs[ration.good] ?? 0) -
        (b.inbound[ration.good] ?? 0);
      if (want > 0 && !suspended(world, b, ration.good)) {
        demands.push(demandOf(world, b, ration.good, want, 2));
      } else if (want <= 0) {
        clearDemandAge(b, ration.good);
      }
    }

    // A tool-gated post standing open calls for its tool (priority 2) —
    // the demand staffing waits on. One at a time, and none while a live
    // worker holds the post (his tool was consumed when he took it up).
    const postTool = TOOL_OF[b.type];
    if (postTool !== undefined && !b.paused) {
      const w =
        b.workerId !== undefined ? world.units.get(b.workerId) : undefined;
      const manned = w !== undefined && !w.dead;
      const want = manned
        ? 0
        : 1 - (b.inputs[postTool] ?? 0) - (b.inbound[postTool] ?? 0);
      if (want > 0 && !suspended(world, b, postTool)) {
        demands.push(demandOf(world, b, postTool, want, 2));
      } else if (want <= 0) {
        clearDemandAge(b, postTool);
      }
    }

    // Festivals: the abbey sips ale.
    if (
      b.type === BuildingTypeId.abbey &&
      !b.paused &&
      world.players[b.owner]?.techs.researched.includes(TechId.festivals)
    ) {
      const want =
        ABBEY_ALE_CAP -
        (b.inputs[GoodId.ale] ?? 0) -
        (b.inbound[GoodId.ale] ?? 0);
      if (want > 0) demands.push(demandOf(world, b, GoodId.ale, want, 2));
      else clearDemandAge(b, GoodId.ale);
    }

    // Ale Rations: the barracks keeps its cask topped up. Standing demand
    // like the abbey's, not per-order like the training goods below — the
    // drink speeds whatever trains next, so it should be waiting when the
    // recruit walks in rather than racing him to the door.
    if (
      def.trains &&
      !b.paused &&
      world.players[b.owner]?.techs.researched.includes(TechId.aleRations)
    ) {
      const want =
        BARRACKS_ALE_CAP -
        (b.inputs[GoodId.ale] ?? 0) -
        (b.inbound[GoodId.ale] ?? 0);
      if (want > 0) demands.push(demandOf(world, b, GoodId.ale, want, 2));
      else clearDemandAge(b, GoodId.ale);
    }

    // Training queues demand their wheat + weapons (priority 2).
    if (def.trains && !b.paused && b.trainQueue && b.trainQueue.length > 0) {
      const need = trainingDemand(b);
      for (const [good, n] of goodEntries(need)) {
        const want = n - (b.inputs[good] ?? 0) - (b.inbound[good] ?? 0);
        if (want > 0) demands.push(demandOf(world, b, good, want, 2));
        else clearDemandAge(b, good);
      }
    }

    // Producers evacuate their outputs to the storehouse — modeled as a
    // demand *by the storehouse*, pinned to the supplier. Priority 3 for
    // all but silver, which rides at 2 (EVAC_PRIORITY): a hire is paid
    // from the castle's shelf, not the mine's.
    if (!def.storage) {
      // Every good the building can ever emit — a smith switched off
      // bowmaking still ships its leftover bows. Plus any tool on the
      // shelf that production would never name: the hammer a topped-out
      // site returned, the axe a dismissed woodcutter left behind. Those
      // ride home from ANY building, recipe or not — a finished house is
      // no producer, but the hammer that raised it still wants hauling.
      const evac = new Set<GoodId>(
        def.recipe || def.recipeOptions ? outputGoodsOf(def) : [],
      );
      for (const tool of TOOL_GOODS) {
        if ((b.stock[tool] ?? 0) > 0) evac.add(tool);
      }
      // A salvage pile ships everything it holds — the whole point of the
      // wreck is that its goods go home on someone's shoulders (or into a
      // nearby site, which pulls from it as a supply directly).
      if (b.type === BuildingTypeId.salvage) {
        for (const good of goodKeys(b.stock)) {
          if ((b.stock[good] ?? 0) > 0) evac.add(good);
        }
      }
      for (const good of evac) {
        const surplus = availableOut(b, good);
        if (surplus > 0) {
          const storehouse = storehouseOf(b.owner);
          if (storehouse && storehouse.id !== b.id) {
            demands.push(
              demandOf(
                world,
                storehouse,
                good,
                surplus,
                EVAC_PRIORITY[good],
                b,
              ),
            );
          }
        } else {
          clearDemandAge(b, good);
        }
      }
    }
  }

  // Priority first, then FIFO by demand age.
  demands.sort(
    (a, z) =>
      a.priority - z.priority ||
      a.since - z.since ||
      a.building.id - z.building.id ||
      GOOD_INDEX[a.good] - GOOD_INDEX[z.good],
  );

  for (const d of demands) {
    let want = d.want;
    // Reuse the matched source while it still has availability: only this
    // loop's own reservations change during the iterations, so a rescan
    // would return the same winner until it is exhausted.
    let source: Building | undefined;
    while (want > 0) {
      if (source === undefined || availableOut(source, d.good) <= 0) {
        source = d.pinnedSource ?? nearestSupply(world, d.building, d.good);
        if (!source || availableOut(source, d.good) <= 0) break;
      }
      createJob(world, d.good, source.id, d.building.id, d.priority, d.repair);
      want--;
    }
  }
}

/** good -> position in GOODS, so the sort comparator avoids indexOf scans. */
const GOOD_INDEX = Object.fromEntries(GOODS.map((g, i) => [g, i])) as Record<
  GoodId,
  number
>;

interface DemandFull extends Demand {
  pinnedSource?: Building;
  /** Booked by an ordered repair — the mark rides onto the jobs it makes. */
  repair?: true;
}

function demandOf(
  world: World,
  building: Building,
  good: GoodId,
  want: number,
  priority: HaulPriority,
  pinnedSource?: Building,
): DemandFull {
  // FIFO age: the *demanding pair* tracks when it first went unmet. For
  // evacuation demands the age lives on the source building.
  const ageHolder = pinnedSource ?? building;
  if (ageHolder.demandSince[good] === undefined)
    ageHolder.demandSince[good] = world.tick;
  return {
    building,
    good,
    want,
    priority,
    since: ageHolder.demandSince[good],
    pinnedSource,
  };
}

function findStorehouse(world: World, owner: Owner): Building | undefined {
  for (const b of world.buildings.values()) {
    if (
      !b.dead &&
      b.state === BuildingState.built &&
      buildingDef(b.type).storage &&
      b.owner === owner
    ) {
      return b;
    }
  }
  return undefined;
}

function nearestSupply(
  world: World,
  sink: Building,
  good: GoodId,
): Building | undefined {
  const c = centerOf(sink);
  let best: Building | undefined;
  let bestDist = Infinity;
  for (const b of world.buildings.values()) {
    if (
      b.dead ||
      b.id === sink.id ||
      b.state !== BuildingState.built ||
      b.owner !== sink.owner
    )
      continue;
    if (availableOut(b, good) <= 0) continue;
    const bc = centerOf(b);
    const dist = Math.abs(bc.x - c.x) + Math.abs(bc.y - c.y);
    if (dist < bestDist) {
      bestDist = dist;
      best = b;
    }
  }
  return best;
}

function createJob(
  world: World,
  good: GoodId,
  from: EntityId,
  to: EntityId,
  priority: HaulPriority,
  repair?: true,
): void {
  const source = world.buildings.get(from)!;
  const dest = world.buildings.get(to)!;
  source.reservedOut[good] = (source.reservedOut[good] ?? 0) + 1;
  dest.inbound[good] = (dest.inbound[good] ?? 0) + 1;
  world.jobs.set(world.nextJobId, {
    id: world.nextJobId,
    good,
    from,
    to,
    // Source and dest share an owner by construction (nearestSupply and
    // evacuation both filter on it); the job carries it for dispatch.
    owner: dest.owner,
    priority,
    createdTick: world.tick,
    phase: HaulPhase.open,
    ...(repair ? {repair} : {}),
  });
  world.nextJobId++;
}

// --- Orphaned cargo --------------------------------------------------------

/**
 * A serf holding a good with no job to explain it — his haul was cancelled
 * out from under him (a move order, say) but the good is real and already
 * out of its source building. Hand him a delivery straight into the
 * dropoff phase: whoever wants that good, else the storehouse. The job
 * machinery already copes with a `from` that no longer means anything —
 * reconcile only checks the source while the phase is still toPickup.
 */
function rehomeCarriedGoods(world: World): void {
  for (const serf of world.units.values()) {
    if (serf.dead || serf.jobId !== undefined || serf.carrying === undefined)
      continue;
    if (serf.kind !== UnitTypeId.serf || !isPlayerOwner(serf.owner)) continue;
    if (serf.task.t !== UnitTaskKind.idle) continue; // let him finish the walk he was sent on

    const good = serf.carrying;
    const to = deliveryTargetFor(world, serf.owner, good);
    if (!to) continue; // no storehouse (eliminated) — he keeps holding it

    const path = findPathToAdjacent(
      world.map,
      Math.floor(serf.x),
      Math.floor(serf.y),
      to.x,
      to.y,
      to.w,
      to.h,
    );
    if (!path) continue; // walled off for now; try again next pass

    const job: HaulJob = {
      id: world.nextJobId++,
      good,
      // The good left its source long ago; nothing reads this once the
      // phase is toDropoff, and reconcile explicitly skips the check.
      from: to.id,
      to: to.id,
      owner: serf.owner,
      priority: 2,
      createdTick: world.tick,
      phase: HaulPhase.toDropoff,
      serfId: serf.id,
    };
    world.jobs.set(job.id, job);
    to.inbound[good] = (to.inbound[good] ?? 0) + 1;
    serf.jobId = job.id;
    serf.path = path;
    serf.pathIdx = 0;
    serf.task = {t: UnitTaskKind.haul};
  }
}

/** Somebody who wants this good — a builder or consumer first, else home. */
function deliveryTargetFor(
  world: World,
  owner: Owner,
  good: GoodId,
): Building | undefined {
  const home = findStorehouse(world, owner);
  for (const b of world.buildings.values()) {
    if (b.dead || b.owner !== owner || b === home) continue;
    if (b.state === BuildingState.site) {
      if ((b.siteNeeds?.[good] ?? 0) > (b.inbound[good] ?? 0)) return b;
      continue;
    }
    if ((b.repairNeeds?.[good] ?? 0) > (b.inbound[good] ?? 0)) return b;
    const def = buildingDef(b.type);
    const convert = convertRecipeOf(def, b);
    const wantsInput =
      !b.paused &&
      ((convert?.inputs[good] ?? 0) > 0 ||
        (b.type === BuildingTypeId.abbey && good === GoodId.ale));
    if (
      wantsInput &&
      (b.inputs[good] ?? 0) + (b.inbound[good] ?? 0) < INPUT_CAP
    )
      return b;
    // A hungry mine takes the loaf off a passing hauler the same way,
    // against its own shorter cap — RATION_STOCK on the pantry it eats
    // from, never Building.stock, which is the shelf everywhere else here.
    if (
      !b.paused &&
      rationOf(def)?.good === good &&
      (b.inputs[good] ?? 0) + (b.inbound[good] ?? 0) < RATION_STOCK
    )
      return b;
  }
  return home;
}

/**
 * How many candidates a single job will ask the pathfinder about before it
 * gives up and backs off. One was the old behaviour and the bug: the
 * nearest man's bad luck became the job's. Three is enough to step over a
 * knot of stranded serfs — the case that motivated this was two — while
 * keeping the cost of a pass a small constant times the old one rather
 * than idle-count times job-count.
 */
const PATH_TRIES = 3;

/**
 * One key per (destination, good), as `id * PULL_STRIDE + good`.
 *
 * Derived from the goods themselves rather than written down as a number
 * with room to spare. The key is only unique while every good id is under
 * the stride, and a good that broke that would not announce itself: two
 * different (building, good) pairs would quietly share one budget, and a
 * repair somewhere would pull the wrong loads for reasons nothing in the
 * logs could explain. A constant makes that a thing to remember when the
 * nineteenth good becomes the sixty-fourth; this makes it impossible.
 */
const PULL_STRIDE = Math.max(...GOODS) + 1;

/**
 * How many loads of each good an ordered repair may pull up to its own
 * tier, keyed by (destination, good). Null — the common case — when no
 * building anywhere is under repair, so a village at peace pays nothing
 * for this.
 *
 * The matcher books a repair's materials at construction priority and then
 * nets what it asks for against `inbound` (see match). Both halves are
 * right on their own and wrong together, which is what this repairs.
 *
 * Netting is right about QUANTITY: a load already walking in will feed the
 * repair when it lands, whatever it was sent for — deliver() puts any good
 * arriving at a building with an outstanding repairNeeds straight into the
 * walls. Booking a second load for a need already covered would just haul
 * a plank the village did not need moved.
 *
 * But netting silently threw the PRIORITY away with it, and at a
 * storehouse that is fatal. The storehouse is where every producer
 * evacuates to, so its `inbound` is permanently thick with priority-3
 * hauls; a repair ordered on it nets to `want <= 0` for every good, raises
 * no demand at all, and so never gets the tier-1 job that was the entire
 * point of ordering it. In one recorded match the castle was repaired at
 * 60% health with 14 open evacuation jobs standing against it, some 4,400
 * ticks old, and the order sat at "wants 3 wood, 2 stone" until the
 * building was destroyed 3,700 ticks later. Nothing was wrong with the
 * village's stores or its ground: the loads were there and nobody was
 * ever told to hurry.
 *
 * So the repair pulls rather than books. The loads already on their way
 * ride at its tier for as long as it needs them, which costs no extra
 * haulage and is exactly the urgency the player asked for. Bounded by what
 * the repair still wants, because beyond that the loads are ordinary
 * evacuation again and outranking a site's planks with them would be the
 * same mistake pointing the other way.
 */
function repairPull(world: World): Map<number, number> | null {
  let out: Map<number, number> | null = null;
  for (const b of world.buildings.values()) {
    if (b.dead || !b.repairNeeds) continue;
    for (const good of GOODS) {
      const want = b.repairNeeds[good] ?? 0;
      if (want <= 0) continue;
      out ??= new Map();
      out.set(b.id * PULL_STRIDE + good, want);
    }
  }
  return out;
}

/**
 * The tier this job actually rides in, spending a repair's pull if one is
 * standing for it.
 *
 * Spends: call it exactly once per job per pass, in a fixed order (hands in
 * flight, then the open queue oldest-first), or the tiers stop being a
 * function of the world and the sim stops being deterministic.
 *
 * A job already at tier 1 spends the pull too, and is why this does not
 * short-circuit on one. Away from the storehouse the netting works and the
 * matcher books the repair's own tier-1 haul; letting that job through
 * without spending would leave the whole pull unspent beside it, to be
 * handed to evacuation loads the mend has no use for.
 */
function tierOf(job: HaulJob, pull: Map<number, number> | null): HaulPriority {
  if (pull === null) return job.priority;
  const key = job.to * PULL_STRIDE + job.good;
  const left = pull.get(key);
  if (left === undefined || left <= 0) return job.priority;
  pull.set(key, left - 1);
  return 1;
}

// --- Serf claiming ---------------------------------------------------------

/**
 * The load home: an idle serf already standing at a building takes that
 * building's own open job before anything else is handed out. At, not in —
 * the test is atBuilding, a reach measured to the footprint, so the man on
 * the doorstep counts and nobody is ever inside the walls.
 *
 * This is the trip the village kept failing to make. A serf carries bread
 * to the mine, sets it down, and stands there with silver on the shelf at
 * his feet; the loop below then deals the oldest job of whichever tier is
 * short of hands, and hands it to whoever is nearest *it* — which is him,
 * because he is the only one free. So he walks back to the castle empty,
 * and the silver waits for somebody to walk out for it. Two crossings for
 * a load that was already in reach.
 *
 * Dealing these first is not a thumb on the scale for the tiers: the share
 * they split (HAUL_SHARE) rations *walks*, and a job picked up where the
 * man is standing costs none. He takes the building's most urgent load
 * first — for its own reason, not because the loop below would have
 * ordered them that way. It would not: it picks a tier by how far that
 * tier sits below its share of the hands before it sorts within one. Here
 * there is no walk to ration between them, so urgency is all that is left
 * to sort on.
 *
 * Deliberately a pass over the board rather than something progress() does
 * on the tick a delivery lands: a serf has to be genuinely idle for the
 * beat after a dropoff or he is invisible to the recruitment sweep, which
 * runs later in the same tick — and a site starved of its builder claims
 * the next hand to come free precisely there (systems/staffing.ts). So he
 * stands, is offered to the village first, and picks the load up on the
 * next pass if nobody wanted him.
 */
function takeStandingJobs(
  world: World,
  open: HaulJob[],
  idleByOwner: Map<Owner, Unit[]>,
): void {
  // Grouped by source: a building's jobs come up together, and the men
  // standing at it are found once for all of them rather than once each.
  const bySource = new Map<EntityId, HaulJob[]>();
  for (const job of open) {
    if (!idleByOwner.has(job.owner)) continue;
    let jobs = bySource.get(job.from);
    if (!jobs) bySource.set(job.from, (jobs = []));
    jobs.push(job);
  }

  for (const [from, jobs] of bySource) {
    const b = world.buildings.get(from);
    if (!b || b.dead) continue; // reconcile will clean it up
    // Source and destination share an owner by construction, so the
    // building's own is the job's — and it is the one a serf must match.
    const idle = idleByOwner.get(b.owner);
    if (!idle || idle.length === 0) continue;
    // Most urgent first, then the board's own FIFO. Not what the loop below
    // would have done with them: that picks a TIER by how far it sits below
    // its share of the hands and only then sorts within it, so an imbalanced
    // board deals a tier 3 load ahead of a tier 1 one by design. This is the
    // order that is right for a man already standing here — the building's
    // most urgent load first, since none of them costs him a walk.
    //
    // `job.priority`, deliberately, and not the effective tier a repair's
    // pull would give it (see repairPull). Two reasons, and the first is
    // that this sort is already a different discipline from the tiers: it
    // is a strict rank among the loads of ONE source, where the pull ranks
    // by DESTINATION, so all the pull could decide here is which of a
    // building's own loads leaves first — never whether the mend is served
    // at all. The main route below is where a repair takes its hands, and
    // it has the pull.
    //
    // The second is that the budget is per pass and spent, so honoring it
    // in two claiming routes means fixing an order between them and
    // keeping it fixed, for a reordering worth this little. If load-home
    // ever does want it, thread the same map through and spend it here
    // first — this route runs first — rather than growing a second budget.
    jobs.sort(
      (a, z) =>
        a.priority - z.priority || a.createdTick - z.createdTick || a.id - z.id,
    );
    // Whoever is standing here and still cannot reach the door — a man
    // sealed into a pocket at the wall. Remembered across this building's
    // jobs, because it is the same walk every time and asking twice only
    // spends the pathfinder (the dispatch loop keeps the same memo, for
    // the same reason).
    let refused: Set<number> | undefined;
    for (const job of jobs) {
      // Reservations should make this hold; if they somehow do not, leave
      // the job on the board for reconcile rather than walk a man onto an
      // empty shelf.
      if ((b.stock[job.good] ?? 0) < 1) continue;
      // The first man standing here who can actually get to the door. Not
      // simply the first standing here: one sealed-in serf must not answer
      // for the building and send every load in it back to the ordinary
      // board, which is the bug PATH_TRIES records below in its own words
      // — the nearest man's bad luck becoming the job's.
      let serf: Unit | undefined;
      let path: number[] | null = null;
      let i = -1;
      for (let k = 0; k < idle.length; k++) {
        const cand = idle[k]!;
        if (refused?.has(cand.id) || !atBuilding(cand, b)) continue;
        // The same walk the dispatch loop below would hand him, and for a
        // man already on the ring the pathfinder returns it empty without
        // a search — so this costs nothing in the ordinary case, and he
        // goes through arrival like everybody else rather than drawing
        // from the shelf a tick early.
        path = findPathToAdjacent(
          world.map,
          Math.floor(cand.x),
          Math.floor(cand.y),
          b.x,
          b.y,
          b.w,
          b.h,
        );
        if (path) {
          serf = cand;
          i = k;
          break;
        }
        (refused ??= new Set()).add(cand.id);
      }
      if (!serf || !path) break; // nobody left here who can reach it
      idle.splice(i, 1);
      job.phase = HaulPhase.toPickup;
      job.serfId = serf.id;
      job.blockedCount = 0; // claimed, so the unreachable tally starts over
      serf.jobId = job.id;
      serf.path = path;
      serf.pathIdx = 0;
      serf.task = {t: UnitTaskKind.haul};
      if (idle.length === 0) break;
    }
  }
}

function dispatch(world: World): void {
  // Collect open, unblocked jobs in claim order.
  const open: HaulJob[] = [];
  for (const job of world.jobs.values()) {
    if (
      job.phase === HaulPhase.open &&
      (job.blockedUntil === undefined || world.tick >= job.blockedUntil)
    ) {
      open.push(job);
    }
  }
  if (open.length === 0) return;

  // Idle serfs, bucketed by faction — a job is only ever offered to serfs of
  // its own owner.
  const idleByOwner = new Map<Owner, Unit[]>();
  for (const u of world.units.values()) {
    if (
      u.dead ||
      u.kind !== UnitTypeId.serf ||
      !isPlayerOwner(u.owner) ||
      u.jobId !== undefined
    )
      continue;
    // Walking under a player's move order is not idleness — leave them be
    // until they arrive (movement flips the task back to idle there). Nor
    // is a serf who is still holding something free: the pickup below
    // overwrites what he carries, which would destroy a real good with no
    // ledger entry to show for it. He owes that delivery first, and
    // rehomeCarriedGoods is what hands it to him.
    if (u.task.t === UnitTaskKind.idle && u.carrying === undefined) {
      let bucket = idleByOwner.get(u.owner);
      if (!bucket) idleByOwner.set(u.owner, (bucket = []));
      bucket.push(u);
    }
  }
  if (idleByOwner.size === 0) return;

  // The load home, before the board is dealt at all (see takeStandingJobs).
  takeStandingJobs(world, open, idleByOwner);
  // ...which can have taken the last free hand. The check above no longer
  // covers the sort below, so it is asked again: the buckets survive, but
  // every man in them may have just walked off with a load.
  let anyIdle = false;
  for (const bucket of idleByOwner.values()) {
    if (bucket.length > 0) {
      anyIdle = true;
      break;
    }
  }
  if (!anyIdle) return;

  // Sort only once we know somebody can actually claim a job — this runs
  // every tick, and most ticks have no idle serfs. Oldest first; the tier is
  // chosen below, per hand, and this is the order within it.
  open.sort((a, z) => a.createdTick - z.createdTick || a.id - z.id);

  // Per owner: the open jobs of each tier in that order, and how many hands
  // each tier already has — every job a serf is walking for, pickup or
  // dropoff, counts as one. Rehomed cargo (a priority-2 delivery with no
  // pickup) counts like any other.
  //
  // The tier a job rides in is `tierOf`, not `job.priority`: an ordered
  // repair pulls the loads already walking its way up to its own tier
  // instead of booking new ones. Hands in flight are counted first, so
  // they spend the pull before the open queue sees it.
  const pull = repairPull(world);
  const queues = new Map<Owner, [HaulJob[], HaulJob[], HaulJob[]]>();
  const busy = new Map<Owner, [number, number, number]>();
  for (const job of world.jobs.values()) {
    if (job.serfId === undefined || !idleByOwner.has(job.owner)) continue;
    let b = busy.get(job.owner);
    if (!b) busy.set(job.owner, (b = [0, 0, 0]));
    b[tierOf(job, pull) - 1]!++;
  }
  for (const job of open) {
    // Taken by takeStandingJobs, which ran above — and counted in `busy`
    // just now, since it has a carrier. Skipping it here is also what
    // keeps it from spending the repair's pull a second time.
    if (job.phase !== HaulPhase.open) continue;
    if (!idleByOwner.has(job.owner)) continue;
    let q = queues.get(job.owner);
    if (!q) queues.set(job.owner, (q = [[], [], []]));
    q[tierOf(job, pull) - 1]!.push(job);
  }

  for (const [owner, idle] of idleByOwner) {
    const q = queues.get(owner);
    if (!q) continue;
    const hands = busy.get(owner) ?? [0, 0, 0];
    const next = [0, 0, 0];
    // Per source building, the serfs already found unable to reach it in
    // this pass. Cleared with the pass: the map changes and so do they.
    const unreachableBy = new Map<number, Set<number>>();
    while (idle.length > 0) {
      // The tier furthest below its share of the hands (HAUL_SHARE); on a
      // tie the more urgent one, tier 1 before 2 before 3, which is what
      // the ascending scan with a strict `>` gives. Shares are taken over
      // the tiers that still
      // have a job to give, and so are the hands already out for them: a
      // tier with nothing left is not in the sum, so its share falls to
      // whoever has work, and a lone site's six planks still take every
      // hand. The target counts the hand about to be given, so two hands
      // over shares 2:1 split one and one rather than both to the two.
      let shareSum = 0;
      let handsOut = 0;
      for (let t = 0; t < 3; t++) {
        if (next[t]! >= q[t]!.length) continue;
        shareSum += HAUL_SHARE[(t + 1) as HaulPriority];
        handsOut += hands[t]!;
      }
      if (shareSum === 0) break;
      let tier = -1;
      let bestDeficit = -Infinity;
      for (let t = 0; t < 3; t++) {
        if (next[t]! >= q[t]!.length) continue;
        const target =
          (HAUL_SHARE[(t + 1) as HaulPriority] / shareSum) * (handsOut + 1);
        const deficit = target - hands[t]!;
        if (deficit > bestDeficit) {
          bestDeficit = deficit;
          tier = t;
        }
      }
      const job = q[tier]![next[tier]!]!;
      next[tier]!++;

      const from = world.buildings.get(job.from);
      if (!from) continue; // reconcile will clean it up

      // The nearest idle serf who can actually get there.
      //
      // Nearest alone was not enough. A serf who cannot path to the source
      // is not a candidate at all, and treating his predicament as the
      // job's fault is what turns one stranded man into a dead village: he
      // stays in the pool, is nearest again for the next job and the next,
      // and every one of them backs off four times and is finally aborted
      // as unreachable with a demand backoff on its destination. Two serfs
      // walled into a wheat farm's footprint stopped a village's haulage
      // outright this way, with the goods sitting in the castle and
      // twenty-five idle men who could all have walked there.
      //
      // So step outward: take the nearest, and if the ground says no, pass
      // him over and take the next.
      //
      // The stepping is bounded at PATH_TRIES, so this is not the same as
      // "blocked only when the source is truly unreachable": a job whose
      // PATH_TRIES nearest are all walled in still backs off while somebody
      // further out could have walked it. What keeps that from being the
      // old bug is the refusal memo below — the next job from the same
      // source skips the men already found wanting, so the search does
      // reach past them, just across jobs rather than within one. A source
      // that no idle serf can reach still lands on the backoff, which is
      // what it was written for.
      const c = centerOf(from);
      let serf: Unit | undefined;
      let path: number[] | null = null;
      let bestIdx = -1;
      // Whoever has already failed to reach THIS source during this pass.
      // A building's jobs come up together and it is the same walk every
      // time, so asking twice only spends the pathfinder.
      let refused = unreachableBy.get(job.from);
      for (let tries = 0; tries < PATH_TRIES; tries++) {
        bestIdx = -1;
        let bestDist = Infinity;
        for (let i = 0; i < idle.length; i++) {
          const s = idle[i]!;
          if (refused?.has(s.id)) continue;
          const dist = Math.abs(s.x - c.x) + Math.abs(s.y - c.y);
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
          }
        }
        if (bestIdx < 0) break; // everybody near has already been refused
        const cand = idle[bestIdx]!;
        path = findPathToAdjacent(
          world.map,
          Math.floor(cand.x),
          Math.floor(cand.y),
          from.x,
          from.y,
          from.w,
          from.h,
        );
        if (path) {
          serf = cand;
          break;
        }
        if (!refused) unreachableBy.set(job.from, (refused = new Set()));
        refused.add(cand.id);
      }
      if (!path || !serf) {
        job.blockedUntil = world.tick + JOB_BLOCKED_BACKOFF;
        job.blockedCount = (job.blockedCount ?? 0) + 1;
        if (job.blockedCount >= 4) {
          // Persistently unreachable (a walled-in doorway, say): stop pinning
          // the source's stock and suspend this demand so other consumers —
          // like storehouse evacuation — can have the goods.
          const dest = world.buildings.get(job.to);
          if (dest) {
            dest.demandBackoff ??= {};
            dest.demandBackoff[job.good] = world.tick + 600;
          }
          abortJob(world, job, 'unreachable after repeated attempts');
        }
        continue;
      }
      job.blockedCount = 0;

      idle.splice(bestIdx, 1);
      hands[tier]!++;
      job.phase = HaulPhase.toPickup;
      job.serfId = serf.id;
      serf.jobId = job.id;
      serf.path = path;
      serf.pathIdx = 0;
      serf.task = {t: UnitTaskKind.haul};
    }
  }
}

// --- Job progression (pickup / dropoff on arrival) -------------------------

function progress(world: World): void {
  for (const unit of world.units.values()) {
    if (
      unit.dead ||
      unit.jobId === undefined ||
      unit.task.t !== UnitTaskKind.haul
    )
      continue;
    if (unit.path !== null) continue; // still walking

    const job = world.jobs.get(unit.jobId);
    if (!job) {
      unit.jobId = undefined;
      unit.task = {t: UnitTaskKind.idle, until: world.tick};
      continue;
    }

    if (job.phase === HaulPhase.toPickup) {
      const from = world.buildings.get(job.from);
      if (!from || from.dead) {
        abortJob(world, job, 'source vanished before pickup');
        continue;
      }
      // The walk ended, but did it arrive? A route lost to new construction
      // ends it short, and only a serf actually standing at the source may
      // draw from it — otherwise the good leaves the building by post.
      if (!atBuilding(unit, from)) {
        if (!walkToBuilding(world.map, unit, from)) {
          abortJob(world, job, 'no way back to the source');
        }
        continue;
      }
      if ((from.stock[job.good] ?? 0) < 1) {
        // Reservation should prevent this; reconcile will warn. Retry later.
        abortJob(world, job, 'source out of stock at pickup');
        continue;
      }
      // Somewhere that has to be worked to give up its goods — the well and
      // its windlass. The serf stands at it for drawTicks before anything is
      // in its hands; the reservation is already held, so nothing else can
      // take the water it is winding up. (Held here, before the stock is
      // decremented, so a serf killed mid-draw loses the trip and not the
      // good.)
      const draw = buildingDef(from.type).drawTicks;
      if (draw !== undefined) {
        if (job.drawUntil === undefined) {
          job.drawUntil = world.tick + draw;
          continue;
        }
        if (world.tick < job.drawUntil) continue;
      }
      from.stock[job.good] = (from.stock[job.good] ?? 0) - 1;
      releaseSource(world, job);
      unit.carrying = job.good;
      job.phase = HaulPhase.toDropoff;

      const to = world.buildings.get(job.to);
      if (!to || to.dead) {
        abortJob(world, job, 'destination vanished at pickup');
        continue;
      }
      const path = findPathToAdjacent(
        world.map,
        Math.floor(unit.x),
        Math.floor(unit.y),
        to.x,
        to.y,
        to.w,
        to.h,
      );
      if (!path) {
        abortJob(world, job, 'no path to destination');
        continue;
      }
      unit.path = path;
      unit.pathIdx = 0;
    } else if (job.phase === HaulPhase.toDropoff) {
      const to = world.buildings.get(job.to);
      if (!to || to.dead) {
        abortJob(world, job, 'destination vanished before dropoff');
        continue;
      }
      // Same again at the other end: the good is on his shoulders, so it
      // arrives when he does. Cargo is kept on a give-up — he walks away
      // holding it, and rehomeCarriedGoods finds it a home from idle.
      if (!atBuilding(unit, to)) {
        if (!walkToBuilding(world.map, unit, to)) {
          abortJob(world, job, 'no way back to the destination', true);
        }
        continue;
      }
      deliver(world, to, job.good);
      releaseDest(world, job);
      unit.carrying = undefined;
      unit.jobId = undefined;
      unit.task = {t: UnitTaskKind.idle, until: world.tick};
      world.jobs.delete(job.id);
    }
  }
}

function deliver(world: World, to: Building, good: GoodId): void {
  if (to.state === BuildingState.site && to.siteNeeds) {
    if ((to.siteNeeds[good] ?? 0) === 0 && TOOL_OF[to.type] === good) {
      // The post's pre-ordered tool: not a construction material — it
      // waits in the rack for the builder-turned-worker (construction
      // completion / staffing consume it from there).
      to.inputs[good] = (to.inputs[good] ?? 0) + 1;
      return;
    }
    to.siteNeeds[good] = Math.max(0, (to.siteNeeds[good] ?? 0) - 1);
    if (good === GoodId.hammer) {
      // Borrowed, not consumed: the hammer survives in the site's hands
      // and goes back on the shelf at completion. Losing the site is the
      // only way to lose it.
      to.inputs[GoodId.hammer] = (to.inputs[GoodId.hammer] ?? 0) + 1;
      return;
    }
    world.ledger.consumed[good] = (world.ledger.consumed[good] ?? 0) + 1;
    return;
  }
  if ((to.repairNeeds?.[good] ?? 0) > 0) {
    // A repair material goes to the masons where it lands, never onto the
    // shelf: it buys its hp now and the walls climb over the next ticks.
    applyRepairMaterial(world, to, good);
    return;
  }
  const def = buildingDef(to.type);
  if (TOOL_OF[to.type] === good) {
    // The post's tool hangs in the rack until a recruit takes it up.
    to.inputs[good] = (to.inputs[good] ?? 0) + 1;
  } else if (
    def.recipeOptions
      ? def.recipeOptions.some(o => (o.recipe.inputs[good] ?? 0) > 0)
      : (convertRecipeOf(def, to)?.inputs[good] ?? 0) > 0
  ) {
    // Any recipe on the Smith's menu keeps its ingredients: iron that
    // arrives after the queue switched to bows stays in the buffer for
    // the next iron batch instead of bouncing home off the output shelf.
    to.inputs[good] = (to.inputs[good] ?? 0) + 1;
  } else if (to.type === BuildingTypeId.abbey && good === GoodId.ale) {
    to.inputs[GoodId.ale] = (to.inputs[GoodId.ale] ?? 0) + 1;
  } else if (rationOf(def)?.good === good) {
    // The miners' bread waits in the buffer, not on the output shelf —
    // the shelf is what evacuation carts home, and a mine that shipped
    // its own dinner back to the castle would never eat.
    to.inputs[good] = (to.inputs[good] ?? 0) + 1;
  } else if (def.trains) {
    // Training ingredients live in the input buffer too.
    to.inputs[good] = (to.inputs[good] ?? 0) + 1;
  } else {
    to.stock[good] = (to.stock[good] ?? 0) + 1;
  }
}

// --- Reconcile: validate every live job, repair loudly ---------------------

function reconcile(world: World): void {
  // Direct Map iteration is safe here: abortJob/unassignJob only ever
  // delete entries, never add, and JS Maps tolerate deletion mid-iteration.
  for (const job of world.jobs.values()) {
    const from = world.buildings.get(job.from);
    const to = world.buildings.get(job.to);
    if (!to || to.dead) {
      abortJob(world, job, 'reconcile: destination gone');
      continue;
    }
    if (job.phase !== HaulPhase.toDropoff && (!from || from.dead)) {
      abortJob(world, job, 'reconcile: source gone');
      continue;
    }
    if (job.phase !== HaulPhase.open) {
      const serf =
        job.serfId !== undefined ? world.units.get(job.serfId) : undefined;
      if (!serf || serf.dead) {
        unassignJob(world, job);
        continue;
      }
      if (serf.jobId !== job.id) {
        abortJob(world, job, 'reconcile: serf link broken');
        continue;
      }
      if (job.phase === HaulPhase.toDropoff && serf.carrying !== job.good) {
        abortJob(world, job, 'reconcile: carried good mismatch');
        continue;
      }
    }
    // A repair haul with nothing left to mend — the building settled the
    // last of the bill out of its own stores while this one was walking.
    // The plank stays in his hands; logistics finds it another home.
    if (job.repair && (to.repairNeeds?.[job.good] ?? 0) === 0) {
      abortJob(world, job, 'reconcile: repair no longer needs good', true);
      continue;
    }
    // Sites whose need for this good vanished (e.g. completed early or
    // over-provisioned): cancel surplus inbound jobs. The post's own
    // pre-ordered tool is exempt — it was never in siteNeeds to begin
    // with, and the post wants it however far along the walls are.
    if (
      to.state === BuildingState.site &&
      to.siteNeeds &&
      (to.siteNeeds[job.good] ?? 0) === 0 &&
      TOOL_OF[to.type] !== job.good
    ) {
      abortJob(world, job, 'reconcile: site no longer needs good');
      continue;
    }
    // Producers whose output evaporated (shouldn't happen — reservations).
    if (
      job.phase === HaulPhase.open &&
      from &&
      (from.stock[job.good] ?? 0) < (from.reservedOut[job.good] ?? 0)
    ) {
      abortJob(world, job, 'reconcile: source stock below reservation');
    }
  }
}

export {availableOut, findStorehouse};
