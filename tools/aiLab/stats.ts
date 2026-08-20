import type { ConsultRecord, MatchRecord } from './match.ts';
import type { Owner } from '../../src/sim/entities.ts';

/**
 * Turning a pile of matches into a number you are allowed to believe.
 *
 * The experiment is paired and mirrored, which is the whole reason this
 * file is short. Every seed is played twice with the same engine: once
 * advising seat 0, once advising seat 1. Under the null hypothesis — the
 * advice does nothing — the advised side wins exactly half of those
 * trials, *whatever* the map's built-in seat bias happens to be, because
 * whichever seat the valley favors is the advised one in half the trials
 * and the control in the other half. So the bar is 50%, always, and no
 * separate correction for a lopsided map is needed.
 *
 * What still needs saying out loud is how wide the error bars are. Twenty
 * seeds is forty trials, and forty trials cannot see anything smaller than
 * about a fifteen-point effect. A harness that prints "56%" without that
 * caveat is a machine for fooling its owner, so the report prints the
 * interval next to the rate and refuses to call a straddling interval a
 * result.
 */

/** One seed, played every way the bake-off asked for. */
export interface SeedRun {
  seed: number;
  /** Both seats unadvised — what the valley does on its own. */
  control: MatchRecord | null;
  /** One entry per mirrored trial. */
  arms: { advisedSeat: Owner; record: MatchRecord }[];
}

export interface Rate {
  wins: number;
  trials: number;
  rate: number;
  /** Wilson 95% score interval, as fractions. */
  lo: number;
  hi: number;
}

export interface EngineHealth {
  consultations: number;
  /** Summaries the strategist declined (busy, or it had given up). */
  skipped: number;
  /** The engine itself threw — HTTP error, timeout, abort. */
  errors: number;
  /** Came back, but was not JSON the validator could read. */
  parseFailures: number;
  /** Well-formed, but asked for no change. */
  emptyAdvice: number;
  /** Advice messages that reached a brain. */
  adviceMessages: number;
  /** Strategists that hit three strikes and went inert. */
  gaveUp: { playerId: Owner; reason: string }[];
  latencyMs: { p50: number; p95: number; max: number; n: number };
}

export interface BakeoffReport {
  advised: Rate;
  /** The same rate split by which seat was wearing the advice. Wide gaps
   * here mean the two starts differ enough that the mirror is doing real
   * work — interesting, but not a problem. */
  bySeat: { seat: Owner; rate: Rate }[];
  /** Trials whose match never reached a verdict. Excluded from the rate:
   * an undecided match is not a win for anybody. */
  undecided: number;
  /**
   * What the stall watchdog saw across the sweep (AI_STALL): matches with
   * at least one seat that ever read as stalled, and recovery orders sent.
   * Counted beside `undecided` on purpose — a stall the watchdog broke
   * still happened, and a sweep whose undecided count fell while stalls
   * stayed flat says the rules worked rather than that the stalls went
   * away on their own.
   */
  stalls: { matches: number; recoveries: number };
  /** How often advice changed who won, against the same seed's control. */
  flips: { toward: number; away: number; unchanged: number; noControl: number };
  health: EngineHealth;
  matchTicks: { median: number; max: number };
  /** Wall-clock seconds the whole sweep took. */
  wallSeconds: number;
}

/**
 * Wilson score interval — the one to use for proportions from small
 * samples. The textbook normal interval puts 8/8 at [100%, 100%], which
 * would let an eight-seed run declare victory.
 */
export function wilson(wins: number, trials: number, z = 1.96): [number, number] {
  if (trials === 0) return [0, 1];
  const p = wins / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const spread = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denom;
  return [Math.max(0, center - spread), Math.min(1, center + spread)];
}

export function rateOf(wins: number, trials: number): Rate {
  const [lo, hi] = wilson(wins, trials);
  return { wins, trials, rate: trials === 0 ? 0 : wins / trials, lo, hi };
}

/**
 * Trials needed for a 95% interval no wider than ±`halfWidth` around a
 * coin flip — the honest answer to "how many seeds is enough?". Worst case
 * at p = 0.5, which is where the null sits.
 */
export function trialsForPrecision(halfWidth: number): number {
  return Math.ceil((1.96 * 1.96 * 0.25) / (halfWidth * halfWidth));
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i]!;
}

export function summarize(runs: SeedRun[], wallSeconds: number): BakeoffReport {
  let wins = 0;
  let trials = 0;
  let undecided = 0;
  const perSeat = new Map<Owner, { wins: number; trials: number }>();
  const flips = { toward: 0, away: 0, unchanged: 0, noControl: 0 };
  const stalls = { matches: 0, recoveries: 0 };
  const ticks: number[] = [];

  const consults: ConsultRecord[] = [];
  const gaveUp: { playerId: Owner; reason: string }[] = [];
  let adviceMessages = 0;

  for (const run of runs) {
    for (const { advisedSeat, record } of run.arms) {
      ticks.push(record.ticks);
      if ((record.stalls ?? []).some((x) => x.beats > 0)) stalls.matches++;
      for (const x of record.stalls ?? []) stalls.recoveries += x.recoveries;
      consults.push(...record.consults);
      gaveUp.push(...record.failures);
      for (const n of Object.values(record.adviceApplied)) adviceMessages += n;

      if (!record.decided) {
        // Counted, reported, and kept out of the rate: awarding an
        // unfinished match to whoever had more huts would be inventing a
        // result the sim declined to give.
        undecided++;
        continue;
      }
      trials++;
      const seat = perSeat.get(advisedSeat) ?? { wins: 0, trials: 0 };
      seat.trials++;
      const won = record.winner === advisedSeat;
      if (won) {
        wins++;
        seat.wins++;
      }
      perSeat.set(advisedSeat, seat);

      const control = run.control;
      if (!control || !control.decided) flips.noControl++;
      else if (control.winner === record.winner) flips.unchanged++;
      else if (won) flips.toward++;
      else flips.away++;
    }
    // A control match is played for the comparison, not scored itself, but
    // its consultations (there are none) and length still belong to the run.
    if (run.control) ticks.push(run.control.ticks);
  }

  const latencies = consults.filter((c) => !c.skipped).map((c) => c.ms);
  latencies.sort((a, b) => a - b);
  const sortedTicks = [...ticks].sort((a, b) => a - b);

  return {
    advised: rateOf(wins, trials),
    bySeat: [...perSeat]
      .sort((a, b) => a[0] - b[0])
      .map(([seat, s]) => ({ seat, rate: rateOf(s.wins, s.trials) })),
    undecided,
    stalls,
    flips,
    health: {
      consultations: consults.length,
      skipped: consults.filter((c) => c.skipped).length,
      errors: consults.filter((c) => c.error !== undefined).length,
      parseFailures: consults.filter((c) => !c.skipped && !c.error && c.parsed === false).length,
      emptyAdvice: consults.filter((c) => c.knobs === 0).length,
      adviceMessages,
      gaveUp,
      latencyMs: {
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        max: latencies.length > 0 ? latencies[latencies.length - 1]! : 0,
        n: latencies.length,
      },
    },
    matchTicks: {
      median: percentile(sortedTicks, 0.5),
      max: sortedTicks.length > 0 ? sortedTicks[sortedTicks.length - 1]! : 0,
    },
    wallSeconds,
  };
}
