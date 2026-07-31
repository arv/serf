import { JOB_BLOCKED_BACKOFF, MATCHER_INTERVAL, TERAKOYA_SAKE_CAP } from '../defs/balance.ts';
import { INPUT_CAP, buildingDef } from '../defs/buildings.ts';
import { GOODS, type GoodId } from '../defs/goods.ts';
import { centerOf, isPlayerOwner, type Building, type EntityId, type Owner } from '../entities.ts';
import { findPathToAdjacent } from '../path.ts';
import { trainingDemand } from './training.ts';
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

    if (b.state === 'site' && b.siteNeeds) {
      for (const good of GOODS) {
        const want = (b.siteNeeds[good] ?? 0) - (b.inbound[good] ?? 0);
        if (want > 0 && !suspended(world, b, good)) {
          demands.push(demandOf(world, b, good, want, 1));
        } else if (want <= 0) {
          delete b.demandSince[good];
        }
      }
      continue;
    }

    if (b.state !== 'built') continue;

    // Convert recipes demand their input goods (priority 2).
    if (def.recipe?.kind === 'convert') {
      for (const good of Object.keys(def.recipe.inputs) as GoodId[]) {
        const want = INPUT_CAP - (b.inputs[good] ?? 0) - (b.inbound[good] ?? 0);
        if (want > 0 && !suspended(world, b, good)) {
          demands.push(demandOf(world, b, good, want, 2));
        } else if (want <= 0) {
          delete b.demandSince[good];
        }
      }
    }

    // Festivals: the terakoya sips sake.
    if (b.type === 'terakoya' && world.players[b.owner]?.techs.researched.includes('festivals')) {
      const want = TERAKOYA_SAKE_CAP - (b.inputs.sake ?? 0) - (b.inbound.sake ?? 0);
      if (want > 0) demands.push(demandOf(world, b, 'sake', want, 2));
      else delete b.demandSince.sake;
    }

    // Training queues demand their rice + weapons (priority 2).
    if (def.trains && b.trainQueue && b.trainQueue.length > 0) {
      const need = trainingDemand(b);
      for (const [good, n] of Object.entries(need) as [GoodId, number][]) {
        const want = n - (b.inputs[good] ?? 0) - (b.inbound[good] ?? 0);
        if (want > 0) demands.push(demandOf(world, b, good, want, 2));
        else delete b.demandSince[good];
      }
    }

    // Producers evacuate their outputs to the storehouse (priority 3) —
    // modeled as a demand *by the storehouse*, pinned to the supplier.
    if (def.recipe && !def.storage) {
      const outputs =
        def.recipe.kind === 'gather'
          ? [def.recipe.output]
          : (Object.keys(def.recipe.outputs) as GoodId[]);
      for (const good of outputs) {
        const surplus = availableOut(b, good);
        if (surplus > 0) {
          const storehouse = storehouseOf(b.owner);
          if (storehouse && storehouse.id !== b.id) {
            demands.push(demandOf(world, storehouse, good, surplus, 3, b));
          }
        } else {
          delete b.demandSince[good];
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
      GOODS.indexOf(a.good) - GOODS.indexOf(z.good),
  );

  for (const d of demands) {
    let want = d.want;
    while (want > 0) {
      const source = d.pinnedSource ?? nearestSupply(world, d.building, d.good);
      if (!source || availableOut(source, d.good) <= 0) break;
      createJob(world, d.good, source.id, d.building.id, d.priority);
      want--;
      if (d.pinnedSource && availableOut(d.pinnedSource, d.good) <= 0) break;
    }
  }
}

interface DemandFull extends Demand {
  pinnedSource?: Building;
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
    const def = buildingDef(b.type);
    const wantsInput =
      (def.recipe?.kind === 'convert' && (def.recipe.inputs[good] ?? 0) > 0) ||
      (b.type === 'terakoya' && good === 'sake');
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
  open.sort((a, z) => a.priority - z.priority || a.createdTick - z.createdTick || a.id - z.id);

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
      if ((from.stock[job.good] ?? 0) < 1) {
        // Reservation should prevent this; reconcile will warn. Retry later.
        abortJob(world, job, 'source out of stock at pickup');
        continue;
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
  const def = buildingDef(to.type);
  if (def.recipe?.kind === 'convert' && (def.recipe.inputs[good] ?? 0) > 0) {
    to.inputs[good] = (to.inputs[good] ?? 0) + 1;
  } else if (to.type === 'terakoya' && good === 'sake') {
    to.inputs.sake = (to.inputs.sake ?? 0) + 1;
  } else if (def.trains) {
    // Training ingredients live in the input buffer too.
    to.inputs[good] = (to.inputs[good] ?? 0) + 1;
  } else {
    to.stock[good] = (to.stock[good] ?? 0) + 1;
  }
}

// --- Reconcile: validate every live job, repair loudly ---------------------

function reconcile(world: World): void {
  for (const job of [...world.jobs.values()]) {
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
