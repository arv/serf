import { buildingDef } from '../defs/buildings.ts';
import { GOODS, type GoodId } from '../defs/goods.ts';
import { findPathToAdjacent } from '../path.ts';
import { bindWorker } from './production.ts';
import { isPlayerOwner, type Building, type Owner } from '../entities.ts';
import type { Unit } from '../units.ts';
import type { World } from '../world.ts';

const REQUEST_INTERVAL = 25; // ticks between recruitment sweeps

/**
 * The population economy: every production building draws its resident
 * worker from the serf pool — an idle serf walks over and *becomes* the
 * worker — and the barracks consumes an arriving serf as each soldier's recruit.
 * People, not buildings, are the limiting resource.
 */
export function staffingSystem(world: World): void {
  handleArrivals(world);
  if (world.tick % REQUEST_INTERVAL === 0) requestRecruits(world);
}

function liveWorker(world: World, b: Building): Unit | undefined {
  const w = b.workerId !== undefined ? world.units.get(b.workerId) : undefined;
  return w && !w.dead ? w : undefined;
}

/** First unstarted training item whose ingredients sit in the building. */
export function firstReadyTraining(b: Building): number {
  const def = buildingDef(b.type);
  if (!def.trains || !b.trainQueue) return -1;
  return b.trainQueue.findIndex((item) => {
    if (item.started) return false;
    const opt = def.trains!.find((o) => o.unit === item.unit);
    if (!opt) return false;
    return (Object.entries(opt.cost) as [GoodId, number][]).every(
      ([good, n]) => (b.inputs[good] ?? 0) >= n,
    );
  });
}

function handleArrivals(world: World): void {
  for (const unit of world.units.values()) {
    if (unit.dead || unit.task.t !== 'staff' || unit.path !== null) continue;
    const b = world.buildings.get(unit.task.buildingId);
    if (b?.recruitId === unit.id) b.recruitId = undefined;
    unit.task = { t: 'idle', until: world.tick };
    if (!b || b.dead) continue;

    const def = buildingDef(b.type);
    if (b.state === 'site') {
      // The builder: this serf raises the building (construction only
      // advances while they're on site) and stays on as its worker.
      if (def.isRoad || liveWorker(world, b)) continue;
      unit.kind = def.workerKind ?? 'worker';
      bindWorker(b, unit);
      continue;
    }
    if (b.state !== 'built') continue;
    if (def.trains) {
      // Barracks recruit: the serf enlists — consumed into the training queue.
      const idx = firstReadyTraining(b);
      if (idx < 0) continue; // ingredients were lost meanwhile; stand down
      if (idx > 0) {
        const [item] = b.trainQueue!.splice(idx, 1);
        b.trainQueue!.unshift(item!);
      }
      const head = b.trainQueue![0]!;
      const option = def.trains.find((o) => o.unit === head.unit)!;
      for (const [good, n] of Object.entries(option.cost) as [GoodId, number][]) {
        b.inputs[good] = (b.inputs[good] ?? 0) - n;
        world.ledger.consumed[good] = (world.ledger.consumed[good] ?? 0) + n;
      }
      head.started = true;
      head.ticksLeft = option.durationTicks;
      unit.dead = true; // the person is now inside, training
    } else if (def.workerKind && !liveWorker(world, b)) {
      // The serf takes up the post and becomes this building's worker.
      unit.kind = def.workerKind;
      bindWorker(b, unit);
    }
  }
}

function requestRecruits(world: World): void {
  // Idle serfs available for recruitment this pass, bucketed by faction —
  // buildings only ever draw staff from their own owner's pool.
  const idleByOwner = new Map<Owner, Unit[]>();
  for (const u of world.units.values()) {
    if (u.dead || u.kind !== 'serf' || !isPlayerOwner(u.owner) || u.jobId !== undefined) continue;
    // A serf walking under a player's move order is spoken for; recruiting
    // him mid-stride would make the order look ignored. Nor do we hire a
    // serf still holding a good — he owes that delivery first, and taking
    // a post would strand it in his hands forever.
    if (u.task.t === 'idle' && u.carrying === undefined) {
      let bucket = idleByOwner.get(u.owner);
      if (!bucket) idleByOwner.set(u.owner, (bucket = []));
      bucket.push(u);
    }
  }

  for (const b of world.buildings.values()) {
    if (b.dead || !isPlayerOwner(b.owner)) continue;
    // A freshly dismissed post stands open for a while: the player emptied
    // it on purpose, and re-capturing the freed serf the moment he goes
    // idle between haul trips would silently undo the order.
    if ((b.staffBackoffUntil ?? 0) > world.tick) continue;
    if (b.paused) continue; // a halted post summons nobody
    const def = buildingDef(b.type);
    if (b.state === 'site' ? def.isRoad : b.state !== 'built') continue;

    // Validate any recruit en route.
    if (b.recruitId !== undefined) {
      const r = world.units.get(b.recruitId);
      if (!r || r.dead || r.task.t !== 'staff' || r.task.buildingId !== b.id) {
        b.recruitId = undefined;
      } else {
        continue; // someone is on the way
      }
    }

    // Builders are recruited only once the site is nearly supplied — any
    // earlier and they'd stand idle at the frame while the haul pool
    // starves. The walk overlaps the last delivery.
    const needsLeft = GOODS.reduce((n, g) => n + (b.siteNeeds?.[g] ?? 0), 0);
    const wantsBuilder = b.state === 'site' && needsLeft <= 1 && !liveWorker(world, b);
    const wantsWorker =
      b.state === 'built' && def.workerKind !== undefined && !liveWorker(world, b);
    const wantsRecruit =
      b.state === 'built' && def.trains !== undefined && firstReadyTraining(b) >= 0;
    if (!wantsBuilder && !wantsWorker && !wantsRecruit) continue;
    const idle = idleByOwner.get(b.owner);
    if (!idle || idle.length === 0) continue; // nobody of this faction left

    // Nearest idle serf walks over.
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < idle.length; i++) {
      const s = idle[i]!;
      const dist = Math.abs(s.x - cx) + Math.abs(s.y - cy);
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
      b.x,
      b.y,
      b.w,
      b.h,
    );
    if (!path) continue;
    idle.splice(bestIdx, 1);
    serf.path = path;
    serf.pathIdx = 0;
    serf.task = { t: 'staff', buildingId: b.id };
    b.recruitId = serf.id;
  }
}
