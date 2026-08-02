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
import { buildingDef } from '../sim/defs/buildings.ts';
import { HIRE_SERF_TICKS } from '../sim/defs/balance.ts';
import { TECH_DEFS } from '../sim/defs/techs.ts';
import { GOODS } from '../sim/defs/goods.ts';
import { UNIT_DEFS, carryingCode } from '../sim/defs/units.ts';
import { ACTION, PROFESSION, WORK, type UnitSnapshot } from './sabLayout.ts';
import type { World } from '../sim/world.ts';
import type { Building, Owner } from '../sim/entities.ts';
import type { Unit } from '../sim/units.ts';
import type { BuildingSnap, JobSnap, PlayerSnap } from './messages.ts';

export function snapBuilding(world: World, b: Building): BuildingSnap {
  const def = buildingDef(b.type);
  let staffing: BuildingSnap['staffing'];
  const wantsStaff =
    b.state === 'built' ? def.workerKind !== undefined : b.state === 'site' && !def.isRoad;
  if (wantsStaff) {
    const worker = b.workerId !== undefined ? world.units.get(b.workerId) : undefined;
    staffing =
      worker && !worker.dead ? 'staffed' : b.recruitId !== undefined ? 'recruiting' : 'needed';
  }
  return {
    staffing,
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
    progress01:
      b.state === 'site' && def.buildTicks > 0 ? (b.buildProgress ?? 0) / def.buildTicks : undefined,
    stock: { ...b.stock },
    inputs: { ...b.inputs },
    inbound: { ...b.inbound },
    reservedOut: { ...b.reservedOut },
    trainQueue: b.trainQueue?.map((q) => ({ unit: q.unit, started: q.started })),
    paused: b.paused,
    recipeIndex: b.recipeIndex,
    hireQueue: b.hireQueue,
    hireProgress01: b.hireQueue
      ? 1 - (b.hireTicksLeft ?? HIRE_SERF_TICKS) / HIRE_SERF_TICKS
      : undefined,
  };
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
  // (same first-in-map-order pick as findStorehouse) and abbey presence,
  // instead of a full building scan per player.
  const storehouses = new Map<Owner, Building>();
  const abbeyOwners = new Set<Owner>();
  for (const b of world.buildings.values()) {
    if (b.dead || b.state !== 'built') continue;
    if (b.type === 'abbey') abbeyOwners.add(b.owner);
    if (!storehouses.has(b.owner) && buildingDef(b.type).storage) storehouses.set(b.owner, b);
  }
  return world.players.map((p) => {
    const storehouse = storehouses.get(p.id);
    const hasAbbey = abbeyOwners.has(p.id);
    return {
      id: p.id,
      kind: p.kind,
      alive: p.alive,
      stock: storehouse ? { ...storehouse.stock } : {},
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

/** What is this unit visibly doing? Drives limb animation in the renderer. */
function actionOf(w: World, u: Unit): number {
  if (u.dead) return ACTION.dead;
  // Engaged fighters swing (the renderer overrides with a walk while moving).
  if (UNIT_DEFS[u.kind].combat && u.targetId !== undefined) return ACTION.fight;
  // Gather workers swinging at a resource tile.
  if (u.task.t === 'gatherWork') return ACTION.work;
  // Resident workers: builders hammering up their site once materials are
  // in, or convert-building staff mid-batch (hoeing, hammering...).
  if (u.homeId !== undefined && u.task.t === 'idle') {
    const home = w.buildings.get(u.homeId);
    if (home && !home.dead) {
      if (home.state === 'site') {
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
  if (u.kind !== 'worker' || u.homeId === undefined) return PROFESSION.none;
  const home = w.buildings.get(u.homeId);
  if (!home || home.dead) return PROFESSION.none;
  // The look comes with the job, not the job offer: a builder raising his
  // own future farm stays a plain laborer until the roof is on — the
  // straw hat goes on when farming starts.
  if (home.state !== 'built') return PROFESSION.none;
  if (home.type === 'wheatFarm') return PROFESSION.farmer;
  if (
    home.type === 'quarry' ||
    home.type === 'ironMine' ||
    home.type === 'silverMine' ||
    home.type === 'goldMine'
  ) {
    return PROFESSION.miner;
  }
  return PROFESSION.none;
}

/** Which tool animation fits this unit's work site? */
function workKindOf(w: World, u: Unit): number {
  const home = u.homeId !== undefined ? w.buildings.get(u.homeId) : undefined;
  if (!home) return WORK.tend;
  if (home.state === 'site') return WORK.hammer; // builder at the frame
  const def = buildingDef(home.type);
  if (def.recipe?.kind === 'gather') {
    return def.recipe.resource === 'wood' ? WORK.chop : WORK.pickaxe;
  }
  if (home.type === 'weaponsmith') return WORK.hammer;
  if (home.type === 'wheatFarm') return WORK.dig;
  if (home.type === 'well') return WORK.draw; // cranking the bucket up
  return WORK.tend;
}

export function* unitSnapshots(w: World): Generator<UnitSnapshot> {
  for (const u of w.units.values()) {
    // Combat corpses (deathTick set) stay visible for the death animation;
    // other dead units (barracks consumption) vanish immediately.
    if (u.dead && u.deathTick === undefined) continue;
    const action = actionOf(w, u);
    yield {
      id: u.id,
      x: u.x,
      y: u.y,
      kind: UNIT_DEFS[u.kind].kindCode,
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
    };
  }
}
