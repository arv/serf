/// <reference lib="webworker" />
import { createWorld, type World } from '../sim/world';
import { deserializeWorld, serializeWorld } from '../sim/save';
import { tickWorld } from '../sim/tick';
import { OWNER_CODE, UNIT_DEFS, carryingCode } from '../sim/defs/units';
import { MATCHER_INTERVAL } from '../sim/defs/balance';
import { buildingDef } from '../sim/defs/buildings';
import { TECH_DEFS } from '../sim/defs/techs';
import { checkInvariants, checkLedger, countGoods } from '../sim/debug/invariants';
import { findStorehouse } from '../sim/systems/logistics';
import { GOODS, type GoodAmounts } from '../sim/defs/goods';
import type { SimCommand } from '../sim/commands';
import {
  ACTION,
  PROFESSION,
  PUBLISH_INTERVAL_MS,
  SAB_BYTES,
  SabWriter,
  WORK,
  type UnitSnapshot,
} from '../protocol/sabLayout';
import type { Building } from '../sim/entities';
import type { Unit } from '../sim/units';
import type { BuildingSnap, MainToWorker, WorkerToMain } from '../protocol/messages';

/**
 * Worker entry: owns the World and the fixed-timestep loop. Publishes unit
 * state to the SAB once per interval; structural state goes over postMessage
 * every few ticks.
 */

let world: World | null = null;
let writer: SabWriter | null = null;
let speed = 1; // ticks per interval; 0 = paused
let pendingCommands: SimCommand[] = [];
let initialGoods: GoodAmounts = {};
let lastInvariantViolations: string[] = [];

const post = (msg: WorkerToMain): void => {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
};

self.onmessage = (e: MessageEvent<MainToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      init(msg.seed, msg.loadData);
      break;
    case 'commands':
      pendingCommands.push(...msg.commands);
      break;
    case 'setSpeed':
      speed = msg.speed;
      break;
    case 'requestSave':
      if (world) post({ type: 'saved', data: serializeWorld(world) });
      break;
  }
};

function snapBuilding(b: Building): BuildingSnap {
  const def = buildingDef(b.type);
  let staffing: BuildingSnap['staffing'];
  const wantsStaff =
    b.state === 'built' ? def.workerKind !== undefined : b.state === 'site' && !def.isRoad;
  if (wantsStaff) {
    const worker = b.workerId !== undefined ? world?.units.get(b.workerId) : undefined;
    staffing = worker && !worker.dead ? 'staffed' : b.recruitId !== undefined ? 'recruiting' : 'needed';
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
      b.state === 'site' && def.buildTicks > 0
        ? (b.buildProgress ?? 0) / def.buildTicks
        : undefined,
    stock: { ...b.stock },
    inputs: { ...b.inputs },
    inbound: { ...b.inbound },
    reservedOut: { ...b.reservedOut },
    trainQueue: b.trainQueue?.map((q) => ({ unit: q.unit, started: q.started })),
  };
}

function init(seed: number, loadData?: string): void {
  world = loadData !== undefined ? deserializeWorld(loadData) : createWorld(seed);
  initialGoods = countGoods(world);
  const sab = new SharedArrayBuffer(SAB_BYTES);
  writer = new SabWriter(sab);

  post({
    type: 'ready',
    sab,
    map: {
      terrain: world.map.terrain.slice(),
      resource: world.map.resource.slice(),
      blocked: world.map.blocked.slice(),
      buildingAt: world.map.buildingAt.slice(),
      pathLevel: world.map.pathLevel.slice(),
      height: world.map.height.slice(),
    },
    buildings: [...world.buildings.values()].map(snapBuilding),
  });

  publish();
  postStructural();
  // Dedicated-worker timers are not throttled like main-thread timers, so a
  // plain interval keeps the sim running even when the tab is hidden.
  setInterval(step, PUBLISH_INTERVAL_MS);
}

function step(): void {
  if (!world || !writer) return;
  // While paused, commands stay queued and apply on unpause — the classic
  // "issue orders during pause" affordance.
  if (speed <= 0) return;
  const commands = pendingCommands;
  pendingCommands = [];
  for (let i = 0; i < speed; i++) {
    tickWorld(world, i === 0 ? commands : []);
    if (import.meta.env.DEV && world.tick % 20 === 0) {
      const report = checkInvariants(world);
      const ledger = checkLedger(world, initialGoods);
      lastInvariantViolations = [...report.violations, ...ledger];
      for (const v of lastInvariantViolations) console.warn(`[invariant] t${world.tick} ${v}`);
    }
  }
  publish();
  if (world.tick % MATCHER_INTERVAL === 0 || world.pendingDeltas.length > 0) {
    postStructural();
  }
}

function postStructural(): void {
  if (!world) return;
  const storehouse = findStorehouse(world);
  let hasTerakoya = false;
  for (const b of world.buildings.values()) {
    if (!b.dead && b.type === 'terakoya' && b.state === 'built') hasTerakoya = true;
  }
  post({
    type: 'structural',
    tick: world.tick,
    buildings: [...world.buildings.values()].filter((b) => !b.dead).map(snapBuilding),
    mapDeltas: world.pendingDeltas.splice(0),
    stock: storehouse ? { ...storehouse.stock } : {},
    admin: { ...world.admin },
    events: world.pendingEvents.splice(0),
    outcome: world.outcome,
    techs: {
      researched: [...world.techs.researched],
      active: world.techs.active
        ? {
            tech: world.techs.active.tech,
            ticksLeft: world.techs.active.ticksLeft,
            totalTicks: TECH_DEFS[world.techs.active.tech].durationTicks,
          }
        : undefined,
      festivalTicksLeft: world.techs.festivalTicksLeft,
      pavingUnlocked: world.pavingUnlocked,
      hasTerakoya,
    },
    jobs: [...world.jobs.values()].map((j) => ({
      id: j.id,
      good: j.good,
      from: j.from,
      to: j.to,
      priority: j.priority,
      phase: j.phase,
      serfId: j.serfId,
      age: world!.tick - j.createdTick,
    })),
    invariantViolations: lastInvariantViolations,
  });
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

/** Which tool animation fits this unit's work site? */
/** Workplace flavor for themed worker bodies (the farmer's straw hat). */
function professionOf(w: World, u: Unit): number {
  if (u.kind !== 'worker' || u.homeId === undefined) return PROFESSION.none;
  const home = w.buildings.get(u.homeId);
  if (!home || home.dead) return PROFESSION.none;
  if (home.type === 'ricePaddy') return PROFESSION.farmer;
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

function workKindOf(w: World, u: Unit): number {
  const home = u.homeId !== undefined ? w.buildings.get(u.homeId) : undefined;
  if (!home) return WORK.tend;
  if (home.state === 'site') return WORK.hammer; // builder at the frame
  const def = buildingDef(home.type);
  if (def.recipe?.kind === 'gather') {
    return def.recipe.resource === 'bamboo' ? WORK.chop : WORK.pickaxe;
  }
  if (home.type === 'swordsmith' || home.type === 'spearmaker' || home.type === 'bowyer') {
    return WORK.hammer;
  }
  if (home.type === 'ricePaddy') return WORK.dig;
  if (home.type === 'well') return WORK.draw; // cranking the bucket up
  return WORK.tend;
}

function* unitSnapshots(w: World): Generator<UnitSnapshot> {
  for (const u of w.units.values()) {
    // Combat corpses (deathTick set) stay visible for the death animation;
    // other dead units (dojo consumption) vanish immediately.
    if (u.dead && u.deathTick === undefined) continue;
    const action = actionOf(w, u);
    yield {
      id: u.id,
      x: u.x,
      y: u.y,
      kind: UNIT_DEFS[u.kind].kindCode,
      owner: OWNER_CODE[u.owner],
      hpPct:
        action === ACTION.dead
          ? 0
          : Math.max(0, Math.min(255, Math.round((u.hp / UNIT_DEFS[u.kind].hp) * 255))),
      carrying: action === ACTION.dead ? 0 : carryingCode(u.carrying),
      action,
      workKind: action === ACTION.work ? workKindOf(w, u) : WORK.none,
      profession: professionOf(w, u),
    };
  }
}

function publish(): void {
  if (!world || !writer) return;
  writer.publish(unitSnapshots(world));
}
