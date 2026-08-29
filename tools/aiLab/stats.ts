import type {AiStrategyId} from '../../src/sim/defs/aiStrategies.ts';
import type {Owner} from '../../src/sim/entities.ts';
import type {ConsultRecord, MatchRecord} from './match.ts';

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
 * That argument never assumed the two seats run the SAME playbook. The
 * mirror is over which seat wears the advice, so the advised-win-rate null
 * stays exactly 50% when the seats run different playbooks too — `--engine
 * none --strategy steward:warlord` still calibrates to 50.0%. What changes
 * is what the rate means: it is then the average of two different
 * treatments (advising the steward against a warlord, and advising the
 * warlord against a steward), and the per-seat split stops being two halves
 * of one question.
 *
 * The playbook-vs-playbook question needs its own mirror, one level up:
 * play the seed again with the two playbooks in each other's seats. Under
 * "these playbooks are equally good" a playbook then wins exactly one of
 * its two seatings, whatever head start the valley gives a seat — the same
 * cancellation, applied to seating instead of advice. See `PlaybookMatchup`.
 *
 * What still needs saying out loud is how wide the error bars are. Twenty
 * seeds is forty trials, and forty trials cannot see anything smaller than
 * about a fifteen-point effect. A harness that prints "56%" without that
 * caveat is a machine for fooling its owner, so the report prints the
 * interval next to the rate and refuses to call a straddling interval a
 * result.
 */

/** One seating of one seed: the two playbooks as the flag gave them, or
 * the two of them swapped. Layout 1 is only played when they differ. */
export interface LayoutRun {
  /** 0 = playbooks as given, 1 = the two seats swapped. */
  layout: 0 | 1;
  /** Both seats unadvised — what the valley does on its own. */
  control: MatchRecord | null;
  /** One entry per mirrored advice trial. */
  arms: {advisedSeat: Owner; record: MatchRecord}[];
}

/** One seed, played every way the bake-off asked for. */
export interface SeedRun {
  seed: number;
  layouts: LayoutRun[];
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
  /** The engine itself threw. */
  errors: number;
  /** Came back, but was not JSON the validator could read. */
  parseFailures: number;
  /** Well-formed, but asked for no change. */
  emptyAdvice: number;
  /** Advice messages that reached a brain. */
  adviceMessages: number;
}

/**
 * Playbook A against playbook B, scored off the matches nobody advised.
 *
 * The advised win rate cannot answer this: it is nulled at 50% by
 * construction whoever is playing, which is exactly why it survives a
 * lopsided map — and exactly why it is blind to a lopsided *playbook*. So
 * this is measured separately, on the unadvised matches only, one per
 * (seed, seating). Advised matches are excluded rather than folded in
 * because "A with a model behind it beats B" is a third question again.
 *
 * The seating mirror is what makes 50% the null here. Read `paired` first:
 * the two seatings of one seed share a valley, so the 2N trials behind
 * `rate` are not 2N independent draws and its Wilson interval is
 * optimistic. The seed-level exact test makes no such assumption.
 */
export interface PlaybookMatchup {
  a: AiStrategyId;
  b: AiStrategyId;
  /** A's wins over the unadvised matches, both seatings pooled. Null 50%. */
  rate: Rate;
  /** A's record split by the seat it sat in — the map bias, made visible
   * rather than assumed away. A wide gap means the mirror earned its keep. */
  bySeat: {seat: Owner; wins: number; trials: number}[];
  /** The seed-level paired test. A seed where each playbook took its own
   * seating is a split and carries no evidence, exactly as a concordant
   * pair carries none in McNemar's test. */
  paired: {
    bothA: number;
    bothB: number;
    split: number;
    /** Seeds missing a seating, or with one undecided. */
    unresolved: number;
    /** Two-sided exact binomial over bothA + bothB. 1 when there are none. */
    p: number;
  };
}

/** One playbook's war conduct across a sweep, per seat played. */
export interface PlaybookFingerprint {
  strategy: AiStrategyId;
  /** Seats this playbook occupied among the scored matches. */
  seats: number;
  /** Median tick of the first all-in march, -1 when it never marched. */
  medianFirstMarch: number;
  /** The rest are means per seat. */
  sorties: number;
  sortieStrikes: number;
  sortieWithdrawals: number;
  outpostDefenses: number;
  marchRetreats: number;
  scoutFled: number;
  heralds: number;
  stanceSwitches: number;
}

export interface BakeoffReport {
  advised: Rate;
  /** The same rate split by which seat was wearing the advice. Wide gaps
   * here mean the two starts differ enough that the mirror is doing real
   * work — interesting, but not a problem. */
  bySeat: {seat: Owner; rate: Rate}[];
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
  stalls: {matches: number; recoveries: number};
  /** How often advice changed who won, against the same seed's control. */
  flips: {toward: number; away: number; unchanged: number; noControl: number};
  /**
   * Each playbook's war fingerprints (AiBrain.warReport), pooled over the
   * unadvised matches — one per (seed, seating), the same sample the
   * playbook matchup scores. The legibility numbers: two playbooks that
   * print the same win rate should still read differently here, and a
   * personality whose column is all zeros is a personality only its blurb
   * has.
   */
  fingerprints: PlaybookFingerprint[];
  /** Only when the two seats ran different playbooks. */
  playbooks: PlaybookMatchup | null;
  health: EngineHealth;
  matchTicks: {median: number; max: number};
  /** Wall-clock seconds the whole sweep took. */
  wallSeconds: number;
}

/**
 * Wilson score interval — the one to use for proportions from small
 * samples. The textbook normal interval puts 8/8 at [100%, 100%], which
 * would let an eight-seed run declare victory.
 */
export function wilson(
  wins: number,
  trials: number,
  z = 1.96,
): [number, number] {
  if (trials === 0) return [0, 1];
  const p = wins / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const spread =
    (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) /
    denom;
  return [Math.max(0, center - spread), Math.min(1, center + spread)];
}

export function rateOf(wins: number, trials: number): Rate {
  const [lo, hi] = wilson(wins, trials);
  return {wins, trials, rate: trials === 0 ? 0 : wins / trials, lo, hi};
}

/**
 * Trials needed for a 95% interval no wider than ±`halfWidth` around a
 * coin flip — the honest answer to "how many seeds is enough?". Worst case
 * at p = 0.5, which is where the null sits.
 */
export function trialsForPrecision(halfWidth: number): number {
  return Math.ceil((1.96 * 1.96 * 0.25) / (halfWidth * halfWidth));
}

/** Exact binomial: P(X <= k) for X ~ B(n, 1/2), computed in log space so
 * n in the hundreds cannot overflow. Lives here rather than in compare.ts
 * because two different pairings now lean on it — two runs joined on
 * (seed, advised seat), and one run's two seatings of a seed. */
export function binomCdfHalf(k: number, n: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  let logC = 0; // log C(n, 0)
  let sum = 0;
  const log2n = n * Math.log(2);
  for (let i = 0; i <= k; i++) {
    sum += Math.exp(logC - log2n);
    logC += Math.log(n - i) - Math.log(i + 1);
  }
  return Math.min(1, sum);
}

/** Two-sided exact p for `hits` of one kind against `misses` of the other,
 * under a coin flip. 1 when nothing disagreed. */
export function twoSidedExact(hits: number, misses: number): number {
  const n = hits + misses;
  if (n === 0) return 1;
  return Math.min(1, 2 * binomCdfHalf(Math.min(hits, misses), n));
}

/**
 * The one match of a seating that nobody advised. Prefer the control; with
 * `--no-control`, an arm whose engine turned out to be nothing (`--engine
 * none`) is the same unadvised game and does just as well.
 *
 * Exactly one, never all of them, and that is the whole point of this
 * function: under `--engine none` a seating's control and both its arms are
 * the identical match, so counting all three would treble the sample and
 * shrink the interval around a number that has not gained a single new
 * observation.
 */
function unadvisedMatch(layout: LayoutRun): MatchRecord | null {
  if (layout.control) return layout.control;
  return layout.arms.find(a => a.record.advised.length === 0)?.record ?? null;
}

/** Each playbook's war conduct pooled over the unadvised matches — the
 * same one-per-(seed, seating) sample the matchup scores, so neither
 * treble-counts an `--engine none` seating's identical arms. */
export function fingerprintsOf(runs: SeedRun[]): PlaybookFingerprint[] {
  interface Agg {
    seats: number;
    firstMarch: number[];
    sums: {
      sorties: number;
      sortieStrikes: number;
      sortieWithdrawals: number;
      outpostDefenses: number;
      marchRetreats: number;
      scoutFled: number;
      heralds: number;
      stanceSwitches: number;
    };
  }
  const byBook = new Map<AiStrategyId, Agg>();
  for (const run of runs) {
    for (const layout of run.layouts) {
      const record = unadvisedMatch(layout);
      if (!record) continue;
      for (const w of record.war ?? []) {
        const book = record.strategies[w.playerId];
        if (book === undefined) continue;
        let agg = byBook.get(book);
        if (!agg) {
          byBook.set(
            book,
            (agg = {
              seats: 0,
              firstMarch: [],
              sums: {
                sorties: 0,
                sortieStrikes: 0,
                sortieWithdrawals: 0,
                outpostDefenses: 0,
                marchRetreats: 0,
                scoutFled: 0,
                heralds: 0,
                stanceSwitches: 0,
              },
            }),
          );
        }
        agg.seats++;
        if (w.firstMarchTick >= 0) agg.firstMarch.push(w.firstMarchTick);
        agg.sums.sorties += w.sorties;
        agg.sums.sortieStrikes += w.sortieStrikes;
        agg.sums.sortieWithdrawals += w.sortieWithdrawals;
        agg.sums.outpostDefenses += w.outpostDefenses;
        agg.sums.marchRetreats += w.marchRetreats;
        agg.sums.scoutFled += w.scoutFled;
        agg.sums.heralds += w.heralds;
        agg.sums.stanceSwitches += w.stanceSwitches;
      }
    }
  }
  return [...byBook]
    .sort(([a], [z]) => a - z)
    .map(([strategy, agg]) => {
      const sorted = [...agg.firstMarch].sort((a, z) => a - z);
      const per = (n: number): number => (agg.seats === 0 ? 0 : n / agg.seats);
      return {
        strategy,
        seats: agg.seats,
        medianFirstMarch:
          sorted.length === 0 ? -1 : sorted[Math.floor(sorted.length / 2)]!,
        sorties: per(agg.sums.sorties),
        sortieStrikes: per(agg.sums.sortieStrikes),
        sortieWithdrawals: per(agg.sums.sortieWithdrawals),
        outpostDefenses: per(agg.sums.outpostDefenses),
        marchRetreats: per(agg.sums.marchRetreats),
        scoutFled: per(agg.sums.scoutFled),
        heralds: per(agg.sums.heralds),
        stanceSwitches: per(agg.sums.stanceSwitches),
      };
    });
}

/** Playbook A vs playbook B over the unadvised matches, or null when both
 * seats ran the same playbook and there is no matchup to speak of. */
export function matchupOf(runs: SeedRun[]): PlaybookMatchup | null {
  let ids: readonly [AiStrategyId, AiStrategyId] | null = null;
  for (const run of runs) {
    const first = run.layouts.find(l => l.layout === 0);
    const record = first ? unadvisedMatch(first) : null;
    if (record) {
      ids = record.strategies;
      break;
    }
  }
  if (!ids || ids[0] === ids[1]) return null;
  const [a, b] = ids;

  let wins = 0;
  let trials = 0;
  const bySeat = [
    {seat: 0 as Owner, wins: 0, trials: 0},
    {seat: 1 as Owner, wins: 0, trials: 0},
  ];
  const paired = {bothA: 0, bothB: 0, split: 0, unresolved: 0, p: 1};

  for (const run of runs) {
    let aWon = 0;
    let decided = 0;
    for (const layout of run.layouts) {
      const record = unadvisedMatch(layout);
      // A verdict with nobody left standing is not a win for B any more
      // than it is one for A, so it sits out beside the undecided ones.
      if (!record || !record.decided || record.winner === null) continue;
      const seatOfA: Owner = record.strategies[0] === a ? 0 : 1;
      const won = record.winner === seatOfA;
      trials++;
      decided++;
      const side = bySeat[seatOfA]!;
      side.trials++;
      if (won) {
        wins++;
        aWon++;
        side.wins++;
      }
    }
    // A seed only pairs if BOTH seatings decided: one seating alone carries
    // the seat bias the mirror exists to cancel.
    if (decided < 2) paired.unresolved++;
    else if (aWon === 2) paired.bothA++;
    else if (aWon === 0) paired.bothB++;
    else paired.split++;
  }
  paired.p = twoSidedExact(paired.bothA, paired.bothB);
  return {a, b, rate: rateOf(wins, trials), bySeat, paired};
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(q * (sorted.length - 1))),
  );
  return sorted[i]!;
}

export function summarize(runs: SeedRun[], wallSeconds: number): BakeoffReport {
  let wins = 0;
  let trials = 0;
  let undecided = 0;
  const perSeat = new Map<Owner, {wins: number; trials: number}>();
  const flips = {toward: 0, away: 0, unchanged: 0, noControl: 0};
  const stalls = {matches: 0, recoveries: 0};
  const ticks: number[] = [];

  const consults: ConsultRecord[] = [];
  let adviceMessages = 0;

  for (const run of runs) {
    for (const layout of run.layouts) {
      for (const {advisedSeat, record} of layout.arms) {
        ticks.push(record.ticks);
        if ((record.stalls ?? []).some(x => x.beats > 0)) stalls.matches++;
        for (const x of record.stalls ?? []) stalls.recoveries += x.recoveries;
        consults.push(...record.consults);
        for (const n of Object.values(record.adviceApplied))
          adviceMessages += n;

        if (!record.decided) {
          // Counted, reported, and kept out of the rate: awarding an
          // unfinished match to whoever had more huts would be inventing a
          // result the sim declined to give.
          undecided++;
          continue;
        }
        trials++;
        const seat = perSeat.get(advisedSeat) ?? {wins: 0, trials: 0};
        seat.trials++;
        const won = record.winner === advisedSeat;
        if (won) {
          wins++;
          seat.wins++;
        }
        perSeat.set(advisedSeat, seat);

        // Against its OWN seating's control: with the playbooks swapped it
        // is a different game, so the other layout's control would score
        // the swap as a flip caused by advice.
        const control = layout.control;
        if (!control || !control.decided) flips.noControl++;
        else if (control.winner === record.winner) flips.unchanged++;
        else if (won) flips.toward++;
        else flips.away++;
      }
      // A control match is played for the comparison, not scored itself, but
      // its consultations (there are none) and length still belong to the run.
      if (layout.control) ticks.push(layout.control.ticks);
    }
  }

  const sortedTicks = [...ticks].sort((a, b) => a - b);

  return {
    advised: rateOf(wins, trials),
    bySeat: [...perSeat]
      .sort((a, b) => a[0] - b[0])
      .map(([seat, s]) => ({seat, rate: rateOf(s.wins, s.trials)})),
    undecided,
    stalls,
    flips,
    fingerprints: fingerprintsOf(runs),
    playbooks: matchupOf(runs),
    health: {
      consultations: consults.length,
      errors: consults.filter(c => c.error !== undefined).length,
      parseFailures: consults.filter(c => !c.error && c.parsed === false)
        .length,
      emptyAdvice: consults.filter(c => c.knobs === 0).length,
      adviceMessages,
    },
    matchTicks: {
      median: percentile(sortedTicks, 0.5),
      max: sortedTicks.length > 0 ? sortedTicks[sortedTicks.length - 1]! : 0,
    },
    wallSeconds,
  };
}
