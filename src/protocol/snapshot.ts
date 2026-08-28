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
import { TOOL_OF, buildingDef, gatherOrigin, gatherRecipeOf } from '../sim/defs/buildings.ts';
import { HIRE_SERF_TICKS } from '../sim/defs/balance.ts';
import { TECH_DEFS } from '../sim/defs/techs.ts';
import { GOODS, type GoodAmounts } from '../sim/defs/goods.ts';
import { UNIT_DEFS, carryingCode } from '../sim/defs/units.ts';
import { ACTION, PROFESSION, WORK, type UnitSnapshot } from './sabLayout.ts';
import { centerOf } from '../sim/entities.ts';
import { countResourceNear } from '../sim/map.ts';
import { exactDist } from '../shared/math.ts';
import { distToFootprint } from '../sim/arrival.ts';
import type { World } from '../sim/world.ts';
import type { Building, Owner } from '../sim/entities.ts';
import type { Unit } from '../sim/units.ts';
import type { BuildingSnap, JobSnap, PlayerSnap } from './messages.ts';
import { GoodId } from '../sim/defs/goods.ts';
import { UnitTypeId } from '../sim/defs/units.ts';
import { BuildingTypeId } from '../sim/defs/buildings.ts';
import { BuildingState } from '../sim/entities.ts';
import { UnitTaskKind } from '../sim/units.ts';
import { HaulPhase } from '../sim/world.ts';
import { RecipeKind } from '../sim/defs/buildings.ts';
import { TileResource } from '../sim/map.ts';
import { StaffingState } from './messages.ts';

export function snapBuilding(world: World, b: Building): BuildingSnap {
  const def = buildingDef(b.type);
  let staffing: BuildingSnap['staffing'];
  // A paused post is not asking for anyone — pausing emptied it on purpose —
  // so it reports no staffing state rather than a false "needed" alarm.
  const wantsStaff =
    !b.paused &&
    (b.state === BuildingState.built ? def.workerKind !== undefined : b.state === BuildingState.site && !def.isRoad);
  if (wantsStaff) {
    const worker = b.workerId !== undefined ? world.units.get(b.workerId) : undefined;
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
    siteNeeds: b.siteNeeds ? { ...b.siteNeeds } : undefined,
    repairNeeds: b.repairNeeds ? { ...b.repairNeeds } : undefined,
    repairPending: b.repairPending,
    progress01:
      b.state === BuildingState.site && def.buildTicks > 0 ? (b.buildProgress ?? 0) / def.buildTicks : undefined,
    stock: { ...b.stock },
    inputs: { ...b.inputs },
    inbound: { ...b.inbound },
    reservedOut: { ...b.reservedOut },
    trainQueue: b.trainQueue?.map((q) => ({
      unit: q.unit,
      started: q.started,
      progress01: q.started
        ? 1 - q.ticksLeft / (def.trains?.find((o) => o.unit === q.unit)?.durationTicks ?? 1)
        : undefined,
    })),
    rally: b.rally ? { ...b.rally } : undefined,
    // A paused building keeps its half-done batch (prodTicksLeft freezes),
    // so the flag needs both: batch underway AND actually ticking.
    working: b.prodTicksLeft !== undefined && !b.paused ? true : undefined,
    paused: b.paused,
    recipeIndex: b.recipeIndex,
    prodRecipeIndex: b.prodRecipeIndex,
    forgeQueue: b.forgeQueue?.map((q) => ({ recipeIndex: q.recipeIndex, started: q.started })),
    garrison: def.garrison ? (b.garrison ?? 0) : undefined,
    garrisonCap: def.garrison?.capacity,
    levied: def.garrison && b.garrisonKind === def.garrison.levy.unit ? true : undefined,
    // On cooldown means it loosed within the last volley's worth of ticks,
    // which is exactly the window the roof should be drawing a bow in.
    firing: (b.attackCooldown ?? 0) > 0 ? true : undefined,
    resourceLeft: reachableResource(world, b),
    hireQueue: b.hireQueue,
    hireProgress01: b.hireQueue
      ? 1 - (b.hireTicksLeft ?? HIRE_SERF_TICKS) / HIRE_SERF_TICKS
      : undefined,
  };
}

/**
 * What the ground inside a gatherer's reach still holds, for the card that
 * reports it. Undefined for everything that doesn't work the land.
 *
 * Cheap enough to run per snapshot: a few hundred tile reads per gatherer,
 * a few times a second. It is also stable — a number that only moves when
 * a tile is worked or a grove grows back — so putting it in the roster does
 * not make an idle village ship its buildings every frame.
 */
function reachableResource(world: World, b: Building): number | undefined {
  const def = buildingDef(b.type);
  const gather = gatherRecipeOf(def);
  if (!gather) return undefined;
  const origin = gatherOrigin(def, b.x, b.y);
  return countResourceNear(
    world.map,
    origin.x,
    origin.y,
    gather.resource,
    gather.radius,
  );
}

export function snapBuildings(world: World): BuildingSnap[] {
  const out: BuildingSnap[] = [];
  for (const b of world.buildings.values()) {
    if (!b.dead) out.push(snapBuilding(world, b));
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
  for (const b of world.buildings.values()) {
    if (b.dead) continue;
    if (b.state === BuildingState.site) {
      // A site still owed its borrowed hammer counts as a hammer want.
      if (!b.paused && (b.siteNeeds?.[GoodId.hammer] ?? 0) > 0 && (b.inbound[GoodId.hammer] ?? 0) === 0) {
        wantTool(b.owner, GoodId.hammer);
      }
      continue;
    }
    if (b.state !== BuildingState.built) continue;
    if (b.type === BuildingTypeId.abbey) abbeyOwners.add(b.owner);
    if (!storehouses.has(b.owner) && buildingDef(b.type).storage) storehouses.set(b.owner, b);
    const housing = buildingDef(b.type).housing;
    if (housing) beds.set(b.owner, (beds.get(b.owner) ?? 0) + housing);
    // An open post whose tool is neither on its rack nor on the road.
    const tool = TOOL_OF[b.type];
    if (tool && !b.paused && (b.inputs[tool] ?? 0) + (b.inbound[tool] ?? 0) === 0) {
      const worker = b.workerId !== undefined ? world.units.get(b.workerId) : undefined;
      if (!worker || worker.dead) wantTool(b.owner, tool);
    }
  }
  // ...and one over the units for heads. Bandits own no seat, so their
  // raiders never land in the map.
  const heads = new Map<Owner, number>();
  for (const u of world.units.values()) {
    if (!u.dead) heads.set(u.owner, (heads.get(u.owner) ?? 0) + 1);
  }
  return world.players.map((p) => {
    const storehouse = storehouses.get(p.id);
    const hasAbbey = abbeyOwners.has(p.id);
    return {
      id: p.id,
      kind: p.kind,
      alive: p.alive,
      stock: storehouse ? { ...storehouse.stock } : {},
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
  if (!job || job.phase !== HaulPhase.toPickup || job.drawUntil === undefined) return undefined;
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
function engagedTarget(w: World, u: Unit): { x: number; y: number } | undefined {
  const combat = UNIT_DEFS[u.kind].combat;
  if (!combat || u.targetId === undefined) return undefined;
  if (u.targetIsBuilding) {
    const b = w.buildings.get(u.targetId);
    if (!b || b.dead) return undefined;
    // Reach to the footprint, not the center — a besieger stands at the wall.
    if (distToFootprint(u, b.x, b.y, b.w, b.h) > Math.max(combat.range, 1.4)) return undefined;
    return centerOf(b);
  }
  const t = w.units.get(u.targetId);
  if (!t || t.dead) return undefined;
  if (exactDist(t.x - u.x, t.y - u.y) > combat.range) return undefined;
  return { x: t.x, y: t.y };
}

/**
 * Bearing from a unit to what it is hitting, quantized to a byte over a full
 * turn. A stationary unit's yaw is otherwise frozen at whatever direction it
 * last walked in, so fighters swung and loosed arrows facing away from the
 * enemy they were killing.
 */
function facingByte(u: Unit, at: { x: number; y: number }): number {
  // atan2(dx, dy) is the renderer's yaw convention (x east, y south).
  const turns = Math.atan2(at.x - u.x, at.y - u.y) / (Math.PI * 2);
  return Math.round((turns - Math.floor(turns)) * 256) & 255;
}

/** What is this unit visibly doing? Drives limb animation in the renderer. */
function actionOf(w: World, u: Unit, engaged: boolean): number {
  if (u.dead) return ACTION.dead;
  // Engaged fighters swing (the renderer overrides with a walk while moving).
  if (engaged) return ACTION.fight;
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
        const waiting = GOODS.some((g) => ((home.siteNeeds ?? {})[g] ?? 0) > 0);
        return waiting ? ACTION.idle : ACTION.work;
      }
      if (home.prodTicksLeft !== undefined) return ACTION.work;
    }
  }
  return ACTION.idle;
}

/** Workplace flavor for profession-dressed worker bodies (the farmer's straw hat). */
function professionOf(w: World, u: Unit): number {
  if (u.kind !== UnitTypeId.worker || u.homeId === undefined) return PROFESSION.none;
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
  if (home.type === BuildingTypeId.wheatFarm) return WORK.dig;
  if (home.type === BuildingTypeId.well) return WORK.draw; // cranking the bucket up
  if (home.type === BuildingTypeId.fishery) return WORK.fish; // pole out on the pier
  return WORK.tend;
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
      hpPct:
        action === ACTION.dead
          ? 0
          : Math.max(0, Math.min(255, Math.round((u.hp / UNIT_DEFS[u.kind].hp) * 255))),
      carrying: action === ACTION.dead ? 0 : carryingCode(u.carrying),
      action,
      // Published whenever the unit has a post, not just mid-swing: the
      // renderer keeps the axe in the woodcutter's fist on the walk out
      // to the trees (goods occupy the hands on the walk back).
      workKind: action === ACTION.work || u.homeId !== undefined ? workKindOf(w, u) : WORK.none,
      profession: professionOf(w, u),
      facing: engaged ? facingByte(u, engaged) : 0,
    };
  }
}
