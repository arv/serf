/// <reference lib="webworker" />
import { createWorld, type World } from '../sim/world';
import { deserializeWorld, serializeWorld } from '../sim/save';
import { tickWorld } from '../sim/tick';
import { MATCHER_INTERVAL, TICK_MS } from '../sim/defs/balance';
import { checkInvariants, checkLedger, countGoods } from '../sim/debug/invariants';
import { AiSeats } from '../sim/aiSeats';
import { summarizeForSeat } from '../ai/summary';
import { SAB_BYTES, SabWriter } from '../protocol/sabLayout';
import { snapBuildings, snapJobs, snapPlayers, unitSnapshots } from '../protocol/snapshot';
import { REPLAY_FORMAT, serializeReplay, type ReplayData } from './replay';
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
/**
 * The LLM strategist's cadence (init asked with `llm`): when each AI seat
 * next reports upstairs. ~90 s apart per seat, staggered so two seats
 * never summarize on the same pump. Deliberately slow: inference runs on
 * the CPU and the strategist consults one seat at a time, so a faster
 * drumbeat would only queue summaries to be dropped — and posture advice
 * that arrives a minute later is still posture advice.
 */
const ADVICE_PERIOD = 1800;
const ADVICE_STAGGER = 600;
let summaryDue: Map<number, number> | null = null;

/**
 * The match's replay log, written as it happens. The sim being
 * deterministic, the log holds only what the sim cannot re-derive: the
 * config and save it booted from, the player's commands at the ticks they
 * applied, and any strategist advice at the ticks it landed. AI commands
 * are not stored — playback re-decides them from the identical world.
 * Always on for a live solo match (the cost is a few bytes per order);
 * null while *playing back* a replay.
 */
let recording: {
  config: ReplayData['config'];
  loadData?: string;
  commands: ReplayData['commands'];
  advice: ReplayData['advice'];
} | null = null;

/** Playback mode: the log being replayed, and cursors into its two lists. */
let replay: ReplayData | null = null;
let replayCmdIdx = 0;
let replayAdviceIdx = 0;
let replayEndedPosted = false;

const post = (msg: WorkerToMain): void => {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
};

self.onmessage = (e: MessageEvent<MainToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      init(msg.config, msg.loadData, msg.llm, msg.replay);
      break;
    case 'commands':
      // A replay's diet is the log, nothing else: a stray order clicked
      // during playback must not fork the recorded history.
      if (replay) break;
      pendingCommands.push(...msg.commands);
      break;
    case 'aiAdvice':
      if (replay) break;
      // Pre-validated on the main thread; the brain merges it over its
      // playbook and plays on. Reaches the sim only as ordinary commands.
      // Logged at the tick it lands: the strategist's answer is the one
      // inflow the sim cannot re-derive, so playback re-applies it here.
      if (world && recording) {
        recording.advice.push({ tick: world.tick, playerId: msg.playerId, override: msg.override });
      }
      ai?.applyAdvice(msg.playerId, msg.override);
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
    case 'requestReplay':
      if (world && recording) {
        post({
          type: 'replayData',
          data: serializeReplay({
            format: REPLAY_FORMAT,
            savedAt: new Date().toISOString(),
            config: recording.config,
            ...(recording.loadData !== undefined ? { loadData: recording.loadData } : {}),
            commands: recording.commands,
            advice: recording.advice,
            endTick: world.tick,
          }),
        });
      }
      break;
  }
};

function init(
  config: import('../sim/world').WorldConfig,
  loadData?: string,
  llm?: boolean,
  replayData?: ReplayData,
): void {
  if (replayData) {
    // Playback: the log carries its own recipe; whatever rode the init
    // message beside it is ignored, and nothing is re-recorded.
    replay = replayData;
    config = replayData.config;
    loadData = replayData.loadData;
    llm = false;
  }
  world = loadData !== undefined ? deserializeWorld(loadData) : createWorld(config);
  if (!replay) recording = { config, loadData, commands: [], advice: [] };
  // AI seats think next to the world, the same way the server runs them.
  ai = new AiSeats(world);
  // First summaries only after the opening has taken shape — advice on an
  // empty valley would just be the model guessing at the map.
  summaryDue = llm
    ? new Map(ai.seatIds().map((id, i) => [id, ADVICE_PERIOD + i * ADVICE_STAGGER]))
    : null;
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
  outer: while (acc >= TICK_MS) {
    acc -= TICK_MS;
    // One 50ms quantum = `speed` ticks, commands on its first tick.
    const commands = pendingCommands;
    pendingCommands = [];
    for (let i = 0; i < speed; i++) {
      // Playback stops where the recording stopped: pause in place rather
      // than run on into ticks the log never saw.
      if (replay && world.tick >= replay.endTick) {
        speed = 0;
        if (!replayEndedPosted) {
          replayEndedPosted = true;
          post({ type: 'replayEnded' });
        }
        break outer;
      }
      const executed = replay ? replayCommandsFor(world.tick) : i === 0 ? commands : [];
      // Log the player's orders under the tick they actually apply on —
      // which is this one, not the tick they were sent on. Before the AI's
      // are appended: those are re-derived on playback, not stored.
      if (recording && executed.length > 0) {
        recording.commands.push({ tick: world.tick, commands: executed.slice() });
      }
      // Advice lands between quanta live; on playback, re-apply anything
      // logged up to this tick before the brains decide from it.
      if (replay) applyReplayAdvice(world.tick);
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
    postSummaries();
  }
}

/** The logged player commands for one tick, as a fresh array the caller
 * may append the AI's to. The log is sorted, so a cursor walks it once. */
function replayCommandsFor(tick: number): PlayerCommand[] {
  const out: PlayerCommand[] = [];
  if (!replay) return out;
  const entries = replay.commands;
  while (replayCmdIdx < entries.length && entries[replayCmdIdx]!.tick <= tick) {
    // `<` can only mean a log from a save the world has already moved past;
    // dropping is safer than applying an order to the wrong tick.
    if (entries[replayCmdIdx]!.tick === tick) out.push(...entries[replayCmdIdx]!.commands);
    replayCmdIdx++;
  }
  return out;
}

/** Re-apply logged strategist advice due by this tick (playback only). */
function applyReplayAdvice(tick: number): void {
  if (!replay || !ai) return;
  const entries = replay.advice;
  while (replayAdviceIdx < entries.length && entries[replayAdviceIdx]!.tick <= tick) {
    const entry = entries[replayAdviceIdx]!;
    ai.applyAdvice(entry.playerId, entry.override);
    replayAdviceIdx++;
  }
}

/** Report each AI seat upstairs when its consultation comes due. Outside
 * the tick loop on purpose: summaries are advisory, so "at least every
 * period" is the contract, not "on an exact tick". */
function postSummaries(): void {
  if (!world || !ai || !summaryDue || world.outcome.state !== 'playing') return;
  for (const [playerId, due] of summaryDue) {
    if (world.tick < due) continue;
    summaryDue.set(playerId, world.tick + ADVICE_PERIOD);
    // Through the brain, not the raw world: the strategist may know only
    // what the seat has scouted.
    const brain = ai.brainFor(playerId);
    if (brain) post({ type: 'aiSummary', playerId, summary: summarizeForSeat(world, brain) });
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
  const mission =
    world.missionId !== undefined
      ? { id: world.missionId, done: [...(world.objectivesDone ?? [])] }
      : undefined;
  const miscBody = JSON.stringify([world.admin, world.outcome, lastInvariantViolations, mission]);
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
    ...(mission ? { mission } : {}),
  };
  post(msg);
}

function publish(): void {
  if (!world || !writer) return;
  writer.publish(unitSnapshots(world));
}
