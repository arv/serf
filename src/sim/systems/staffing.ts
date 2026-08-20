import { ALE_TRAIN_SPEEDUP, TICKS_PER_SECOND } from '../defs/balance.ts';
import { buildingDef, garrisonRoom } from '../defs/buildings.ts';
import { GOODS, type GoodId } from '../defs/goods.ts';
import { findPathToAdjacent } from '../path.ts';
import { atBuilding, walkToBuilding } from '../arrival.ts';
import { bindWorker, unbindWorker } from './production.ts';
import { isPlayerOwner, type Building, type Owner } from '../entities.ts';
import type { UnitTypeId } from '../defs/units.ts';
import type { Unit } from '../units.ts';
import type { World } from '../world.ts';

const REQUEST_INTERVAL = 25; // ticks between recruitment sweeps
const UNREACHABLE_BACKOFF = REQUEST_INTERVAL; // hold before re-pathing to a walled-off post
/** A site ready for its builder this long escalates to every-tick claiming.
 * The clock starts on the sweep beat, so the effective bound is this plus
 * up to one REQUEST_INTERVAL. */
const BUILDER_STARVED_TICKS = 10 * TICKS_PER_SECOND;

/**
 * The population economy: every production building draws its resident
 * worker from the serf pool — an idle serf walks over and *becomes* the
 * worker — and the barracks consumes an arriving serf as each soldier's recruit.
 * People, not buildings, are the limiting resource.
 *
 * Recruitment sweeps every 25 ticks, and there is a race in that: the haul
 * dispatcher runs every tick and wants the same idle serfs. A serf goes idle
 * the moment a dropoff lands (logistics runs just before this system), and by
 * the next tick dispatch has claimed him for the next open job — so the sweep
 * finds an empty pool whenever the job board is non-empty. Mostly that is the
 * tuned balance (hauls keep the economy moving; posts fill when the pressure
 * ebbs), but a site that is fully supplied and waiting for its builder can
 * lose that race indefinitely under sustained mid-game haul pressure, with
 * the whole build order stalled behind a finished pile of materials. So a
 * site's wait is bounded: once it has stood builder-ready past
 * BUILDER_STARVED_TICKS, it claims every tick — beating dispatch to the next
 * serf who frees up, because this system runs after logistics in the tick.
 */
export function staffingSystem(world: World): void {
  handleArrivals(world);
  if (world.tick % REQUEST_INTERVAL === 0) releaseObsoletePosts(world);
  requestRecruits(world, world.tick % REQUEST_INTERVAL !== 0);
}

/**
 * A standing building holding a resident its def no longer wants gives them
 * back. Nothing in a running match makes one — construction already releases
 * the builder when a workerless building tops out — but a *save* does: the
 * well kept a keeper until this version, so a file written by an older build
 * still has one bound to a post that no longer exists. Left alone they stand
 * at the windlass forever, a hand the village paid for and can never use.
 *
 * Written as a rule rather than a well-shaped migration because the next def
 * to drop its post should not need a second one.
 */
function releaseObsoletePosts(world: World): void {
  for (const b of world.buildings.values()) {
    if (b.dead || b.state !== 'built' || b.workerId === undefined) continue;
    if (buildingDef(b.type).workerKind !== undefined) continue;
    const worker = world.units.get(b.workerId);
    if (!worker || worker.dead) {
      b.workerId = undefined;
      continue;
    }
    // Back to the pool means back to idle, and unbindWorker does that for
    // every caller now — see its comment for why a half-finished gather task
    // would otherwise strand the hand for good.
    unbindWorker(world, worker);
  }
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
    // Arrived, or just out of road? A walk ended short by new construction
    // would otherwise bind a worker to a post he is nowhere near — or, at a
    // barracks, enlist a recruit who never reached the door. The post stays
    // reserved for him while there is still a way to it.
    if (b && !b.dead && !atBuilding(unit, b) && walkToBuilding(world.map, unit, b)) continue;
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
    if (def.garrison && unit.kind === def.garrison.unit) {
      // The tower's archer climbs in. Consumed exactly as a barracks
      // recruit is — no unit is left standing outside for a raider to
      // shoot at, which is the whole of the tower's protection. `dead`
      // without a deathTick, so he vanishes rather than leaving a corpse
      // on the doorstep.
      if (garrisonRoom(def, b) <= 0) continue; // filled while he walked
      b.garrison = (b.garrison ?? 0) + 1;
      unit.dead = true;
      continue;
    }
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
      // Ale Rations: the recruit drinks from the cask and trains faster.
      // Checked here and not in cost — no ale never blocks the course, and
      // a cancelled order doesn't refund a drink already drunk.
      if (
        (b.inputs.ale ?? 0) > 0 &&
        world.players[b.owner]?.techs.researched.includes('aleRations')
      ) {
        b.inputs.ale = (b.inputs.ale ?? 0) - 1;
        world.ledger.consumed.ale = (world.ledger.consumed.ale ?? 0) + 1;
        head.ticksLeft = Math.max(1, Math.round(option.durationTicks / ALE_TRAIN_SPEEDUP));
      }
      unit.dead = true; // the person is now inside, training
    } else if (def.workerKind && !liveWorker(world, b)) {
      // The serf takes up the post and becomes this building's worker.
      unit.kind = def.workerKind;
      bindWorker(b, unit);
    }
  }
}

/**
 * The kind of person a building is calling for. A standing tower wants its
 * own soldier; everything else — including that tower's own building site,
 * which wants a builder like any other — wants a serf.
 */
function wantedKind(b: Building): UnitTypeId {
  const garrison = buildingDef(b.type).garrison;
  return garrison && b.state === 'built' ? garrison.unit : 'serf';
}

/**
 * Between sweeps (starvedOnly) this runs every tick but considers nothing
 * except sites past their builder-starvation bound — most ticks that is no
 * building at all, and the early return keeps the pass near-free.
 */
function requestRecruits(world: World, starvedOnly: boolean): void {
  // Buildings wanting staff right now — found first because most passes find
  // none, and then the (larger) unit scan below can be skipped entirely.
  const wanting: Building[] = [];
  // Deliveries already on an assigned carrier's route, per destination. A
  // site may only summon its builder once every outstanding need is covered
  // by one of these: an unclaimed job still needs an idle serf, and the serf
  // this sweep would recruit may be the only one — stolen for the frame, the
  // last plank never arrives and the site deadlocks at one-to-go.
  //
  // Built lazily: it means a scan of the job board, and on the every-tick
  // passes the common case is that no site is starved enough to ask.
  let assignedInbound: Map<number, number> | undefined;
  const assignedTo = (id: number): number => {
    if (!assignedInbound) {
      assignedInbound = new Map();
      for (const job of world.jobs.values()) {
        if (job.serfId !== undefined) {
          assignedInbound.set(job.to, (assignedInbound.get(job.to) ?? 0) + 1);
        }
      }
    }
    return assignedInbound.get(id) ?? 0;
  };
  for (const b of world.buildings.values()) {
    if (b.dead || !isPlayerOwner(b.owner)) continue;
    if (
      starvedOnly &&
      (b.state !== 'site' ||
        b.builderWantedSince === undefined ||
        world.tick - b.builderWantedSince < BUILDER_STARVED_TICKS)
    ) {
      continue;
    }
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

    // Builders are recruited only once the site is nearly supplied AND the
    // remainder is in assigned hands — any earlier and they'd stand idle at
    // the frame while the haul pool starves (or worse, *be* the hand the
    // last haul needed, see assignedInbound above). The walk overlaps the
    // last delivery.
    const needsLeft = GOODS.reduce((n, g) => n + (b.siteNeeds?.[g] ?? 0), 0);
    const wantsBuilder =
      b.state === 'site' &&
      needsLeft <= 1 &&
      needsLeft <= assignedTo(b.id) &&
      !liveWorker(world, b);
    if (b.state === 'site') {
      // The starvation clock: starts on the first sweep that finds the site
      // builder-ready and unfilled, stops when it no longer is. (A site with
      // a recruit already walking never reaches this line, so the clock
      // keeps running until the builder is actually bound — a recruit who
      // dies en route does not reset the wait.)
      if (wantsBuilder) b.builderWantedSince ??= world.tick;
      else delete b.builderWantedSince;
    }
    const wantsWorker =
      b.state === 'built' && def.workerKind !== undefined && !liveWorker(world, b);
    const wantsRecruit =
      b.state === 'built' && def.trains !== undefined && firstReadyTraining(b) >= 0;
    // A tower short of its garrison calls for another soldier. Unlike a
    // post, this one draws from the field rather than from the loose pool:
    // the men it wants have already been trained.
    const wantsGarrison = b.state === 'built' && garrisonRoom(def, b) > 0;
    if (wantsBuilder || wantsWorker || wantsRecruit || wantsGarrison) wanting.push(b);
  }
  if (wanting.length === 0) return;

  // Which kinds anyone is calling for this pass: serfs build, staff and
  // enlist, and a standing tower asks for soldiers of the kind that mans
  // it. Kept to what is actually wanted so an army standing idle costs
  // nothing to scan on a sweep where no tower is short — which is why this
  // and the dispatch below read the same `wantedKind`, rather than each
  // deciding for itself and drifting: the scan used to bucket archers for
  // a tower that was still a building site and wanted a builder.
  const wantedKinds = new Set<UnitTypeId>(wanting.map(wantedKind));
  wantedKinds.add('serf');

  // Idle people available for recruitment this pass, bucketed by faction and
  // kind — buildings only ever draw from their own owner's pool.
  const idleByOwner = new Map<Owner, Map<UnitTypeId, Unit[]>>();
  for (const u of world.units.values()) {
    if (u.dead || !wantedKinds.has(u.kind) || !isPlayerOwner(u.owner)) continue;
    if (u.jobId !== undefined) continue;
    // Someone walking under a player's move order is spoken for; recruiting
    // him mid-stride would make the order look ignored. Nor do we hire a
    // serf still holding a good — he owes that delivery first, and taking
    // a post would strand it in his hands forever.
    if (u.task.t === 'idle' && u.carrying === undefined) {
      let byKind = idleByOwner.get(u.owner);
      if (!byKind) idleByOwner.set(u.owner, (byKind = new Map()));
      let bucket = byKind.get(u.kind);
      if (!bucket) byKind.set(u.kind, (bucket = []));
      bucket.push(u);
    }
  }

  for (const b of wanting) {
    const idle = idleByOwner.get(b.owner)?.get(wantedKind(b));
    if (!idle || idle.length === 0) continue; // nobody of this kind left

    // The nearest idle one walks over.
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
    const recruit = idle[bestIdx]!;
    const path = findPathToAdjacent(
      world.map,
      Math.floor(recruit.x),
      Math.floor(recruit.y),
      b.x,
      b.y,
      b.w,
      b.h,
    );
    if (!path) {
      // Walled off for now. Same field the dismiss order uses — both mean
      // "don't recruit until" — but a short hold: re-pathing every tick to
      // a building that cannot be reached is the one cost running the sweep
      // per tick would otherwise add.
      b.staffBackoffUntil = world.tick + UNREACHABLE_BACKOFF;
      continue;
    }
    idle.splice(bestIdx, 1);
    recruit.path = path;
    recruit.pathIdx = 0;
    recruit.task = { t: 'staff', buildingId: b.id };
    b.recruitId = recruit.id;
  }
}
