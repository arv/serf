import {parseAdvice} from '../../src/ai/advice.ts';
import * as LlmState from '../../src/ai/llmStateEnum.ts';
import type {ChatMessage} from '../../src/ai/prompt.ts';
import {LlmStrategist, type LlmStatus} from '../../src/ai/strategist.ts';
import {summarizeForSeat} from '../../src/ai/summary.ts';
import {AiSeats} from '../../src/sim/aiSeats.ts';
import * as BuildingState from '../../src/sim/buildingStateEnum.ts';
import {checkInvariants} from '../../src/sim/debug/invariants.ts';
import type {
  AiStrategyId,
  AiStrategy,
} from '../../src/sim/defs/aiStrategies.ts';
import {TICK_MS} from '../../src/sim/defs/balance.ts';
import {buildingDef} from '../../src/sim/defs/buildings.ts';
import * as UnitTypeId from '../../src/sim/defs/unitTypeIdEnum.ts';
import type {EconomyRuleId} from '../../src/sim/economyRules.ts';
import type {Owner} from '../../src/sim/entities.ts';
import * as MatchState from '../../src/sim/matchStateEnum.ts';
import * as PlayerKind from '../../src/sim/playerKindEnum.ts';
import {tickWorld} from '../../src/sim/tick.ts';
import {createWorld, type World} from '../../src/sim/world.ts';
import type {LabEngine} from './engines.ts';

/**
 * One headless match, played the way the game plays it.
 *
 * This is simWorker's loop with the rendering and the messaging taken out:
 * decide → tick, a seat summary every ADVICE_PERIOD ticks, the summary
 * through the *real* LlmStrategist, and whatever survives parseAdvice laid
 * over the seat's playbook through AiSeats. Nothing about the advice path
 * is re-implemented here, because a harness that re-implements the thing
 * it measures measures the re-implementation.
 *
 * Two places where a lab must be more careful than the game:
 *
 * Latency. In the game the valley keeps moving while the model thinks, so
 * advice lands tens of seconds after the state that prompted it. Here the
 * sim is frozen during inference — wall clock and sim clock are unrelated
 * — which would quietly hand every model a hindsight advantage the shipped
 * one does not get. So advice is queued and applied `latencyTicks` later,
 * on purpose. Leave it at 0 and you are measuring an oracle; set it from
 * the latency the report prints and you are measuring the game.
 *
 * Determinism. Same seed and same engine replies must give the same match,
 * or a bake-off is measuring its own jitter. Everything here is driven off
 * the sim's tick counter rather than wall time, which holds for every
 * engine except a real model sampling at temperature — that one is
 * genuinely stochastic, and the seed sweep is what averages it out.
 */

/** The two seats' playbooks, seat-indexed. Equal ids is the symmetric
 * experiment — advice is then the only asymmetry between the seats. */
export type SeatStrategies = readonly [AiStrategyId, AiStrategyId];

export interface MatchConfig {
  seed: number;
  mapSize: number;
  bandits: boolean;
  /** One playbook per seat. Both entries the same makes advice the only
   * asymmetry; different entries is a playbook-vs-playbook match, and the
   * sweep then owes the mirrored seating too (see bakeoff.ts). */
  strategies: SeatStrategies;
  /**
   * Economy rules the seats run (sim/economyRules.ts). Undefined runs the
   * whole table, which is what ships; a subset is the ablation — measure a
   * sweep with one rule missing and the difference is what that rule is
   * worth. An empty array turns the layer off entirely.
   */
  economyRules?: readonly EconomyRuleId[];
  /** Give up and call it undecided past here. */
  maxTicks: number;
  /** Ticks between one seat's consultations (simWorker ships 1800 = 90 s). */
  advicePeriod: number;
  /** Offset between seats' cadences, so they never consult on one tick. */
  adviceStagger: number;
  /** Engines by seat; a seat with none plays its printed playbook. */
  engines: Map<Owner, LabEngine>;
  /** Ticks between a consultation starting and its advice reaching the
   * brain. 'measured' converts the engine's own wall clock, which is
   * realistic but no longer reproducible. */
  latencyTicks: number | 'measured';
  /** Per-consultation deadline; defaults to the strategist's own 60 s. */
  timeoutMs?: number;
  /** Keep every prompt and reply in the record. Big — for building
   * training data or reading what the model actually said. */
  trace?: boolean;
  /** Run the sim's invariant check this often; 0 disables. */
  checkInvariantsEvery?: number;
}

/** What one consultation cost and what came back. */
export interface ConsultRecord {
  playerId: Owner;
  /** Tick the summary was taken at. */
  tick: number;
  /** Wall-clock milliseconds the engine took. */
  ms: number;
  /** Tick the resulting advice reached the brain, if it did. */
  appliedTick?: number;
  promptChars: number;
  replyChars: number;
  /** Did the reply survive parseAdvice? False is the model failing to hold
   * the format — the failure a grammar-constrained backend should make
   * impossible, and worth counting when it does not. */
  parsed?: boolean;
  /** Validated knobs the reply actually set. Zero is a well-formed "keep
   * everything as it is", which is advice too — just not a change. */
  knobs?: number;
  /** Set when the strategist declined the summary (busy, dead, disposed). */
  skipped?: boolean;
  /** Set when the engine threw or the reply did not survive parseAdvice. */
  error?: string;
  /** Only with `trace`. */
  prompt?: ChatMessage[];
  reply?: string;
}

/** Where a seat stood when the match ended. */
export interface SeatStanding {
  playerId: Owner;
  alive: boolean;
  castleStanding: boolean;
  buildings: number;
  pop: number;
  army: {knight: number; spearman: number; archer: number};
  /** Summed hit points of standing soldiers — army size weighted by how
   * much of it is left. */
  armyHp: number;
}

export interface MatchRecord {
  seed: number;
  mapSize: number;
  bandits: boolean;
  /** What each seat played, seat-indexed — the record has to say which
   * playbook sat where, or a swapped-seating sweep cannot be scored. */
  strategies: SeatStrategies;
  /** Seats that had a strategist, and what was in it. */
  advised: {playerId: Owner; engine: string}[];
  ticks: number;
  /** The sim reached a verdict rather than hitting maxTicks. */
  decided: boolean;
  /** null = undecided, or decided with nobody left standing. */
  winner: Owner | null;
  standings: SeatStanding[];
  consults: ConsultRecord[];
  /** Advice messages that actually reached each brain. Far fewer than
   * consultations: standing advice repeated verbatim costs no message. */
  adviceApplied: Record<string, number>;
  /** A strategist that gave up, and why. */
  failures: {playerId: Owner; reason: string}[];
  /**
   * What the stall watchdog saw per seat (AI_STALL in sim/systems/ai.ts):
   * decision beats that read as stalled, and recovery orders sent. Beside
   * `decided` rather than folded into it, because a match can end on time
   * having been stuck for half of it, and a watchdog that never fires is
   * indistinguishable from one that fires uselessly if all you have is the
   * undecided count.
   */
  stalls: {playerId: Owner; beats: number; recoveries: number}[];
  /** Wall-clock milliseconds the whole match took, sim and inference. */
  wallMs: number;
  /** Every unit and building at the final tick, folded to a string. Two
   * runs of one config must agree on it — standings alone are far too
   * coarse to catch a harness that has gone nondeterministic, since two
   * quite different wars can leave the same headcount behind. */
  digest: string;
}

/** Advice waiting out its inference latency before it reaches the brain. */
export interface PendingAdvice {
  dueTick: number;
  playerId: Owner;
  override: Partial<AiStrategy>;
  /** The consultation it came from, so the record can be closed out. */
  consult: ConsultRecord;
}

/**
 * Queue advice by when it lands, not by when it was asked for.
 *
 * The tick loop drains from the front while `pending[0]` is due, so the
 * array has to stay ordered by `dueTick`. Appending is enough under a fixed
 * `--latency`, where every delay is identical and the two orders agree — but
 * `--latency measured` gives each consultation its own delay, so a slow one
 * can still be waiting when a fast one asked later comes due first. Appended,
 * that fast advice would sit behind the slow one and land late, which is the
 * opposite of what measuring latency is for.
 *
 * Inserted after the last entry due no later than this one, so ties keep the
 * order they were asked in and a sweep stays reproducible.
 */
export function queueAdvice(
  pending: PendingAdvice[],
  entry: PendingAdvice,
): void {
  let i = pending.length;
  while (i > 0 && pending[i - 1]!.dueTick > entry.dueTick) i--;
  pending.splice(i, 0, entry);
}

export async function playMatch(cfg: MatchConfig): Promise<MatchRecord> {
  const startedAt = Date.now();
  const world = createWorld({
    seed: cfg.seed,
    players: [
      {kind: PlayerKind.ai, strategy: cfg.strategies[0]},
      {kind: PlayerKind.ai, strategy: cfg.strategies[1]},
    ],
    banditsEnabled: cfg.bandits,
    mapSize: cfg.mapSize,
  });
  const seats = new AiSeats(world);
  if (cfg.economyRules !== undefined) {
    for (const id of seats.seatIds())
      seats.brainFor(id)?.setEconomyRules(cfg.economyRules);
  }

  const consults: ConsultRecord[] = [];
  const adviceApplied = new Map<Owner, number>();
  const failures: {playerId: Owner; reason: string}[] = [];
  const pending: PendingAdvice[] = [];
  const strategists = new Map<Owner, LlmStrategist>();
  const advised: {playerId: Owner; engine: string}[] = [];

  // The consultation the tick loop is currently waiting on. The strategist
  // is fire-and-forget by design, so the harness reaches into the engine
  // seam to know when one has finished: complete() is called synchronously
  // inside onSummary, which makes "did a consultation start?" answerable
  // the moment onSummary returns. A one-slot array rather than a variable
  // because the compiler cannot see that onSummary reassigns it.
  const inflight: Promise<unknown>[] = [];
  let inflightRecord: ConsultRecord | null = null;

  for (const [playerId, engine] of cfg.engines) {
    if (!seats.seatIds().includes(playerId)) continue;
    advised.push({playerId, engine: engine.label});
    const strategist = new LlmStrategist({
      sendAdvice: (id, override) => {
        adviceApplied.set(id, (adviceApplied.get(id) ?? 0) + 1);
        const consult = inflightRecord;
        const delay =
          cfg.latencyTicks === 'measured'
            ? Math.round((consult?.ms ?? 0) / TICK_MS)
            : cfg.latencyTicks;
        queueAdvice(pending, {
          dueTick: world.tick + Math.max(0, delay),
          playerId: id,
          override,
          // A consultation always exists here: sendAdvice is only ever
          // reached from inside #consult, which the harness started.
          consult: consult ?? {
            playerId: id,
            tick: world.tick,
            ms: 0,
            promptChars: 0,
            replyChars: 0,
          },
        });
      },
      onStatus: (status: LlmStatus) => {
        if (status.state === LlmState.failed)
          failures.push({playerId, reason: status.reason});
      },
      ...(cfg.timeoutMs !== undefined ? {timeoutMs: cfg.timeoutMs} : {}),
      engineFactory: () =>
        Promise.resolve({
          complete: (messages, schema, signal) => {
            const record: ConsultRecord = {
              playerId,
              tick: world.tick,
              ms: 0,
              promptChars: messages.reduce((n, m) => n + m.content.length, 0),
              replyChars: 0,
              ...(cfg.trace ? {prompt: messages} : {}),
            };
            consults.push(record);
            inflightRecord = record;
            const t0 = Date.now();
            const call = engine.complete(messages, schema, signal).then(
              reply => {
                record.ms = Date.now() - t0;
                record.replyChars = reply.length;
                // Judge the reply the way the strategist is about to. The
                // strategist swallows a parse failure into its own strike
                // count and tells the harness nothing, so this is the only
                // place the distinction between "model broke" and "model
                // had nothing to say" is still visible.
                const advice = parseAdvice(reply);
                record.parsed = advice !== null;
                if (advice) {
                  const {reason: _reason, ...knobs} = advice;
                  record.knobs = Object.keys(knobs).length;
                }
                if (cfg.trace) record.reply = reply;
                return reply;
              },
              (err: unknown) => {
                record.ms = Date.now() - t0;
                record.error = err instanceof Error ? err.message : String(err);
                throw err;
              },
            );
            inflight.push(call);
            return call;
          },
        }),
    });
    await strategist.start();
    strategists.set(playerId, strategist);
  }

  const summaryDue = new Map(
    seats
      .seatIds()
      .map((id, i) => [id, cfg.advicePeriod + i * cfg.adviceStagger]),
  );

  for (
    let t = 0;
    t < cfg.maxTicks && world.outcome.state === MatchState.playing;
    t++
  ) {
    // Advice due this tick lands before the brains think, so a seat acts on
    // it the same tick the game would have.
    while (pending.length > 0 && pending[0]!.dueTick <= world.tick) {
      const next = pending.shift()!;
      seats.applyAdvice(next.playerId, next.override);
      next.consult.appliedTick = world.tick;
    }

    tickWorld(world, seats.decide(world));

    for (const [playerId, due] of summaryDue) {
      if (world.tick < due) continue;
      summaryDue.set(playerId, world.tick + cfg.advicePeriod);
      const strategist = strategists.get(playerId);
      const brain = seats.brainFor(playerId);
      if (!strategist || !brain) continue;

      inflight.length = 0;
      inflightRecord = null;
      strategist.onSummary(playerId, summarizeForSeat(world, brain));
      const started = inflight[0];
      if (!started) {
        // The strategist declined: already thinking, already given up, or
        // disposed. The game drops these summaries too.
        consults.push({
          playerId,
          tick: world.tick,
          ms: 0,
          promptChars: 0,
          replyChars: 0,
          skipped: true,
        });
        continue;
      }
      // Wait for the model, then let the strategist's own continuations —
      // parse, clamp, sendAdvice — run before the sim moves again. Those
      // are all microtasks, so one macrotask turn drains them.
      await started.catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    const every = cfg.checkInvariantsEvery ?? 0;
    if (every > 0 && world.tick % every === 0) {
      const {violations} = checkInvariants(world);
      if (violations.length > 0) {
        throw new Error(
          `invariants broken at tick ${world.tick}: ${violations.join('; ')}`,
        );
      }
    }
  }

  // Advice still in flight when the match ended never landed; leave those
  // records without an appliedTick, which is exactly what happened.
  for (const strategist of strategists.values()) strategist.dispose();

  const decided = world.outcome.state === MatchState.over;
  return {
    seed: cfg.seed,
    mapSize: cfg.mapSize,
    bandits: cfg.bandits,
    strategies: cfg.strategies,
    advised,
    ticks: world.tick,
    decided,
    winner: decided ? (world.outcome as {winner: Owner | null}).winner : null,
    standings: seats.seatIds().map(id => standingOf(world, id)),
    consults,
    adviceApplied: Object.fromEntries(
      [...adviceApplied].map(([id, n]) => [String(id), n]),
    ),
    failures,
    stalls: seats.seatIds().map(id => {
      const {beats, recoveries} = seats.brainFor(id)!.stallReport();
      return {playerId: id, beats, recoveries};
    }),
    wallMs: Date.now() - startedAt,
    digest: worldDigest(world),
  };
}

/** The final field, folded to eight hex digits: who is standing where, at
 * what tick. Hashed rather than kept whole because it rides along in every
 * JSONL record and a late-game valley is thousands of entities. Insertion
 * order is deterministic in a deterministic sim, so nothing needs sorting. */
function worldDigest(world: World): string {
  // FNV-1a, folded over the same fields a replay would have to reproduce.
  let h = 0x811c9dc5;
  const feed = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    }
  };
  feed(`t${world.tick}`);
  for (const u of world.units.values()) {
    feed(
      `|u${u.kind},${u.owner},${Math.round(u.x * 10)},${Math.round(u.y * 10)},${u.hp},${u.dead ? 1 : 0}`,
    );
  }
  for (const b of world.buildings.values()) {
    feed(`|b${b.type},${b.owner},${b.x},${b.y},${b.state},${b.dead ? 1 : 0}`);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Where a seat stood at the final tick. Diagnostics, not scoring: a
 * bake-off is decided by who won, and a match that never decided is
 * reported as undecided rather than awarded to whoever had more huts.
 * These numbers are for reading a run, not for grading it.
 */
export function standingOf(world: World, playerId: Owner): SeatStanding {
  let buildings = 0;
  let castleStanding = false;
  for (const b of world.buildings.values()) {
    if (b.dead || b.owner !== playerId) continue;
    buildings++;
    // The castle is the storehouse building — summary.ts finds it the same
    // way, by the storage flag rather than by an id that does not exist.
    if (buildingDef(b.type).storage && b.state === BuildingState.built)
      castleStanding = true;
  }
  let pop = 0;
  let armyHp = 0;
  const army = {knight: 0, spearman: 0, archer: 0};
  for (const u of world.units.values()) {
    if (u.dead || u.owner !== playerId) continue;
    pop++;
    if (u.kind === UnitTypeId.knight) (army.knight++, (armyHp += u.hp));
    else if (u.kind === UnitTypeId.spearman)
      (army.spearman++, (armyHp += u.hp));
    else if (u.kind === UnitTypeId.archer) (army.archer++, (armyHp += u.hp));
  }
  return {
    playerId,
    alive: world.players[playerId]?.alive ?? false,
    castleStanding,
    buildings,
    pop,
    army,
    armyHp,
  };
}

/** A match's identity for reproducibility checks. Two runs of the same
 * config must agree on it. */
export function digestOf(record: MatchRecord): string {
  return record.digest;
}
