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
import type { MainToWorker, StructuralUpdate, WorkerToMain } from '../protocol/messages';

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
      // Pausing stopped the pump timer (see pump); waking restarts it.
      if (speed > 0) startPump();
      break;
    case 'setDebug':
      debugEnabled = msg.enabled;
      // Fill the overlay at once instead of waiting for the next matcher
      // interval to ship a structural frame.
      if (debugEnabled) postStructural();
      break;
    case 'setHidden':
      // Backgrounded: freeze the world where it stands. The timer goes too —
      // not just the ticks — so the worker stops waking the CPU 100 times a
      // second for nothing. `speed` is untouched: coming back resumes at
      // whatever rate the player had chosen, with no time having passed.
      hidden = msg.hidden;
      if (hidden) stopPump();
      else startPump();
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
  startPump();
}

let lastPump = 0;
let acc = 0;
/** Cap on banked time, so a long stall catches up rather than stampeding. */
const MAX_CATCHUP_QUANTA = 10;
/** Page hidden (main thread's report): the sim holds still, timer stopped. */
let hidden = false;
let pumpTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Dedicated-worker timers are not throttled like main-thread timers, so a
 * plain interval drives the sim at full rate however the page is displayed —
 * until the main thread says it isn't displayed at all, and the timer stops
 * outright (see 'setHidden'). The accumulator carries the remainder, so the
 * loop never quantises to whatever the timer actually did — which is what
 * lets the interval run at half a tick rather than finer: frequent timer
 * wakeups are exactly the thing that keeps a phone's CPU out of its deep
 * idle states, and 100 wakes a second for a 20 Hz sim bought only command
 * latency nobody could feel below half a tick anyway. Starting always
 * resets the clock and drops banked time: a resume continues, it does not
 * catch up.
 */
function startPump(): void {
  if (pumpTimer !== null || hidden || !world) return;
  lastPump = performance.now();
  acc = 0;
  pumpTimer = setInterval(pump, TICK_MS / 2);
}

function stopPump(): void {
  if (pumpTimer === null) return;
  clearInterval(pumpTimer);
  pumpTimer = null;
}

function pump(): void {
  if (!world || !writer) return;
  const now = performance.now();
  acc = Math.min(acc + (now - lastPump), TICK_MS * MAX_CATCHUP_QUANTA);
  lastPump = now;
  // While paused, commands stay queued and apply on unpause — the classic
  // "issue orders during pause" affordance. Banked time is dropped, and so
  // is the timer itself: nothing can happen until setSpeed restarts it, so
  // ticking an interval just to return here would be wakeups for nothing.
  if (speed <= 0) {
    acc = 0;
    stopPump();
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

/** Each roster as last posted, stringified — how an unchanged section is
 * recognized and left out of the frame (see postStructural). */
let lastBuildingsBody = '';
let lastPlayersBody = '';
let lastMiscBody = '';

function postStructural(): void {
  if (!world) return;
  // A village changes its rosters far less often than the struct cadence,
  // yet each full frame made the main thread — the battery-relevant one —
  // rebuild its building mirror, re-key the roster and republish the
  // selected building. So each section ships only when it changed: deltas
  // and events are one-shot news and always do, and an entirely news-less
  // frame is not posted at all. (Stringifying to compare costs this worker
  // about what the structured clone would have.)
  const buildings = snapBuildings(world);
  const players = snapPlayers(world);
  const mapDeltas = world.pendingDeltas.splice(0);
  const events = world.pendingEvents.splice(0);
  // Every job while the debug overlay is open: there is nobody here to
  // hide the AI's logistics from, and watching them (ages ticking) is the
  // point — so an open overlay counts as news every interval. Closed (the
  // normal case), serializing them at 4 Hz is waste.
  const jobs = debugEnabled ? snapJobs(world) : undefined;
  const buildingsBody = JSON.stringify(buildings);
  const playersBody = JSON.stringify(players);
  const miscBody = JSON.stringify([world.admin, world.outcome, lastInvariantViolations]);
  const buildingsChanged = buildingsBody !== lastBuildingsBody;
  const playersChanged = playersBody !== lastPlayersBody;
  const miscChanged = miscBody !== lastMiscBody;
  if (
    mapDeltas.length === 0 &&
    events.length === 0 &&
    !buildingsChanged &&
    !playersChanged &&
    !miscChanged &&
    jobs === undefined
  ) {
    return;
  }
  lastBuildingsBody = buildingsBody;
  lastPlayersBody = playersBody;
  lastMiscBody = miscBody;
  const msg: StructuralUpdate = {
    type: 'structural',
    tick: world.tick,
    mapDeltas,
    admin: { ...world.admin },
    events,
    outcome: world.outcome,
    invariantViolations: lastInvariantViolations,
    ...(buildingsChanged ? { buildings } : {}),
    ...(playersChanged ? { players } : {}),
    ...(jobs ? { jobs } : {}),
  };
  post(msg);
}

function publish(): void {
  if (!world || !writer) return;
  writer.publish(unitSnapshots(world));
}
