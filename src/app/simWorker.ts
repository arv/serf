/// <reference lib="webworker" />
import { createWorld, type World } from '../sim/world';
import { deserializeWorld, serializeWorld } from '../sim/save';
import { tickWorld } from '../sim/tick';
import { MATCHER_INTERVAL, TICK_MS } from '../sim/defs/balance';
import { checkInvariants, checkLedger, countGoods } from '../sim/debug/invariants';
import { AiSeats } from '../sim/aiSeats';
import { SAB_BYTES, SabWriter } from '../protocol/sabLayout';
import { snapBuildings, snapJobs, snapPlayers, unitSnapshots } from '../protocol/snapshot';
import type { GoodAmounts } from '../sim/defs/goods';
import type { PlayerCommand } from '../sim/tick';
import type { MainToWorker, WorkerToMain } from '../protocol/messages';

/**
 * Single player: owns the World and the fixed-timestep loop, publishes unit
 * state to the SAB and structural state over postMessage.
 *
 * Multiplayer does not come through here at all — the server owns that
 * world and netWorker.ts renders what it sends. The two speak the same
 * worker protocol, so nothing downstream can tell them apart.
 */

let world: World | null = null;
let writer: SabWriter | null = null;
let speed = 1; // ticks per interval; 0 = paused
let pendingCommands: PlayerCommand[] = [];
let initialGoods: GoodAmounts = {};
let lastInvariantViolations: string[] = [];
let ai: AiSeats | null = null;
/** Debug overlay open on the main thread — only then serialize jobs. */
let debugEnabled = false;

const post = (msg: WorkerToMain): void => {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
};

self.onmessage = (e: MessageEvent<MainToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      init(msg.config, msg.loadData);
      break;
    case 'commands':
      pendingCommands.push(...msg.commands);
      break;
    case 'setSpeed':
      speed = msg.speed;
      break;
    case 'setDebug':
      debugEnabled = msg.enabled;
      // Fill the overlay at once instead of waiting for the next matcher
      // interval to ship a structural frame.
      if (debugEnabled) postStructural();
      break;
    case 'requestSave':
      if (world) post({ type: 'saved', data: serializeWorld(world) });
      break;
  }
};

function init(config: import('../sim/world').WorldConfig, loadData?: string): void {
  world = loadData !== undefined ? deserializeWorld(loadData) : createWorld(config);
  // AI seats think next to the world, the same way the server runs them.
  ai = new AiSeats(world);
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
    buildings: snapBuildings(world),
  });

  publish();
  postStructural();
  // Dedicated-worker timers are not throttled like main-thread timers, so a
  // plain interval keeps the sim running even when the tab is hidden. The
  // pump is finer than the tick so an accumulator carries the remainder,
  // rather than the loop quantising to whatever the timer actually did.
  lastPump = performance.now();
  setInterval(pump, 10);
}

let lastPump = 0;
let acc = 0;
/** Cap on banked time, so a long stall catches up rather than stampeding. */
const MAX_CATCHUP_QUANTA = 10;

function pump(): void {
  if (!world || !writer) return;
  const now = performance.now();
  acc = Math.min(acc + (now - lastPump), TICK_MS * MAX_CATCHUP_QUANTA);
  lastPump = now;
  // While paused, commands stay queued and apply on unpause — the classic
  // "issue orders during pause" affordance. Banked time is dropped.
  if (speed <= 0) {
    acc = 0;
    return;
  }
  let ran = false;
  while (acc >= TICK_MS) {
    acc -= TICK_MS;
    // One 50ms quantum = `speed` ticks (0/1/3), commands on its first tick.
    const commands = pendingCommands;
    pendingCommands = [];
    for (let i = 0; i < speed; i++) {
      const executed = i === 0 ? commands : [];
      // Brains decide from the state this tick starts in, and go in with
      // the player's orders — no frame of hindsight.
      if (ai) executed.push(...ai.decide(world));
      tickWorld(world, executed);
      if (import.meta.env.DEV && world.tick % 20 === 0) {
        const report = checkInvariants(world);
        const ledger = checkLedger(world, initialGoods);
        lastInvariantViolations = [...report.violations, ...ledger];
        for (const v of lastInvariantViolations) console.warn(`[invariant] t${world.tick} ${v}`);
      }
    }
    ran = true;
  }
  if (ran) {
    publish();
    if (world.tick % MATCHER_INTERVAL === 0 || world.pendingDeltas.length > 0) {
      postStructural();
    }
  }
}

function postStructural(): void {
  if (!world) return;
  post({
    type: 'structural',
    tick: world.tick,
    buildings: snapBuildings(world),
    mapDeltas: world.pendingDeltas.splice(0),
    players: snapPlayers(world),
    admin: { ...world.admin },
    events: world.pendingEvents.splice(0),
    outcome: world.outcome,
    // Every job while the debug overlay is open: there is nobody here to
    // hide the AI's logistics from, and watching them is the point of the
    // overlay. Closed (the normal case), serializing them at 4 Hz is waste.
    jobs: debugEnabled ? snapJobs(world) : [],
    invariantViolations: lastInvariantViolations,
  });
}

function publish(): void {
  if (!world || !writer) return;
  writer.publish(unitSnapshots(world));
}
