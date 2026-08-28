import { ALE_TRAIN_SPEEDUP, TICKS_PER_SECOND } from '../defs/balance.ts';
import { TOOL_OF, buildingDef, garrisonRoom } from '../defs/buildings.ts';
import { GOODS, GoodId, goodEntries } from '../defs/goods.ts';
import { findPathToAdjacent } from '../path.ts';
import { atBuilding, walkToBuilding } from '../arrival.ts';
import { bindWorker, consumePostTool, unbindWorker } from './production.ts';
import { evictGarrison } from './training.ts';
import { isPlayerOwner, type Building, type Owner, BuildingState } from '../entities.ts';
import { type Unit, UnitTaskKind } from '../units.ts';
import type { World } from '../world.ts';
import { UnitTypeId } from '../defs/units.ts';
import { TechId } from '../defs/techs.ts';

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
  if (world.tick % REQUEST_INTERVAL === 0) {
    releaseObsoletePosts(world);
    emptyHaltedTowers(world);
  }
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
    if (b.dead || b.state !== BuildingState.built || b.workerId === undefined) continue;
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

/**
 * Halted means empty, on every beat and not only on the tick the order was
 * given. The command evicts as it lands, so nothing in a running match makes
 * a halted tower with men on it — but a *save* does: a file written before
 * the lever took the soldiers with it holds towers that are stood down and
 * manned at once, which is the exact contradiction the lever was fixed to
 * stop showing. They stand down on the first sweep after the load.
 *
 * Cheap enough to be worth having as a rule rather than a migration: it is
 * a field test on the buildings that keep a garrison, and it makes "halted
 * tower, empty roof" true by construction rather than by everyone
 * remembering.
 */
function emptyHaltedTowers(world: World): void {
  for (const b of world.buildings.values()) {
    if (b.dead || b.state !== BuildingState.built || !b.paused || !b.garrison) continue;
    if (!buildingDef(b.type).garrison) continue;
    evictGarrison(world, b, b.garrison);
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
    return goodEntries(opt.cost).every(([good, n]) => (b.inputs[good] ?? 0) >= n);
  });
}

function handleArrivals(world: World): void {
  for (const unit of world.units.values()) {
    if (unit.dead || unit.task.t !== UnitTaskKind.staff || unit.path !== null) continue;
    const b = world.buildings.get(unit.task.buildingId);
    // Arrived, or just out of road? A walk ended short by new construction
    // would otherwise bind a worker to a post he is nowhere near — or, at a
    // barracks, enlist a recruit who never reached the door. The post stays
    // reserved for him while there is still a way to it.
    if (b && !b.dead && !atBuilding(unit, b) && walkToBuilding(world.map, unit, b)) continue;
    if (b?.recruitId === unit.id) b.recruitId = undefined;
    unit.task = { t: UnitTaskKind.idle, until: world.tick };
    if (!b || b.dead) continue;

    const def = buildingDef(b.type);
    // A post halted while its recruit was already walking turns him away at
    // the door: pausing empties the post, and binding the walker would
    // quietly re-man it. He went idle above, so he is back in the pool.
    // A tower is no exception in either form. Its scaffold is a site like
    // any other, and its built form is halted precisely to take the men on
    // the roof back — letting a soldier climb in anyway would hand one
    // straight back to the order that just emptied it.
    if (b.paused) continue;
    if (b.state === BuildingState.site) {
      // The builder: this serf raises the building (construction only
      // advances while they're on site) and stays on as its worker.
      if (def.isRoad || liveWorker(world, b)) continue;
      unit.kind = def.workerKind ?? UnitTypeId.worker;
      bindWorker(b, unit);
      continue;
    }
    if (b.state !== BuildingState.built) continue;
    if (def.garrison && unit.kind === def.garrison.unit) {
      // The tower's archer climbs in. Consumed exactly as a barracks
      // recruit is — no unit is left standing outside for a raider to
      // shoot at, which is the whole of the tower's protection. `dead`
      // without a deathTick, so he vanishes rather than leaving a corpse
      // on the doorstep.
      //
      // A soldier at the door relieves the levy outright rather than
      // squeezing in beside it: the tower shoots as one kind of man (see
      // garrisonKind), so the villagers go back to work and he takes the
      // wall. The rest of his squad fills in behind him on later sweeps.
      if (b.garrisonKind === def.garrison.levy.unit) {
        evictGarrison(world, b, b.garrison ?? 0);
      }
      if (garrisonRoom(def, b) <= 0) continue; // filled while he walked
      b.garrison = (b.garrison ?? 0) + 1;
      b.garrisonKind = def.garrison.unit;
      (b.garrisonHp ??= []).push(unit.hp); // what he climbed up with
      // ...including his half-drawn bow. The clock travels with the man, or
      // a volley from one tower could be followed straight away by a volley
      // from the next one he walked into.
      if (unit.cooldownLeft > (b.attackCooldown ?? 0)) b.attackCooldown = unit.cooldownLeft;
      unit.dead = true;
      continue;
    }
    // (No pause check: a halted tower turned him away at the door above,
    // along with every other kind of man.)
    if (def.garrison && unit.kind === def.garrison.levy.unit) {
      // A villager answering the levy. Same consumption as the soldier —
      // he is inside the wall, not standing at its foot — and he steps
      // aside for soldiers rather than the other way round, so he never
      // takes a place in a tower the archers already hold.
      if (b.garrisonKind === def.garrison.unit) continue;
      if (garrisonRoom(def, b) <= 0) continue;
      b.garrison = (b.garrison ?? 0) + 1;
      b.garrisonKind = def.garrison.levy.unit;
      (b.garrisonHp ??= []).push(unit.hp);
      if (unit.cooldownLeft > (b.attackCooldown ?? 0)) b.attackCooldown = unit.cooldownLeft;
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
      for (const [good, n] of goodEntries(option.cost)) {
        b.inputs[good] = (b.inputs[good] ?? 0) - n;
        world.ledger.consumed[good] = (world.ledger.consumed[good] ?? 0) + n;
      }
      head.started = true;
      head.ticksLeft = option.durationTicks;
      // Ale Rations: the recruit drinks from the cask and trains faster.
      // Checked here and not in cost — no ale never blocks the course, and
      // a cancelled order doesn't refund a drink already drunk.
      if (
        (b.inputs[GoodId.ale] ?? 0) > 0 &&
        world.players[b.owner]?.techs.researched.includes(TechId.aleRations)
      ) {
        b.inputs[GoodId.ale] = (b.inputs[GoodId.ale] ?? 0) - 1;
        world.ledger.consumed[GoodId.ale] = (world.ledger.consumed[GoodId.ale] ?? 0) + 1;
        head.ticksLeft = Math.max(1, Math.round(option.durationTicks / ALE_TRAIN_SPEEDUP));
      }
      unit.dead = true; // the person is now inside, training
    } else if (def.workerKind && !liveWorker(world, b)) {
      // The serf takes up the post and becomes this building's worker —
      // if the post's tool is still on the rack to hand him (it was when
      // he was recruited; like the barracks' "ingredients were lost
      // meanwhile", it may not be now). No tool, no hire: he stands down
      // and the post goes back to demanding one.
      if (!consumePostTool(world, b)) continue;
      unit.kind = def.workerKind;
      bindWorker(b, unit);
    }
  }
}

/**
 * The kinds of person a building is calling for, best first. Everything but
 * a standing tower — including that tower's own building site, which wants
 * a builder like any other — wants a serf and nothing else.
 *
 * A tower wants soldiers whenever it has room, and *also* when the levy
 * holds it: a soldier walking up relieves villagers rather than queuing
 * behind them. It wants villagers wherever they would actually be let in —
 * room to stand, and no soldiers already holding the wall — so a tower the
 * archers reached is not a standing request for serfs nobody will fill.
 *
 * `paused` decides the whole roof: a stood-down tower calls nobody up, of
 * either kind. That is what keeps a tower from quietly eating two of the
 * village's hands the day it is built — and, since halting sends the men
 * already up back down, what makes the lever the one place a player decides
 * whether two soldiers stand on this wall or with the army.
 */
function wantedKinds(b: Building): UnitTypeId[] {
  const def = buildingDef(b.type);
  const g = def.garrison;
  if (!g || b.state !== BuildingState.built) return [UnitTypeId.serf];
  if (b.paused) return [];
  const room = garrisonRoom(def, b);
  const kinds: UnitTypeId[] = [];
  if (room > 0 || b.garrisonKind === g.levy.unit) kinds.push(g.unit);
  if (room > 0 && b.garrisonKind !== g.unit) kinds.push(g.levy.unit);
  return kinds;
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
      (b.state !== BuildingState.site ||
        b.builderWantedSince === undefined ||
        world.tick - b.builderWantedSince < BUILDER_STARVED_TICKS)
    ) {
      continue;
    }
    // Holding off on purpose — today that is only the walled-off hold set
    // below, kept as a field so a sweep never re-paths to a post it just
    // failed to reach.
    if ((b.staffBackoffUntil ?? 0) > world.tick) continue;
    const def = buildingDef(b.type);
    // A halted post summons nobody, towers included (see wantedKinds):
    // halting one is the order to take its roof back, so calling a soldier
    // over to climb straight up it would undo the order as it was given.
    if (b.paused) continue;
    if (b.state === BuildingState.site ? def.isRoad : b.state !== BuildingState.built) continue;

    // Validate any recruit en route.
    if (b.recruitId !== undefined) {
      const r = world.units.get(b.recruitId);
      if (!r || r.dead || r.task.t !== UnitTaskKind.staff || r.task.buildingId !== b.id) {
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
    // Sites only. Every consumer of needsLeft below is already gated on
    // `state === 'site'`, so summing it for the settlement's built
    // buildings — twenty optional lookups and a closure apiece, every
    // sweep — only ever produced a number nothing read.
    const isSite = b.state === BuildingState.site;
    let needsLeft = 0;
    if (isSite) for (const g of GOODS) needsLeft += b.siteNeeds?.[g] ?? 0;
    const wantsBuilder =
      isSite && needsLeft <= 1 && needsLeft <= assignedTo(b.id) && !liveWorker(world, b);
    if (isSite) {
      // The starvation clock: starts on the first sweep that finds the site
      // builder-ready and unfilled, stops when it no longer is. (A site with
      // a recruit already walking never reaches this line, so the clock
      // keeps running until the builder is actually bound — a recruit who
      // dies en route does not reset the wait.)
      if (wantsBuilder) b.builderWantedSince ??= world.tick;
      // Guarded for the same reason as clearDemandAge: this `else` is the
      // common case for every site that is not yet builder-ready, and
      // deleting a field off the Building itself would put the whole
      // object into dictionary mode for the rest of the match.
      else if (b.builderWantedSince !== undefined) delete b.builderWantedSince;
    }
    const tool = TOOL_OF[b.type];
    const wantsWorker =
      b.state === BuildingState.built &&
      def.workerKind !== undefined &&
      !liveWorker(world, b) &&
      // A tool-gated post summons nobody until its tool hangs in the
      // rack — recruiting first would walk a serf over to stand in front
      // of an empty peg while the axe is still on the road.
      (tool === undefined || (b.inputs[tool] ?? 0) >= 1);
    const wantsRecruit =
      b.state === BuildingState.built && def.trains !== undefined && firstReadyTraining(b) >= 0;
    // A tower short of its garrison calls for another man. Unlike a post,
    // this one may draw from the field rather than from the loose pool: the
    // soldiers it prefers have already been trained. It also calls when it
    // is full of villagers, because a soldier arriving relieves them.
    const wantsGarrison =
      b.state === BuildingState.built && def.garrison !== undefined && wantedKinds(b).length > 0;
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
  const wanted = new Set<UnitTypeId>(wanting.flatMap(wantedKinds));
  wanted.add(UnitTypeId.serf);

  // Idle people available for recruitment this pass, bucketed by faction and
  // kind — buildings only ever draw from their own owner's pool.
  const idleByOwner = new Map<Owner, Map<UnitTypeId, Unit[]>>();
  for (const u of world.units.values()) {
    if (u.dead || !wanted.has(u.kind) || !isPlayerOwner(u.owner)) continue;
    if (u.jobId !== undefined) continue;
    // Someone walking under a player's move order is spoken for; recruiting
    // him mid-stride would make the order look ignored. Nor do we hire a
    // serf still holding a good — he owes that delivery first, and taking
    // a post would strand it in his hands forever.
    if (u.task.t === UnitTaskKind.idle && u.carrying === undefined) {
      let byKind = idleByOwner.get(u.owner);
      if (!byKind) idleByOwner.set(u.owner, (byKind = new Map()));
      let bucket = byKind.get(u.kind);
      if (!bucket) byKind.set(u.kind, (bucket = []));
      bucket.push(u);
    }
  }

  for (const b of wanting) {
    // Best kind first, falling through to the next only when nobody of it
    // is standing loose: a tower takes the archer when there is one and the
    // villager when there is not.
    const byKind = idleByOwner.get(b.owner);
    let idle: Unit[] | undefined;
    for (const kind of wantedKinds(b)) {
      const pool = byKind?.get(kind);
      if (pool && pool.length > 0) {
        idle = pool;
        break;
      }
    }
    if (!idle || idle.length === 0) continue; // nobody of any wanted kind left

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
      // Walled off for now. A short "don't recruit until" hold: re-pathing
      // every tick to a building that cannot be reached is the one cost
      // running the sweep per tick would otherwise add.
      b.staffBackoffUntil = world.tick + UNREACHABLE_BACKOFF;
      continue;
    }
    idle.splice(bestIdx, 1);
    recruit.path = path;
    recruit.pathIdx = 0;
    recruit.task = { t: UnitTaskKind.staff, buildingId: b.id };
    b.recruitId = recruit.id;
  }
}
