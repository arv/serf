/**
 * World -> wire snapshots. Pure functions over a World, shared by the
 * in-browser sim worker (single player) and the server (multiplayer), which
 * is why the relative imports spell out `.ts` — node loads this file from
 * source, no build step.
 *
 * Nothing here decides *who may see what*; these build the full picture.
 * Per-player filtering happens above, on the server, so the two concerns
 * stay separable.
 */
import type {Enum} from '../shared/enum.ts';
import {exactDist} from '../shared/math.ts';
import {distToFootprint} from '../sim/arrival.ts';
import {batchTicks} from '../sim/batchTicks.ts';
import * as BuildingState from '../sim/buildingStateEnum.ts';
import {HIRE_SERF_TICKS} from '../sim/defs/balance.ts';
import {
  TOOL_OF,
  buildingDef,
  convertRecipeOf,
  gatherOrigin,
  gatherRecipeOf,
  type BuildingDef,
} from '../sim/defs/buildings.ts';
import * as BuildingTypeId from '../sim/defs/buildingTypeIdEnum.ts';
import * as GoodId from '../sim/defs/goodIdEnum.ts';
import {GOODS, type GoodAmounts} from '../sim/defs/goods.ts';
import * as RecipeKind from '../sim/defs/recipeKindEnum.ts';
import {TECH_DEFS} from '../sim/defs/techs.ts';
import {UNIT_DEFS, carryingCode} from '../sim/defs/units.ts';
import * as UnitTypeId from '../sim/defs/unitTypeIdEnum.ts';
import {centerOf, type Building, type Owner} from '../sim/entities.ts';
import * as HaulPhase from '../sim/haulPhaseEnum.ts';
import {countResourceNear, countWorkableResourceNear} from '../sim/map.ts';

import * as TileResource from '../sim/tileResourceEnum.ts';
import type {Unit} from '../sim/units.ts';
import * as UnitTaskKind from '../sim/unitTaskKindEnum.ts';
import type {World} from '../sim/world.ts';
import type {BuildingSnap, JobSnap, PlayerSnap} from './messages.ts';
import {
  ACTION,
  BUFF,
  PROFESSION,
  WORK,
  type UnitSnapshot,
} from './sabLayout.ts';
import * as StaffingState from './staffingStateEnum.ts';

type GoodId = Enum<typeof GoodId>;

export function snapBuilding(world: World, b: Building): BuildingSnap {
  const def = buildingDef(b.type);
  let staffing: BuildingSnap['staffing'];
  // A paused post is not asking for anyone — pausing emptied it on purpose —
  // so it reports no staffing state rather than a false "needed" alarm.
  const wantsStaff =
    !b.paused &&
    (b.state === BuildingState.built
      ? def.workerKind !== undefined
      : b.state === BuildingState.site && !def.isRoad);
  if (wantsStaff) {
    const worker =
      b.workerId !== undefined ? world.units.get(b.workerId) : undefined;
    staffing =
      worker && !worker.dead
        ? StaffingState.staffed
        : b.recruitId !== undefined
          ? StaffingState.recruiting
          : StaffingState.needed;
  }
  return {
    staffing,
    facing: b.facing,
    id: b.id,
    type: b.type,
    owner: b.owner,
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
    hp: b.hp,
    maxHp: def.hp,
    state: b.state,
    siteNeeds: b.siteNeeds ? {...b.siteNeeds} : undefined,
    repairNeeds: b.repairNeeds ? {...b.repairNeeds} : undefined,
    repairPending: b.repairPending,
    progress01:
      b.state === BuildingState.site && def.buildTicks > 0
        ? (b.buildProgress ?? 0) / def.buildTicks
        : undefined,
    stock: {...b.stock},
    inputs: {...b.inputs},
    inbound: {...b.inbound},
    reservedOut: {...b.reservedOut},
    trainQueue: b.trainQueue?.map(q => ({
      unit: q.unit,
      started: q.started,
      progress01: q.started
        ? 1 -
          q.ticksLeft /
            (def.trains?.find(o => o.unit === q.unit)?.durationTicks ?? 1)
        : undefined,
    })),
    rally: b.rally ? {...b.rally} : undefined,
    // A paused building keeps its half-done batch (prodTicksLeft freezes),
    // so the flag needs both: batch underway AND actually ticking.
    working: b.prodTicksLeft !== undefined && !b.paused ? true : undefined,
    paused: b.paused,
    recipeIndex: b.recipeIndex,
    prodRecipeIndex: b.prodRecipeIndex,
    prodProgress01: batchProgress01(world, b, def),
    forgeQueue: b.forgeQueue?.map(q => ({
      recipeIndex: q.recipeIndex,
      started: q.started,
    })),
    garrison: def.garrison ? (b.garrison ?? 0) : undefined,
    garrisonCap: def.garrison?.capacity,
    levied:
      def.garrison && b.garrisonKind === def.garrison.levy.unit
        ? true
        : undefined,
    // On cooldown means it loosed within the last volley's worth of ticks,
    // which is exactly the window the roof should be drawing a bow in.
    firing: (b.attackCooldown ?? 0) > 0 ? true : undefined,
    ...reachStock(world, b),
    outWaitingSince: outWaitingSinceOf(world, b),
    hireQueue: b.hireQueue,
    hireProgress01: b.hireQueue
      ? 1 - (b.hireTicksLeft ?? HIRE_SERF_TICKS) / HIRE_SERF_TICKS
      : undefined,
  };
}

/**
 * How far the batch on the fire has come, 0..1 — the smith's clock, and
 * every other converter's for whoever draws them next. Undefined when
 * nothing is burning, which is what a cold fire should draw: no bar at
 * all rather than an empty one that reads as "just started".
 *
 * Measured against the length the batch was STARTED with, which the sim
 * stamps beside the clock (Building.prodTicksTotal). Recomputing it here
 * would be wrong, not merely approximate: a speed tech landing mid-batch
 * shortens what a new batch would take without touching the one already
 * running, so the same clock read against a shorter yardstick reads as
 * LESS done than it did a tick ago — the bar steps backwards, and no
 * clamp to [0,1] catches a step taken in the middle of the range.
 *
 * The recomputed length survives as the fallback for one case only: a
 * save written before the stamp existed, restored with a batch already
 * on the fire (an optional field costs no save-version bump, so such
 * saves still load). One batch of a slightly-off bar, once, and the
 * clamp is what keeps that case inside its own ends.
 */
function batchProgress01(
  world: World,
  b: Building,
  def: BuildingDef,
): number | undefined {
  if (b.prodTicksLeft === undefined) return undefined;
  // What is actually on the fire: the option it was stamped with at batch
  // start (a smith retuned mid-batch is still hammering the old thing),
  // else the building's one fixed recipe.
  const recipe =
    b.prodRecipeIndex !== undefined
      ? def.recipeOptions?.[b.prodRecipeIndex]?.recipe
      : convertRecipeOf(def, b);
  if (!recipe) return undefined;
  const total = b.prodTicksTotal ?? batchTicks(world, b, recipe);
  return Math.min(1, Math.max(0, 1 - b.prodTicksLeft / total));
}

/**
 * What the ground inside a gatherer's reach still holds, for the card that
 * reports it: the loads its worker can actually fetch, and — separately —
 * the loads standing in the square that he cannot get to at all. Both
 * undefined for everything that doesn't work the land.
 *
 * Two numbers because they ask the player for different moves, and because
 * one number told a lie. This used to be `countResourceNear` alone, which
 * counts the ground and never asks whether a worker can walk to it, so a
 * quarry whose last rock was ringed by its own grove read "in reach: 10"
 * for the eight minutes it stood dead — the one readout the player had,
 * saying the hut was fine. A hut that has run out of ground wants selling;
 * a hut walled in by a grove wants the grove felled, and gets its trips
 * back for free when that happens. The card can only tell those apart if
 * the snapshot does.
 *
 * Cheap enough to run per snapshot: one bounded flood plus a few hundred
 * tile reads per gatherer, a few times a second. Both numbers are stable —
 * they move only when a tile is worked, a grove grows back, or something
 * opens or closes a way through — so putting them in the roster does not
 * make an idle village ship its buildings every frame.
 */
function reachStock(
  world: World,
  b: Building,
): {resourceLeft?: number; resourceBlocked?: number} {
  const def = buildingDef(b.type);
  const gather = gatherRecipeOf(def);
  if (!gather) return {};
  const origin = gatherOrigin(def, b.x, b.y);
  const standing = countResourceNear(
    world.map,
    origin.x,
    origin.y,
    gather.resource,
    gather.radius,
  );
  const left = countWorkableResourceNear(
    world.map,
    origin.x,
    origin.y,
    b,
    gather.resource,
    gather.radius,
  );
  // Absent rather than zero when nothing is shut out: the roster ships on
  // its serialized body changing, and a field that is always present is a
  // field always in the diff.
  const blocked = standing - left;
  return blocked > 0
    ? {resourceLeft: left, resourceBlocked: blocked}
    : {resourceLeft: left};
}

/**
 * When the oldest unclaimed pickup FROM this building was booked, for the
 * card's hauler-starvation line. Open phase only, blocked or not — a job
 * with a serf walking is being answered, and either kind of open job is a
 * load sitting here that nobody has come for. Jobs TO the building are
 * its suppliers' story and stay out of it. A stable tick, not an age:
 * this value only moves when the oldest open job itself does, so a
 * standing wait does not re-serialize the whole roster every structural
 * frame (see BuildingSnap.outWaitingSince). The scan is world.jobs whole,
 * per building; a village runs dozens of jobs, so the pass costs far
 * less than the tile square reachStock walks above.
 */
function outWaitingSinceOf(world: World, b: Building): number | undefined {
  let oldest: number | undefined;
  for (const j of world.jobs.values()) {
    if (j.from !== b.id || j.phase !== HaulPhase.open) continue;
    if (oldest === undefined || j.createdTick < oldest) oldest = j.createdTick;
  }
  return oldest;
}

/**
 * Types already complained about, so the line is printed once rather than
 * four times a second for as long as the building stands.
 *
 * Once per PROCESS, not per match, and the difference is worth stating
 * because this module is the server's too (see the header): a long-lived
 * node process serving match after match says it the first time it meets
 * the type and never again. That is the right lifetime — the same unknown
 * type in a second match is the same news, and a server repeating itself
 * every game is the noise this set exists to stop — but an operator
 * grepping the logs for a second match's copy should know there isn't one.
 */
const undescribed = new Set<number>();

/**
 * Can this build say what that building IS?
 *
 * Everything below reads its answers out of BUILDING_DEFS — the beds a
 * house holds, whether a hut is a storehouse, what a post forges — and a
 * building whose type has no entry there answers none of them. That is not
 * hypothetical: a save carries raw type numbers, so a village saved by a
 * build that knew one more building than this one hands exactly that.
 *
 * The whole structural frame is the stake. It is the only channel the HUD
 * has for the building roster, the players, stock, techs, research, the
 * events, the outcome and the selected building's card — and it is posted
 * only when something changes, so a frame lost is never re-sent. One
 * undescribable building used to throw out of these passes and take every
 * one of those with it, permanently, while the units carried on walking
 * about on the SAB: a HUD frozen mid-match with no word of why. Dropping
 * the one building this build cannot speak for is the far smaller wrong.
 */
function describable(b: Building): boolean {
  // Widened on purpose. buildingDef's signature promises a def always
  // comes back; the table behind it does not, and returns undefined for a
  // number no BUILDING_DEFS entry answers to — which is the whole case
  // this guard exists for. Against the narrow type the test below reads as
  // dead code, and a type-aware lint may one day agree and say so; naming
  // the wider type here is what keeps it the runtime question it is.
  const def: BuildingDef | undefined = buildingDef(b.type);
  if (def !== undefined) return true;
  if (!undescribed.has(b.type)) {
    undescribed.add(b.type);
    console.error(
      `[snapshot] no definition for building type ${b.type}; leaving it out ` +
        'of the roster. A save from a newer build?',
    );
  }
  return false;
}

export function snapBuildings(world: World): BuildingSnap[] {
  const out: BuildingSnap[] = [];
  for (const b of world.buildings.values()) {
    if (!b.dead && describable(b)) out.push(snapBuilding(world, b));
  }
  return out;
}

export function snapPlayers(world: World): PlayerSnap[] {
  // One pass over the buildings gathers each owner's first built storehouse
  // (same first-in-map-order pick as findStorehouse), abbey presence,
  // standing beds and open tool wants, instead of a full building scan per
  // player.
  const storehouses = new Map<Owner, Building>();
  const abbeyOwners = new Set<Owner>();
  const beds = new Map<Owner, number>();
  const toolWants = new Map<Owner, GoodAmounts>();
  const wantTool = (owner: Owner, tool: GoodId): void => {
    let w = toolWants.get(owner);
    if (!w) toolWants.set(owner, (w = {}));
    w[tool] = (w[tool] ?? 0) + 1;
  };
  // Heads: the units are one pass below, but two kinds of people are not
  // units any more and can only be counted from the building that holds
  // them — a tower's garrison and a recruit the barracks has started on.
  // The sim's hire gate (populationOf) counts both. A readout that left
  // them out showed 18/20 over a castle that refused every hire, because
  // the two archers up the tower were the two missing heads.
  const heads = new Map<Owner, number>();
  for (const b of world.buildings.values()) {
    if (b.dead) continue;
    // Heads first, ahead of the describable gate, because counting them
    // needs no definition: a garrison and a started recruit are plain
    // fields on the building. Behind the gate they went missing exactly
    // where this build is least able to afford it — a save from a newer
    // build whose unknown building happens to hold men (a trainer, say,
    // which is what an unknown 2x2 with a rally flag usually is) would
    // report a population below the sim's own, since populationOf counts
    // them either way. That is the same disagreement the note above
    // records being fixed once already, and it ends with the castle
    // offering a hire the sim then refuses.
    let held = b.garrison ?? 0;
    if (b.trainQueue) {
      for (const item of b.trainQueue) if (item.started) held++;
    }
    if (held) heads.set(b.owner, (heads.get(b.owner) ?? 0) + held);
    // Everything below reads BUILDING_DEFS, so it is the gate's business.
    if (!describable(b)) continue;
    if (b.state === BuildingState.site) {
      // A site still owed its borrowed hammer counts as a hammer want.
      if (
        !b.paused &&
        (b.siteNeeds?.[GoodId.hammer] ?? 0) > 0 &&
        (b.inbound[GoodId.hammer] ?? 0) === 0
      ) {
        wantTool(b.owner, GoodId.hammer);
      }
      continue;
    }
    if (b.state !== BuildingState.built) continue;
    if (b.type === BuildingTypeId.abbey) abbeyOwners.add(b.owner);
    if (!storehouses.has(b.owner) && buildingDef(b.type).storage)
      storehouses.set(b.owner, b);
    const housing = buildingDef(b.type).housing;
    if (housing) beds.set(b.owner, (beds.get(b.owner) ?? 0) + housing);
    // An open post whose tool is neither on its rack nor on the road.
    const tool = TOOL_OF[b.type];
    if (
      tool &&
      !b.paused &&
      (b.inputs[tool] ?? 0) + (b.inbound[tool] ?? 0) === 0
    ) {
      const worker =
        b.workerId !== undefined ? world.units.get(b.workerId) : undefined;
      if (!worker || worker.dead) wantTool(b.owner, tool);
    }
  }
  // ...and one over the units for the rest of the heads. Bandits own no
  // seat, so their raiders never land in the map.
  for (const u of world.units.values()) {
    if (!u.dead) heads.set(u.owner, (heads.get(u.owner) ?? 0) + 1);
  }
  return world.players.map(p => {
    const storehouse = storehouses.get(p.id);
    const hasAbbey = abbeyOwners.has(p.id);
    // The study's outstanding bill, while it has one — undefined once the
    // books are open, and undefined too when the Abbey holding it can no
    // longer be read (see below).
    const billAbbey = p.techs.active?.started
      ? undefined
      : world.buildings.get(p.techs.active?.abbey ?? -1);
    // Gone means what researchSystem means by it, dead roofs included: a
    // destroyed building stays in the map with its fields on it, and the
    // bill written on one is a bill nobody is carrying to anywhere.
    const bill =
      billAbbey && !billAbbey.dead && billAbbey.state === BuildingState.built
        ? billAbbey.researchNeeds
        : undefined;
    return {
      id: p.id,
      kind: p.kind,
      alive: p.alive,
      ...(p.strategy !== undefined ? {strategy: p.strategy} : {}),
      ...(p.difficulty !== undefined ? {difficulty: p.difficulty} : {}),
      stock: storehouse ? {...storehouse.stock} : {},
      toolWants: toolWants.get(p.id) ?? {},
      pop: heads.get(p.id) ?? 0,
      popCap: beds.get(p.id) ?? 0,
      techs: {
        researched: [...p.techs.researched],
        active: p.techs.active
          ? {
              tech: p.techs.active.tech,
              ticksLeft: p.techs.active.ticksLeft,
              totalTicks: TECH_DEFS[p.techs.active.tech].durationTicks,
              started: p.techs.active.started,
              // What the Abbey is still owed, while it is still owed
              // anything: the panel counts the study's progress in loads
              // before it counts it in ticks.
              //
              // Absent rather than empty when the bill cannot be read at
              // all — the Abbey went down this tick and researchSystem has
              // not yet dropped the order (it runs early; see
              // settleResearchBill). An empty bill means "nothing left to
              // carry", which is the one thing this is not: nothing is
              // KNOWN, and a reader that spread `{}` would draw the study
              // as fully delivered on the frame its roof fell in.
              ...(bill ? {needs: {...bill}} : {}),
            }
          : undefined,
        festivalTicksLeft: p.techs.festivalTicksLeft,
        pavingUnlocked: p.pavingUnlocked,
        hasAbbey,
      },
    };
  });
}

/** Debug-overlay rows. `owner` is undefined = every job (single player). */
export function snapJobs(world: World, owner?: number): JobSnap[] {
  const out: JobSnap[] = [];
  for (const j of world.jobs.values()) {
    if (owner !== undefined && j.owner !== owner) continue;
    out.push({
      id: j.id,
      good: j.good,
      from: j.from,
      to: j.to,
      priority: j.priority,
      phase: j.phase,
      serfId: j.serfId,
      age: world.tick - j.createdTick,
    });
  }
  return out;
}

/**
 * The building a hauler is standing at, winding a good up out of it — the
 * well and nothing else, today. Undefined for everyone else, which is the
 * whole population bar one or two serfs at any moment.
 */
function drawingAt(w: World, u: Unit): Building | undefined {
  if (u.task.t !== UnitTaskKind.haul || u.jobId === undefined) return undefined;
  const job = w.jobs.get(u.jobId);
  if (!job || job.phase !== HaulPhase.toPickup || job.drawUntil === undefined)
    return undefined;
  if (w.tick >= job.drawUntil) return undefined;
  return w.buildings.get(job.from);
}

/**
 * Where a unit's target stands, but only while it is genuinely being fought:
 * alive, and inside the weapon reach the combat system strikes at. Undefined
 * otherwise.
 *
 * Holding a `targetId` is not the same as fighting. A squad right-clicked
 * onto the bandit camp is given the camp as its target on the spot and keeps
 * it for the whole march; a chaser keeps its quarry while running it down;
 * one whose path is blocked keeps a target it can't reach. Animating on the
 * id alone put every one of them into an attack swing at empty ground the
 * moment they stopped walking — the renderer only masks it while the unit is
 * visibly moving.
 */
function engagedTarget(w: World, u: Unit): {x: number; y: number} | undefined {
  const combat = UNIT_DEFS[u.kind].combat;
  if (!combat || u.targetId === undefined) return undefined;
  if (u.targetIsBuilding) {
    const b = w.buildings.get(u.targetId);
    if (!b || b.dead) return undefined;
    // Reach to the footprint, not the center — a besieger stands at the wall.
    if (distToFootprint(u, b.x, b.y, b.w, b.h) > Math.max(combat.range, 1.4))
      return undefined;
    return centerOf(b);
  }
  const t = w.units.get(u.targetId);
  if (!t || t.dead) return undefined;
  if (exactDist(t.x - u.x, t.y - u.y) > combat.range) return undefined;
  return {x: t.x, y: t.y};
}

/**
 * Bearing from a unit to what it is hitting, quantized to a byte over a full
 * turn. A stationary unit's yaw is otherwise frozen at whatever direction it
 * last walked in, so fighters swung and loosed arrows facing away from the
 * enemy they were killing.
 */
function facingByte(u: Unit, at: {x: number; y: number}): number {
  // atan2(dx, dy) is the renderer's yaw convention (x east, y south).
  const turns = Math.atan2(at.x - u.x, at.y - u.y) / (Math.PI * 2);
  return Math.round((turns - Math.floor(turns)) * 256) & 255;
}

/**
 * Range to what it is hitting, quantized to eighth-tiles and held off zero
 * — 0 is the wire's "no target", and a melee fighter standing on its victim
 * is still engaged. An eighth of a tile is finer than the error the facing
 * byte's 1.4° steps put on the same point at any weapon range, so bearing
 * plus this reconstructs where the target stands as well as either byte
 * allows. What the renderer flies an archer's arrow to.
 */
function targetDistByte(u: Unit, at: {x: number; y: number}): number {
  const d = Math.round(exactDist(at.x - u.x, at.y - u.y) * 8);
  return Math.max(1, Math.min(255, d));
}

/** What is this unit visibly doing? Drives limb animation in the renderer. */
function actionOf(w: World, u: Unit, engaged: boolean): number {
  if (u.dead) return ACTION.dead;
  // Engaged fighters swing (the renderer overrides with a walk while moving).
  if (engaged) return ACTION.fight;
  // Holding ground with nobody in reach: idle to the renderer, a stance to
  // the selection card (see ACTION in sabLayout.ts).
  if (u.task.t === UnitTaskKind.hold) return ACTION.hold;
  // Gather workers swinging at a resource tile.
  if (u.task.t === UnitTaskKind.gatherWork) return ACTION.work;
  // A hauler on the well's windlass. The well keeps no resident, so this is
  // the only way anyone is ever seen drawing.
  if (drawingAt(w, u) !== undefined) return ACTION.work;
  // Resident workers: builders hammering up their site once materials are
  // in, or convert-building staff mid-batch (hoeing, hammering...).
  if (u.homeId !== undefined && u.task.t === UnitTaskKind.idle) {
    const home = w.buildings.get(u.homeId);
    if (home && !home.dead) {
      if (home.state === BuildingState.site) {
        const waiting = GOODS.some(g => ((home.siteNeeds ?? {})[g] ?? 0) > 0);
        return waiting ? ACTION.idle : ACTION.work;
      }
      if (home.prodTicksLeft !== undefined) return ACTION.work;
    }
  }
  return ACTION.idle;
}

/** Workplace flavor for profession-dressed worker bodies (the farmer's straw hat). */
function professionOf(w: World, u: Unit): number {
  if (u.kind !== UnitTypeId.worker || u.homeId === undefined)
    return PROFESSION.none;
  const home = w.buildings.get(u.homeId);
  if (!home || home.dead) return PROFESSION.none;
  // The look comes with the job, not the job offer: a builder raising his
  // own future farm stays a plain laborer until the roof is on — the
  // straw hat goes on when farming starts.
  if (home.state !== BuildingState.built) return PROFESSION.none;
  if (home.type === BuildingTypeId.wheatFarm) return PROFESSION.farmer;
  if (
    home.type === BuildingTypeId.quarry ||
    home.type === BuildingTypeId.ironMine ||
    home.type === BuildingTypeId.silverMine ||
    home.type === BuildingTypeId.goldMine
  ) {
    return PROFESSION.miner;
  }
  return PROFESSION.none;
}

/** Which tool animation fits this unit's work site? */
function workKindOf(w: World, u: Unit): number {
  // A hauler mid-draw has no post; the building it is standing at is what
  // says which animation to play.
  if (drawingAt(w, u)?.type === BuildingTypeId.well) return WORK.draw;
  const home = u.homeId !== undefined ? w.buildings.get(u.homeId) : undefined;
  if (!home) return WORK.tend;
  if (home.state === BuildingState.site) return WORK.hammer; // builder at the frame
  const def = buildingDef(home.type);
  if (def.recipe?.kind === RecipeKind.gather) {
    return def.recipe.resource === TileResource.Wood ? WORK.chop : WORK.pickaxe;
  }
  if (home.type === BuildingTypeId.weaponsmith) return WORK.hammer;
  if (home.type === BuildingTypeId.wheatFarm) return WORK.mow; // scythe in the rows
  if (home.type === BuildingTypeId.well) return WORK.draw; // cranking the bucket up
  if (home.type === BuildingTypeId.fishery) return WORK.fish; // pole out on the pier
  return WORK.tend;
}

/**
 * The BUFF bits a unit wears: the festival, for every living unit whose
 * owner is holding one — the serfs and workers it speeds as much as the
 * soldiers, so a village under one reads as a village under one. Bandits
 * have no player entry and so no festival, and the lookup says so rather
 * than indexing past the seats with their raw owner byte.
 */
function buffsOf(w: World, u: Unit, action: number): number {
  if (action === ACTION.dead) return 0;
  return (w.players[u.owner]?.techs.festivalTicksLeft ?? 0) > 0
    ? BUFF.festival
    : 0;
}

export function* unitSnapshots(w: World): Generator<UnitSnapshot> {
  for (const u of w.units.values()) {
    // Combat corpses (deathTick set) stay visible for the death animation;
    // other dead units (barracks consumption) vanish immediately.
    if (u.dead && u.deathTick === undefined) continue;
    const engaged = u.dead ? undefined : engagedTarget(w, u);
    const action = actionOf(w, u, engaged !== undefined);
    yield {
      id: u.id,
      x: u.x,
      y: u.y,
      kind: u.kind,
      owner: u.owner, // numeric owner rides the aux byte raw
      // Against the man's own full health, not his kind's: armour research
      // musters a knight at 120 where the kind says 80, and dividing by the
      // kind left him reading untouched down to his last two thirds.
      hpPct:
        action === ACTION.dead
          ? 0
          : Math.max(0, Math.min(255, Math.round((u.hp / u.maxHp) * 255))),
      // ...and the maximum itself, so a card can name the pair.
      maxHp: Math.min(255, Math.round(u.maxHp)),
      carrying: action === ACTION.dead ? 0 : carryingCode(u.carrying),
      action,
      // Published whenever the unit has a post, not just mid-swing: the
      // renderer keeps the axe in the woodcutter's fist on the walk out
      // to the trees (goods occupy the hands on the walk back).
      workKind:
        action === ACTION.work || u.homeId !== undefined
          ? workKindOf(w, u)
          : WORK.none,
      profession: professionOf(w, u),
      facing: engaged ? facingByte(u, engaged) : 0,
      targetDist: engaged ? targetDistByte(u, engaged) : 0,
      buffs: buffsOf(w, u, action),
    };
  }
}
