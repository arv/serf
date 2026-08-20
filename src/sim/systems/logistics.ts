import {
  JOB_BLOCKED_BACKOFF,
  MATCHER_INTERVAL,
  ABBEY_ALE_CAP,
  BARRACKS_ALE_CAP,
} from '../defs/balance.ts';
import { INPUT_CAP, buildingDef, convertRecipeOf, outputGoodsOf } from '../defs/buildings.ts';
import { GOODS, type GoodId } from '../defs/goods.ts';
import { centerOf, isPlayerOwner, type Building, type EntityId, type Owner } from '../entities.ts';
import { findPathToAdjacent } from '../path.ts';
import { atBuilding, walkToBuilding } from '../arrival.ts';
import { trainingDemand } from './training.ts';
import { applyRepairMaterial } from '../world.ts';
import type { Unit } from '../units.ts';
import type { HaulJob, World } from '../world.ts';

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
  if (from) from.reservedOut[job.good] = Math.max(0, (from.reservedOut[job.good] ?? 0) - 1);
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
  if (job.phase !== 'toDropoff') releaseSource(world, job);
  releaseDest(world, job);
  const serf = job.serfId !== undefined ? world.units.get(job.serfId) : undefined;
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
    serf.task = { t: 'idle', until: world.tick };
  }
  world.jobs.delete(job.id);
  // The sim compiles for two hosts: Vite (where import.meta.env exists) and
  // plain Node on the server (where it does not). Reading it through a cast
  // keeps this dev-only warning honest in both without a shim.
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
    console.warn(`[logistics] job ${job.id} (${job.good} ${job.from}->${job.to}) aborted: ${reason}`);
  }
}

/** A serf died or was reassigned: put its job back on the board. */
export function unassignJob(world: World, job: HaulJob): void {
  if (job.phase === 'toDropoff') {
    // The good left the source already; without a carrier it is lost.
    abortJob(world, job, 'carrier lost while hauling');
    return;
  }
  job.phase = 'open';
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
  priority: 1 | 2 | 3;
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
  delete b.demandSince[good];
}

function match(world: World): void {
  const demands: DemandFull[] = [];
  // Evacuation targets resolve per producer owner; cache the lookup — it
  // used to be a full building scan inside the loop.
  const storehouses = new Map<Owner, Building | undefined>();
  const storehouseOf = (owner: Owner): Building | undefined => {
    if (!storehouses.has(owner)) storehouses.set(owner, findStorehouse(world, owner));
    return storehouses.get(owner);
  };

  for (const b of world.buildings.values()) {
    if (b.dead || !isPlayerOwner(b.owner)) continue;
    const def = buildingDef(b.type);

    if (b.state === 'site' && b.siteNeeds && !b.paused) {
      for (const good of GOODS) {
        const want = (b.siteNeeds[good] ?? 0) - (b.inbound[good] ?? 0);
        if (want > 0 && !suspended(world, b, good)) {
          demands.push(demandOf(world, b, good, want, 1));
        } else if (want <= 0) {
          clearDemandAge(b, good);
        }
      }
      continue;
    }

    if (b.state !== 'built') continue;

    // An ordered repair calls for its materials at construction priority:
    // a wall being patched under fire is not a lesser errand than the mill's
    // next sack of wheat. Deliberately outside the `paused` gate — halting a
    // workshop stops it working, it does not stop the masons.
    if (b.repairNeeds) {
      for (const good of GOODS) {
        const want = (b.repairNeeds[good] ?? 0) - (b.inbound[good] ?? 0);
        if (want > 0 && !suspended(world, b, good)) {
          demands.push({ ...demandOf(world, b, good, want, 1), repair: true });
        }
      }
    }

    // Convert recipes demand their input goods (priority 2).
    const convert = convertRecipeOf(def, b);
    if (convert && !b.paused) {
      for (const good of Object.keys(convert.inputs) as GoodId[]) {
        const want = INPUT_CAP - (b.inputs[good] ?? 0) - (b.inbound[good] ?? 0);
        if (want > 0 && !suspended(world, b, good)) {
          demands.push(demandOf(world, b, good, want, 2));
        } else if (want <= 0) {
          clearDemandAge(b, good);
        }
      }
    }

    // Festivals: the abbey sips ale.
    if (b.type === 'abbey' && !b.paused && world.players[b.owner]?.techs.researched.includes('festivals')) {
      const want = ABBEY_ALE_CAP - (b.inputs.ale ?? 0) - (b.inbound.ale ?? 0);
      if (want > 0) demands.push(demandOf(world, b, 'ale', want, 2));
      else clearDemandAge(b, 'ale');
    }

    // Ale Rations: the barracks keeps its cask topped up. Standing demand
    // like the abbey's, not per-order like the training goods below — the
    // drink speeds whatever trains next, so it should be waiting when the
    // recruit walks in rather than racing him to the door.
    if (
      def.trains &&
      !b.paused &&
      world.players[b.owner]?.techs.researched.includes('aleRations')
    ) {
      const want = BARRACKS_ALE_CAP - (b.inputs.ale ?? 0) - (b.inbound.ale ?? 0);
      if (want > 0) demands.push(demandOf(world, b, 'ale', want, 2));
      else clearDemandAge(b, 'ale');
    }

    // Training queues demand their wheat + weapons (priority 2).
    if (def.trains && !b.paused && b.trainQueue && b.trainQueue.length > 0) {
      const need = trainingDemand(b);
      for (const [good, n] of Object.entries(need) as [GoodId, number][]) {
        const want = n - (b.inputs[good] ?? 0) - (b.inbound[good] ?? 0);
        if (want > 0) demands.push(demandOf(world, b, good, want, 2));
        else clearDemandAge(b, good);
      }
    }

    // Producers evacuate their outputs to the storehouse (priority 3) —
    // modeled as a demand *by the storehouse*, pinned to the supplier.
    if ((def.recipe || def.recipeOptions) && !def.storage) {
      // Every good the building can ever emit — a smith switched off
      // bowmaking still ships its leftover bows.
      for (const good of outputGoodsOf(def)) {
        const surplus = availableOut(b, good);
        if (surplus > 0) {
          const storehouse = storehouseOf(b.owner);
          if (storehouse && storehouse.id !== b.id) {
            demands.push(demandOf(world, storehouse, good, surplus, 3, b));
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
const GOOD_INDEX = Object.fromEntries(GOODS.map((g, i) => [g, i])) as Record<GoodId, number>;

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
  priority: 1 | 2 | 3,
  pinnedSource?: Building,
): DemandFull {
  // FIFO age: the *demanding pair* tracks when it first went unmet. For
  // evacuation demands the age lives on the source building.
  const ageHolder = pinnedSource ?? building;
  if (ageHolder.demandSince[good] === undefined) ageHolder.demandSince[good] = world.tick;
  return { building, good, want, priority, since: ageHolder.demandSince[good], pinnedSource };
}

function findStorehouse(world: World, owner: Owner): Building | undefined {
  for (const b of world.buildings.values()) {
    if (!b.dead && b.state === 'built' && buildingDef(b.type).storage && b.owner === owner) {
      return b;
    }
  }
  return undefined;
}

function nearestSupply(world: World, sink: Building, good: GoodId): Building | undefined {
  const c = centerOf(sink);
  let best: Building | undefined;
  let bestDist = Infinity;
  for (const b of world.buildings.values()) {
    if (b.dead || b.id === sink.id || b.state !== 'built' || b.owner !== sink.owner) continue;
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
  priority: 1 | 2 | 3,
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
    phase: 'open',
    ...(repair ? { repair } : {}),
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
    if (serf.dead || serf.jobId !== undefined || serf.carrying === undefined) continue;
    if (serf.kind !== 'serf' || !isPlayerOwner(serf.owner)) continue;
    if (serf.task.t !== 'idle') continue; // let him finish the walk he was sent on

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
      phase: 'toDropoff',
      serfId: serf.id,
    };
    world.jobs.set(job.id, job);
    to.inbound[good] = (to.inbound[good] ?? 0) + 1;
    serf.jobId = job.id;
    serf.path = path;
    serf.pathIdx = 0;
    serf.task = { t: 'haul' };
  }
}

/** Somebody who wants this good — a builder or consumer first, else home. */
function deliveryTargetFor(world: World, owner: Owner, good: GoodId): Building | undefined {
  const home = findStorehouse(world, owner);
  for (const b of world.buildings.values()) {
    if (b.dead || b.owner !== owner || b === home) continue;
    if (b.state === 'site') {
      if ((b.siteNeeds?.[good] ?? 0) > (b.inbound[good] ?? 0)) return b;
      continue;
    }
    if ((b.repairNeeds?.[good] ?? 0) > (b.inbound[good] ?? 0)) return b;
    const def = buildingDef(b.type);
    const convert = convertRecipeOf(def, b);
    const wantsInput =
      !b.paused &&
      (((convert?.inputs[good] ?? 0) > 0) || (b.type === 'abbey' && good === 'ale'));
    if (wantsInput && (b.inputs[good] ?? 0) + (b.inbound[good] ?? 0) < INPUT_CAP) return b;
  }
  return home;
}

// --- Serf claiming ---------------------------------------------------------

function dispatch(world: World): void {
  // Collect open, unblocked jobs in claim order.
  const open: HaulJob[] = [];
  for (const job of world.jobs.values()) {
    if (job.phase === 'open' && (job.blockedUntil === undefined || world.tick >= job.blockedUntil)) {
      open.push(job);
    }
  }
  if (open.length === 0) return;

  // Idle serfs, bucketed by faction — a job is only ever offered to serfs of
  // its own owner.
  const idleByOwner = new Map<Owner, Unit[]>();
  for (const u of world.units.values()) {
    if (u.dead || u.kind !== 'serf' || !isPlayerOwner(u.owner) || u.jobId !== undefined) continue;
    // Walking under a player's move order is not idleness — leave them be
    // until they arrive (movement flips the task back to idle there). Nor
    // is a serf who is still holding something free: the pickup below
    // overwrites what he carries, which would destroy a real good with no
    // ledger entry to show for it. He owes that delivery first, and
    // rehomeCarriedGoods is what hands it to him.
    if (u.task.t === 'idle' && u.carrying === undefined) {
      let bucket = idleByOwner.get(u.owner);
      if (!bucket) idleByOwner.set(u.owner, (bucket = []));
      bucket.push(u);
    }
  }
  if (idleByOwner.size === 0) return;

  // Sort only once we know somebody can actually claim a job — this runs
  // every tick, and most ticks have no idle serfs.
  open.sort((a, z) => a.priority - z.priority || a.createdTick - z.createdTick || a.id - z.id);

  for (const job of open) {
    const idle = idleByOwner.get(job.owner);
    if (!idle || idle.length === 0) continue;
    const from = world.buildings.get(job.from);
    if (!from) continue; // reconcile will clean it up

    // Nearest idle serf to the pickup.
    const c = centerOf(from);
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < idle.length; i++) {
      const s = idle[i]!;
      const dist = Math.abs(s.x - c.x) + Math.abs(s.y - c.y);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    const serf = idle[bestIdx]!;

    const path = findPathToAdjacent(
      world.map,
      Math.floor(serf.x),
      Math.floor(serf.y),
      from.x,
      from.y,
      from.w,
      from.h,
    );
    if (!path) {
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
    job.phase = 'toPickup';
    job.serfId = serf.id;
    serf.jobId = job.id;
    serf.path = path;
    serf.pathIdx = 0;
    serf.task = { t: 'haul' };
  }
}

// --- Job progression (pickup / dropoff on arrival) -------------------------

function progress(world: World): void {
  for (const unit of world.units.values()) {
    if (unit.dead || unit.jobId === undefined || unit.task.t !== 'haul') continue;
    if (unit.path !== null) continue; // still walking

    const job = world.jobs.get(unit.jobId);
    if (!job) {
      unit.jobId = undefined;
      unit.task = { t: 'idle', until: world.tick };
      continue;
    }

    if (job.phase === 'toPickup') {
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
      job.phase = 'toDropoff';

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
    } else if (job.phase === 'toDropoff') {
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
      unit.task = { t: 'idle', until: world.tick };
      world.jobs.delete(job.id);
    }
  }
}

function deliver(world: World, to: Building, good: GoodId): void {
  if (to.state === 'site' && to.siteNeeds) {
    // Construction materials are consumed by the site.
    to.siteNeeds[good] = Math.max(0, (to.siteNeeds[good] ?? 0) - 1);
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
  if ((convertRecipeOf(def, to)?.inputs[good] ?? 0) > 0) {
    to.inputs[good] = (to.inputs[good] ?? 0) + 1;
  } else if (to.type === 'abbey' && good === 'ale') {
    to.inputs.ale = (to.inputs.ale ?? 0) + 1;
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
    if (job.phase !== 'toDropoff' && (!from || from.dead)) {
      abortJob(world, job, 'reconcile: source gone');
      continue;
    }
    if (job.phase !== 'open') {
      const serf = job.serfId !== undefined ? world.units.get(job.serfId) : undefined;
      if (!serf || serf.dead) {
        unassignJob(world, job);
        continue;
      }
      if (serf.jobId !== job.id) {
        abortJob(world, job, 'reconcile: serf link broken');
        continue;
      }
      if (job.phase === 'toDropoff' && serf.carrying !== job.good) {
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
    // over-provisioned): cancel surplus inbound jobs.
    if (to.state === 'site' && to.siteNeeds && (to.siteNeeds[job.good] ?? 0) === 0) {
      abortJob(world, job, 'reconcile: site no longer needs good');
      continue;
    }
    // Producers whose output evaporated (shouldn't happen — reservations).
    if (
      job.phase === 'open' &&
      from &&
      (from.stock[job.good] ?? 0) < (from.reservedOut[job.good] ?? 0)
    ) {
      abortJob(world, job, 'reconcile: source stock below reservation');
    }
  }
}

export { availableOut, findStorehouse };
