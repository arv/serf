import {parseAdvice, toOverride, type StrategyAdvice} from '../../src/ai/advice.ts';
import {summarizeForSeat} from '../../src/ai/summary.ts';
import {AiSeats} from '../../src/sim/aiSeats.ts';
import * as BuildingState from '../../src/sim/buildingStateEnum.ts';
import {checkInvariants} from '../../src/sim/debug/invariants.ts';
import type {
  AiStrategyId,
  AiStrategy,
} from '../../src/sim/defs/aiStrategies.ts';
import {buildingDef} from '../../src/sim/defs/buildings.ts';
import * as UnitTypeId from '../../src/sim/defs/unitTypeIdEnum.ts';
import type {EconomyRuleId} from '../../src/sim/economyRules.ts';
import type {Owner} from '../../src/sim/entities.ts';
import type {WarBehaviorId} from '../../src/sim/systems/ai.ts';
import * as MatchState from '../../src/sim/matchStateEnum.ts';
import * as PlayerKind from '../../src/sim/playerKindEnum.ts';
import {tickWorld} from '../../src/sim/tick.ts';
import {createWorld, type World} from '../../src/sim/world.ts';
import type {LabEngine} from './engines.ts';

/**
 * One headless match, played the way the game plays it.
 *
 * This is simWorker's loop with the rendering and the messaging taken out:
 * decide → tick, a seat summary every ADVICE_PERIOD ticks, the summary to
 * the seat's engine, and whatever survives parseAdvice laid over the seat's
 * playbook through AiSeats. The consult bookkeeping here is the
 * LlmStrategist's, kept verbatim after the model it babysat was removed —
 * replies merge over a standing pile, and only a pile that actually changed
 * costs a message — because every recorded number was measured under those
 * semantics and the archived digests have to keep reproducing.
 *
 * Latency is still modelled. The shipped strategist thought for tens of
 * seconds while the valley kept moving, so its advice always arrived late;
 * an engine here answers instantly, which would quietly hand it a hindsight
 * advantage nothing shipped ever had. So advice is queued and applied
 * `latencyTicks` later, on purpose. 0 is an oracle and the recorded
 * baselines' setting; a positive value prices the thinking time back in.
 *
 * Determinism: same seed and same engine must give the same match, or a
 * bake-off is measuring its own jitter. Everything is driven off the sim's
 * tick counter, and every engine is a pure function of its inputs and its
 * own seeded dice.
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
  /**
   * The stance engine (sim/systems/ai.ts #updateStance). Undefined/true is
   * what ships; false pins every seat to its printed playbook — the
   * pre-stance null, kept reachable so the engine's worth stays a paired
   * measurement rather than a memory.
   */
  stances?: boolean;
  /**
   * War behaviors the seats run (sim/warBehaviorIdEnum.ts). Undefined runs
   * the whole set, which is what ships; a subset ablates one verb at a
   * time, and an empty array is the pre-reactive brain.
   */
  warBehaviors?: readonly WarBehaviorId[];
  /** Give up and call it undecided past here. */
  maxTicks: number;
  /** Ticks between one seat's consultations (simWorker shipped 1800 = 90 s). */
  advicePeriod: number;
  /** Offset between seats' cadences, so they never consult on one tick. */
  adviceStagger: number;
  /** Engines by seat; a seat with none plays its printed playbook. */
  engines: Map<Owner, LabEngine>;
  /** Ticks between a consultation and its advice reaching the brain. */
  latencyTicks: number;
  /** Keep every reply in the record. */
  trace?: boolean;
  /** Run the sim's invariant check this often; 0 disables. */
  checkInvariantsEvery?: number;
}

/** What one consultation said and what came of it. */
export interface ConsultRecord {
  playerId: Owner;
  /** Tick the summary was taken at. */
  tick: number;
  /** Wall-clock milliseconds the engine took (engines are synchronous now,
   * so ~0 — kept because the latency model and old JSONLs read it). */
  ms: number;
  /** Tick the resulting advice reached the brain, if it did. */
  appliedTick?: number;
  replyChars: number;
  /** Did the reply survive parseAdvice? False is an engine failing to hold
   * the format — worth counting, since the validator is the real gate. */
  parsed?: boolean;
  /** Validated knobs the reply actually set. Zero is a well-formed "keep
   * everything as it is", which is advice too — just not a change. */
  knobs?: number;
  /** Set when the engine threw. */
  error?: string;
  /** Only with `trace`. */
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
  /** Seats that had an advisor, and what was in it. */
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
  /** Kept for JSONL compatibility with the model-era records; nothing
   * fills it now that no engine can give up mid-match. */
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
  /**
   * Each seat's war fingerprints (AiBrain.warReport): when it first
   * marched in force, its sorties and their endings, defenses, retreats,
   * fled scouts, mood switches. The legibility numbers — two playbooks
   * that print the same win rate should still read differently here.
   */
  war: ({playerId: Owner} & ReturnType<
    import('../../src/sim/systems/ai.ts').AiBrain['warReport']
  >)[];
  /** Wall-clock milliseconds the whole match took. */
  wallMs: number;
  /** Every unit and building at the final tick, folded to a string. Two
   * runs of one config must agree on it — standings alone are far too
   * coarse to catch a harness that has gone nondeterministic, since two
   * quite different wars can leave the same headcount behind. */
  digest: string;
}

/** Advice waiting out its modelled latency before it reaches the brain. */
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
 * array has to stay ordered by `dueTick`. Under one fixed `--latency` every
 * delay is identical and appending would do; the insert keeps the queue
 * honest for any caller that hands consultations different delays, with
 * ties keeping the order they were asked in so a sweep stays reproducible.
 */
export function queueAdvice(
  pending: PendingAdvice[],
  entry: PendingAdvice,
): void {
  let i = pending.length;
  while (i > 0 && pending[i - 1]!.dueTick > entry.dueTick) i--;
  pending.splice(i, 0, entry);
}

/**
 * The consult bookkeeping the LlmStrategist used to do, per seat: replies
 * merge over a standing pile, and the pile goes downstairs only when it
 * both says something and differs from what was last sent. Kept verbatim
 * because the archived runs were measured under exactly these semantics.
 */
interface SeatAdviceMemory {
  /** Every knob changed so far, newest over oldest. */
  advice: StrategyAdvice | null;
  /** The override as last posted, stringified — an engine that repeats its
   * standing advice every consultation should not repeat the message. */
  sentKey: string | null;
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
  if (cfg.stances === false) {
    for (const id of seats.seatIds())
      seats.brainFor(id)?.setStancePolicy(false);
  }
  if (cfg.warBehaviors !== undefined) {
    for (const id of seats.seatIds())
      seats.brainFor(id)?.setWarBehaviors(cfg.warBehaviors);
  }

  const consults: ConsultRecord[] = [];
  const adviceApplied = new Map<Owner, number>();
  const pending: PendingAdvice[] = [];
  const advised: {playerId: Owner; engine: string}[] = [];
  const memory = new Map<Owner, SeatAdviceMemory>();

  for (const [playerId, engine] of cfg.engines) {
    if (!seats.seatIds().includes(playerId)) continue;
    advised.push({playerId, engine: engine.label});
    memory.set(playerId, {advice: null, sentKey: null});
  }

  const summaryDue = new Map(
    seats
      .seatIds()
      .map((id, i) => [id, cfg.advicePeriod + i * cfg.adviceStagger]),
  );

  /** One consultation, at the loop position the strategist ran it: the
   * summary is this tick's, and advice lands `latencyTicks` later. */
  const consult = (playerId: Owner, engine: LabEngine): void => {
    const mem = memory.get(playerId)!;
    const brain = seats.brainFor(playerId)!;
    const record: ConsultRecord = {
      playerId,
      tick: world.tick,
      ms: 0,
      replyChars: 0,
    };
    consults.push(record);
    const t0 = Date.now();
    let raw: string;
    try {
      raw = engine.advise(summarizeForSeat(world, brain));
    } catch (err) {
      record.ms = Date.now() - t0;
      record.error = err instanceof Error ? err.message : String(err);
      return;
    }
    record.ms = Date.now() - t0;
    record.replyChars = raw.length;
    if (cfg.trace) record.reply = raw;
    const advice = parseAdvice(raw);
    record.parsed = advice !== null;
    if (!advice) return;
    const {reason: _reason, ...knobs} = advice;
    record.knobs = Object.keys(knobs).length;
    // Only a reply that actually moved a dial goes downstairs: "keep
    // everything as it is" is a valid answer, and so is repeating the
    // standing advice word for word — neither costs a message.
    mem.advice = {...mem.advice, ...advice};
    const override = toOverride(mem.advice);
    const key = JSON.stringify(override);
    if (Object.keys(override).length === 0 || key === mem.sentKey) return;
    mem.sentKey = key;
    adviceApplied.set(playerId, (adviceApplied.get(playerId) ?? 0) + 1);
    queueAdvice(pending, {
      dueTick: world.tick + Math.max(0, cfg.latencyTicks),
      playerId,
      override,
      consult: record,
    });
  };

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
      const engine = cfg.engines.get(playerId);
      if (!engine || !seats.brainFor(playerId)) continue;
      consult(playerId, engine);
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

  // Advice still in the queue when the match ended never landed; those
  // records keep no appliedTick, which is exactly what happened.

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
    failures: [],
    stalls: seats.seatIds().map(id => {
      const {beats, recoveries} = seats.brainFor(id)!.stallReport();
      return {playerId: id, beats, recoveries};
    }),
    war: seats
      .seatIds()
      .map(id => ({playerId: id, ...seats.brainFor(id)!.warReport()})),
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
