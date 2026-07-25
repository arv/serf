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
import type { GoodAmounts } from '../sim/defs/goods';
import type { SimCommand } from '../sim/commands';
import {
  PUBLISH_INTERVAL_MS,
  SAB_BYTES,
  SabWriter,
  type UnitSnapshot,
} from '../protocol/sabLayout';
import type { Building } from '../sim/entities';
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
  return {
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

function* unitSnapshots(w: World): Generator<UnitSnapshot> {
  for (const u of w.units.values()) {
    if (u.dead) continue;
    yield {
      id: u.id,
      x: u.x,
      y: u.y,
      kind: UNIT_DEFS[u.kind].kindCode,
      owner: OWNER_CODE[u.owner],
      hpPct: Math.max(0, Math.min(255, Math.round((u.hp / UNIT_DEFS[u.kind].hp) * 255))),
      carrying: carryingCode(u.carrying),
    };
  }
}

function publish(): void {
  if (!world || !writer) return;
  writer.publish(unitSnapshots(world));
}
