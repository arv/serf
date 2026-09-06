import {appendFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Rng} from '../../src/shared/rng.ts';
import {
  AI_STRATEGIES,
  AI_STRATEGY_KEYS,
  AI_STRATEGY_ORDER,
  type AiStrategy,
  type AiStrategyId,
} from '../../src/sim/defs/aiStrategies.ts';

import * as UnitTypeId from '../../src/sim/defs/unitTypeIdEnum.ts';
import type {Owner} from '../../src/sim/entities.ts';
import {parseSeeds} from './bakeoff.ts';
import {runMatchChild} from './childRun.ts';
import type {EvolveTask, SeatEntry} from './evolveWorker.ts';
import type {MatchConfig} from './match.ts';
import {
  describeMutation,
  MUTABLE_RANGES,
  mutate,
  type MutableKnob,
} from './mutate.ts';
import {wonByMonument} from './probe.ts';

/**
 * The playbook search: a population, a league, and a race.
 *
 * `mutate.ts` settled what a neighbour is and stopped there on purpose.
 * This is the loop it was written for, and the shape is AlphaStar's minus
 * everything that needed a datacentre — no network, no gradients, no
 * replays. What transfers from that work is not the model, it is the
 * *training protocol*: keep a population, keep beaten opponents around so
 * the search cannot forget how to beat them, and spend your evaluation
 * budget on the candidates still in contention.
 *
 * Three ideas, and the reason each is here rather than a simpler thing:
 *
 * - **A league, not a fixed sparring partner.** Fitness is a win rate
 *   against a set: the shipped playbooks, plus every champion this run has
 *   promoted, frozen. Hill-climbing against one opponent finds a counter to
 *   that opponent and calls it strength — and combat here is strongly
 *   non-transitive, so that failure is the default rather than the corner
 *   case. Beaten champions stay in the league precisely so a later
 *   candidate cannot win by forgetting them.
 * - **Racing, not sweeping.** The probe's own numbers say a ±5-point read
 *   needs ~385 trials. Paying that for every candidate would buy about two
 *   candidates an hour. Successive halving pays it only for the ones still
 *   alive: every contender plays the same seeds against the same opponents
 *   (common random numbers, so the comparison is paired), the field halves,
 *   the seed budget doubles, and a hopeless candidate dies after four seeds
 *   instead of two hundred.
 * - **Controls in the population.** Two individuals every generation are
 *   not mutants: the incumbent champion, unchanged, and a `dice` candidate
 *   redrawn at random from the knob ranges. A generation that cannot beat
 *   its own incumbent has not found anything, and a search that cannot beat
 *   dice is not a search — the bake-off recorded random advice at 47%, and
 *   that number is the floor this loop still has to clear.
 *
 * What it does NOT search is the opening: `build` and `researchOrder` pass
 * through untouched (mutate.ts asserts it). Those arrays are the hand-built
 * prior this whole loop leans on — the reason a search is possible here at
 * all without a corpus of human games to imitate first. A candidate starts
 * from a playbook that already plays.
 *
 * Candidates go in as BASE playbooks (AiSeats' `playbooks` seam), not as
 * advice. Advice outranks the stance cascade, so a searched-by-advice
 * winner would be tuned for a game with the moods switched off and would
 * arrive in the shipped one a different animal.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WORKER = `${HERE}evolveWorker.ts`;

/**
 * The two individuals in every population that are not mutants: the
 * incumbent champion unchanged, and a candidate redrawn at random. Neither
 * can be raced out and neither can be crowned — they are the generation's
 * two reference points, and a reference that can be eliminated or promoted
 * is not one.
 */
export const CONTROL_IDS: ReadonlySet<string> = new Set(['inc', 'dice']);

/** Knobs laid over a lineage — a candidate, in the only terms that vary. */
export type Delta = Record<string, unknown>;

export interface Individual {
  /** Stable within a run, and printed: `g2m05`, `inc`, `dice`. */
  id: string;
  lineage: AiStrategyId;
  delta: Delta;
  /** What the mutation changed, for the run log. */
  changes: string;
}

/** A frozen opponent: a shipped playbook, or a champion this run promoted. */
export interface Opponent {
  label: string;
  lineage: AiStrategyId;
  delta: Delta;
}

export interface Pairing {
  candidate: string;
  opponent: string;
  seed: number;
  /** Which seat the candidate sits in. Every pairing is played in both,
   * so whatever head start the valley gives a seat is worn by each side
   * equally and the null is 50% by construction. */
  candidateSeat: Owner;
}

export interface Outcome extends Pairing {
  winner: Owner | null;
  ticks: number;
  decided: boolean;
  /**
   * Won on a finished monument rather than a razed castle. The monument is
   * the second way to win in every mode (systems/victory.ts) and is checked
   * BEFORE the elimination rules, so a win rate pools two different games —
   * the war, and the race to haul sixty-odd goods to the middle of the map.
   * A champion that wins one and loses the other prints the same rate as
   * one that is good at both, and the search would promote either.
   *
   * Recorded, not optimized: what a search can reach here is the economy
   * that FUNDS a monument, never the monument itself — `build` is frozen
   * out of the mutation space, and the monument is a build step.
   */
  byMonument?: boolean;
}

export interface Score {
  wins: number;
  decided: number;
  undecided: number;
  rate: number;
  /** Of the decided matches, how many ended on a monument. */
  monument: number;
}

/** Every match a round owes: each candidate against each opponent, both
 * seatings. Deterministic order, because the run log is evidence. */
export function pairingsFor(
  candidates: readonly Individual[],
  opponents: readonly Opponent[],
  seeds: readonly number[],
): Pairing[] {
  const out: Pairing[] = [];
  for (const c of candidates) {
    for (const o of opponents) {
      for (const seed of seeds) {
        out.push({candidate: c.id, opponent: o.label, seed, candidateSeat: 0});
        out.push({candidate: c.id, opponent: o.label, seed, candidateSeat: 1});
      }
    }
  }
  return out;
}

/** Undecided matches are excluded from the rate and counted beside it: a
 * candidate that cannot end a game is not a winner, but awarding it a loss
 * would score the map's stalls as strategy. */
export function scoreOf(outcomes: readonly Outcome[]): Score {
  let wins = 0;
  let decided = 0;
  let undecided = 0;
  let monument = 0;
  for (const o of outcomes) {
    if (!o.decided || o.winner === null) {
      undecided++;
      continue;
    }
    decided++;
    if (o.byMonument) monument++;
    if (o.winner === o.candidateSeat) wins++;
  }
  return {
    wins,
    decided,
    undecided,
    monument,
    rate: decided ? wins / decided : 0,
  };
}

/**
 * The race schedule: how many MUTANTS each round carries and how many NEW
 * seeds it adds. The field halves as the budget doubles, so every round
 * costs about the same and the last one is spent entirely on candidates
 * that have already survived something.
 *
 * Mutants, not candidates: the controls ride every round whatever they
 * score (see `survivors`), so they are not a field that can be halved and
 * counting them here would halve the wrong number. The first draft passed
 * the whole population in and, because `keep` means non-protected, cut a
 * field of eight to six and then to four instead of to four and then two —
 * a schedule that printed one cost and paid another.
 */
export function halvingPlan(
  mutants: number,
  rounds: number,
  firstSeeds: number,
): {mutants: number; newSeeds: number}[] {
  const plan: {mutants: number; newSeeds: number}[] = [];
  let alive = Math.max(1, mutants);
  let seeds = Math.max(1, firstSeeds);
  for (let i = 0; i < Math.max(1, rounds); i++) {
    plan.push({mutants: alive, newSeeds: seeds});
    alive = Math.max(1, Math.ceil(alive / 2));
    seeds *= 2;
  }
  return plan;
}

/**
 * Who survives a round, best first. Ties break on fewer undecided matches
 * and then on id — never on iteration order, because a search whose
 * survivors depend on a Map's insertion order cannot be replayed.
 */
export function survivors(
  scores: ReadonlyMap<string, Score>,
  keep: number,
  protectedIds: ReadonlySet<string> = new Set(),
): string[] {
  const ranked = [...scores.entries()]
    .sort((a, b) => {
      if (b[1].rate !== a[1].rate) return b[1].rate - a[1].rate;
      if (a[1].undecided !== b[1].undecided)
        return a[1].undecided - b[1].undecided;
      return a[0] < b[0] ? -1 : 1;
    })
    .map(([id]) => id);
  // The controls ride to the end whatever they score. The first shakedown
  // cut the incumbent in round one on twelve trials and then compared the
  // generation's winner against it anyway — a reference measured at a
  // twentieth of the challenger's budget. Worse, the promotion test reads
  // only the trials both sides played, so an early-cut incumbent starves
  // the very comparison that decides the generation: it promoted on a
  // single discordant trial.
  const chosen = new Set(ranked.filter(id => protectedIds.has(id)));
  for (const id of ranked) {
    if (protectedIds.has(id)) continue;
    if (chosen.size - protectedIds.size >= Math.max(1, keep)) break;
    chosen.add(id);
  }
  return ranked.filter(id => chosen.has(id));
}

/**
 * The generation's challenger: the best candidate that is ELIGIBLE to
 * wear the crown, which the controls are not.
 *
 * `dice` is in the population to say whether the search beat redrawing
 * the knobs at random, and a control that can be promoted stops being
 * one — the first shakedown crowned the dice in generation 1, and from
 * generation 2 the incumbent WAS a random draw, so every "incumbent vs
 * dice" line after it compared one lottery ticket against another. A
 * generation the dice wins is a finding about the search, and the report
 * says so rather than banking it.
 */
export function bestChallenger(
  scores: ReadonlyMap<string, Score>,
  ineligible: ReadonlySet<string>,
): string | null {
  const ranked = survivors(scores, scores.size);
  return ranked.find(id => !ineligible.has(id)) ?? null;
}

/**
 * Is a challenger's paired record enough to take the crown?
 *
 * `won > lost` alone is not: the first shakedown promoted on 3-versus-1
 * and then on 1-versus-0, which is noise wearing a champion's hat, and a
 * league that fills with noise is worse than no league — every later
 * generation then spends its budget beating ghosts. So a promotion also
 * needs enough discordant pairs to have said anything (`minPairs`) and a
 * two-sided p at or under `maxP`.
 */
export function promotes(
  paired: {won: number; lost: number; p: number},
  minPairs: number,
  maxP: number,
): boolean {
  return (
    paired.won > paired.lost &&
    paired.won + paired.lost >= minPairs &&
    paired.p <= maxP
  );
}

/** The league, bounded: every shipped playbook always, plus the most
 * recent champions. Dropping the oldest rather than the weakest is on
 * purpose — a champion is in the league to be an obstacle, and the ones
 * worth keeping are the ones the current search has not yet answered. */
export function trimLeague(
  league: readonly Opponent[],
  maxChampions: number,
): Opponent[] {
  const shipped = league.filter(o => Object.keys(o.delta).length === 0);
  const champions = league.filter(o => Object.keys(o.delta).length > 0);
  return [...shipped, ...champions.slice(-Math.max(0, maxChampions))];
}

/**
 * A candidate drawn from nothing — the noise floor, in the population.
 *
 * Deliberately NOT engines.ts's `randomEngine`: that one's RNG stream is
 * load-bearing for the recorded 46.6% / 47.0% baselines and must not be
 * disturbed. This draws the same ranges for a different purpose.
 */
export function randomDelta(rng: Rng): Delta {
  const delta: Delta = {};
  for (const [knob, [lo, hi]] of Object.entries(MUTABLE_RANGES)) {
    delta[knob] = lo + rng.int(hi - lo + 1);
  }
  delta['prefersRivals'] = rng.next() < 0.5;
  delta['trainPreference'] = [
    rng.pick([UnitTypeId.knight, UnitTypeId.spearman, UnitTypeId.archer]),
  ];
  delta['weaponMix'] = [rng.int(3), rng.int(3)];
  return delta;
}

/** The knobs a candidate actually moved off its lineage, for the report. */
export function deltaOf(base: AiStrategy, next: AiStrategy): Delta {
  const delta: Delta = {};
  for (const knob of Object.keys(MUTABLE_RANGES) as MutableKnob[]) {
    if (next[knob] !== base[knob]) delta[knob] = next[knob];
  }
  if (next.prefersRivals !== base.prefersRivals)
    delta['prefersRivals'] = next.prefersRivals;
  if (String(next.trainPreference) !== String(base.trainPreference))
    delta['trainPreference'] = [...next.trainPreference];
  if (String(next.weaponMix) !== String(base.weaponMix))
    delta['weaponMix'] = [...next.weaponMix];
  return delta;
}

function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.959964;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - s) / d, (c + s) / d];
}

/** Two-sided exact binomial at p = 0.5 — the paired test the promotion
 * rule reads, and the same one the probe prints. */
export function binomP(k: number, n: number): number {
  if (n === 0) return 1;
  const logC = (a: number, b: number): number => {
    let r = 0;
    for (let i = 1; i <= b; i++) r += Math.log(a - b + i) - Math.log(i);
    return r;
  };
  const pmf = (i: number): number => Math.exp(logC(n, i) - n * Math.LN2);
  const obs = pmf(k) * (1 + 1e-9);
  let p = 0;
  for (let i = 0; i <= n; i++) if (pmf(i) <= obs) p += pmf(i);
  return Math.min(1, p);
}

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;

export interface RunOptions {
  lineage: AiStrategyId;
  generations: number;
  population: number;
  rounds: number;
  firstSeeds: number;
  opponentsPerGen: number;
  leagueChampions: number;
  exploiter: boolean;
  exploiterBar: number;
  /** Discordant pairs a promotion needs before it means anything. */
  minPairs: number;
  /** Two-sided p a promotion has to clear. */
  maxP: number;
  trainSeeds: readonly number[];
  holdoutSeeds: readonly number[];
  mapSize: number;
  maxTicks: number;
  jobs: number;
  seed: number;
  out: string | null;
  matchTimeoutMs: number;
}

function baseConfig(
  seed: number,
  o: RunOptions,
): Omit<MatchConfig, 'engines' | 'playbooks'> {
  return {
    seed,
    mapSize: o.mapSize,
    bandits: true,
    // Seat ids are what the sim plays; the playbook each seat actually
    // wears is handed in beside them, so these two only have to be AI.
    strategies: [o.lineage, o.lineage],
    maxTicks: o.maxTicks,
    advicePeriod: 1800,
    adviceStagger: 300,
    latencyTicks: 0,
  };
}

function play(
  p: Pairing,
  cand: SeatEntry,
  opp: SeatEntry,
  o: RunOptions,
): Promise<Outcome> {
  const task: EvolveTask = {
    config: baseConfig(p.seed, o),
    seats: p.candidateSeat === 0 ? [cand, opp] : [opp, cand],
  };
  return runMatchChild(WORKER, task, o.matchTimeoutMs).then(rec =>
    rec === null
      ? {...p, winner: null, ticks: 0, decided: false}
      : {
          ...p,
          winner: rec.winner,
          ticks: rec.ticks,
          decided: rec.decided,
          byMonument: wonByMonument(rec),
        },
  );
}

async function playAll(
  pairings: readonly Pairing[],
  entry: (id: string) => SeatEntry,
  oppEntry: (label: string) => SeatEntry,
  o: RunOptions,
  note: (done: number, total: number) => void,
): Promise<Outcome[]> {
  const out: Outcome[] = [];
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({length: o.jobs}, async () => {
      for (;;) {
        const i = next++;
        if (i >= pairings.length) return;
        const p = pairings[i]!;
        out.push(await play(p, entry(p.candidate), oppEntry(p.opponent), o));
        note(++done, pairings.length);
      }
    }),
  );
  return out;
}

/** The paired question the promotion rule asks: on the trials both played,
 * how often did the challenger win where the incumbent lost, and the
 * reverse? Concordant trials carry no evidence, exactly as in McNemar's. */
export function pairedFlips(
  challenger: readonly Outcome[],
  incumbent: readonly Outcome[],
): {won: number; lost: number; p: number} {
  const mine = new Map<string, Outcome>();
  for (const o of incumbent)
    mine.set(`${o.opponent}|${o.seed}|${o.candidateSeat}`, o);
  let won = 0;
  let lost = 0;
  for (const c of challenger) {
    const i = mine.get(`${c.opponent}|${c.seed}|${c.candidateSeat}`);
    if (!i || !c.decided || !i.decided) continue;
    const cWon = c.winner === c.candidateSeat;
    const iWon = i.winner === i.candidateSeat;
    if (cWon && !iWon) won++;
    if (!cWon && iWon) lost++;
  }
  return {won, lost, p: binomP(won, won + lost)};
}

/** Deterministic sample without replacement — the league is walked by the
 * run's own dice so a rerun faces the same opponents. */
export function sample<T>(pool: readonly T[], n: number, rng: Rng): T[] {
  const bag = [...pool];
  const out: T[] = [];
  while (out.length < Math.min(n, pool.length)) {
    out.push(...bag.splice(rng.int(bag.length), 1));
  }
  return out;
}

/** Seeds handed out across a run, reshuffled when the pool runs dry, so a
 * later generation is not judged on the valleys that shaped an earlier
 * one. A champion fitted to six maps is not a champion. */
export class SeedDealer {
  #pool: number[] = [];
  #all: readonly number[];
  #rng: Rng;

  constructor(all: readonly number[], rng: Rng) {
    this.#all = all;
    this.#rng = rng;
  }

  take(n: number): number[] {
    const out: number[] = [];
    while (out.length < n) {
      if (this.#pool.length === 0)
        this.#pool = sample(this.#all, this.#all.length, this.#rng);
      out.push(this.#pool.pop()!);
    }
    return out;
  }
}

function strategyFor(lineage: AiStrategyId, delta: Delta): AiStrategy {
  return {...AI_STRATEGIES[lineage], ...delta} as AiStrategy;
}

export async function run(o: RunOptions): Promise<void> {
  const rng = new Rng(o.seed);
  const dealer = new SeedDealer(o.trainSeeds, rng);
  const log = (line: object): void => {
    if (o.out) appendFileSync(o.out, `${JSON.stringify(line)}\n`);
  };

  let champion: Individual = {
    id: 'inc',
    lineage: o.lineage,
    delta: {},
    changes: 'the printed line',
  };
  let league: Opponent[] = AI_STRATEGY_ORDER.map(id => ({
    label: AI_STRATEGY_KEYS[id],
    lineage: id,
    delta: {},
  }));

  const plan = halvingPlan(
    o.population - CONTROL_IDS.size,
    o.rounds,
    o.firstSeeds,
  );
  // The controls play every round too, so the estimate has to count them
  // or the header promises a cheaper sweep than the loop runs.
  const perGen = plan.reduce(
    (n, step) =>
      n +
      (step.mutants + CONTROL_IDS.size) * o.opponentsPerGen * step.newSeeds * 2,
    0,
  );
  console.log(
    `evolve — lineage ${AI_STRATEGY_KEYS[o.lineage]}, ${o.generations} ` +
      `generations of ${o.population}, race ${plan
        .map(s => `${s.mutants + CONTROL_IDS.size}×${s.newSeeds}`)
        .join(' → ')}, ${o.opponentsPerGen} opponents\n` +
      `  ~${perGen} matches per generation, ~${perGen * o.generations} total ` +
      `plus holdout, jobs ${o.jobs}\n`,
  );
  log({kind: 'run', options: {...o}});

  const started = Date.now();
  for (let g = 1; g <= o.generations; g++) {
    const opponents = sample(league, o.opponentsPerGen, rng);
    const base = strategyFor(champion.lineage, champion.delta);

    const pop: Individual[] = [
      {
        ...champion,
        id: 'inc',
        // Its own label, not the mutation that made it: an incumbent
        // printing "redrawn at random" three generations later reads as
        // if the control were the champion.
        changes: g === 1 ? 'the printed line' : `the champion (${champion.id})`,
      },
      {
        id: 'dice',
        lineage: o.lineage,
        delta: randomDelta(rng),
        changes: 'redrawn at random — the noise floor, in the population',
      },
    ];
    for (let i = pop.length; i < o.population; i++) {
      const m = mutate(base, rng, {knobs: 1 + (i % 2)});
      pop.push({
        id: `g${g}m${String(i).padStart(2, '0')}`,
        lineage: champion.lineage,
        delta: {...champion.delta, ...deltaOf(base, m.strategy)},
        changes: describeMutation(m),
      });
    }

    const byId = new Map(pop.map(i => [i.id, i]));
    const oppById = new Map(opponents.map(o2 => [o2.label, o2]));
    const entry = (id: string): SeatEntry => {
      const i = byId.get(id)!;
      return {strategyId: i.lineage, delta: i.delta};
    };
    const oppEntry = (label: string): SeatEntry => {
      const x = oppById.get(label)!;
      return {strategyId: x.lineage, delta: x.delta};
    };

    const seen = new Map<string, Outcome[]>(pop.map(i => [i.id, []]));
    let alive = pop;
    for (const [i, step] of plan.entries()) {
      const seeds = dealer.take(step.newSeeds);
      const pairings = pairingsFor(alive, opponents, seeds);
      const outcomes = await playAll(pairings, entry, oppEntry, o, (d, t) => {
        if (d % 20 === 0)
          process.stderr.write(`  gen ${g} round ${i + 1}: ${d}/${t}\n`);
      });
      for (const out of outcomes) seen.get(out.candidate)!.push(out);
      const scores = new Map(
        alive.map(c => [c.id, scoreOf(seen.get(c.id)!)] as const),
      );
      const cut = plan[i + 1]?.mutants ?? alive.length;
      const keep = new Set(survivors(scores, cut, CONTROL_IDS));
      log({
        kind: 'round',
        generation: g,
        round: i + 1,
        seeds,
        opponents: opponents.map(x => x.label),
        scores: [...scores].map(([id, s]) => ({id, ...s})),
      });
      alive = alive.filter(c => keep.has(c.id));
      if (i === plan.length - 1) break;
    }

    const finalScores = new Map(
      pop
        .filter(c => seen.get(c.id)!.length > 0)
        .map(c => [c.id, scoreOf(seen.get(c.id)!)] as const),
    );
    const contended = new Map(
      [...finalScores].filter(([id]) => alive.some(a => a.id === id)),
    );
    const bestId = bestChallenger(contended, CONTROL_IDS);
    const incScore = finalScores.get('inc')!;
    const diceScore = finalScores.get('dice')!;
    const paired = bestId
      ? pairedFlips(seen.get(bestId)!, seen.get('inc')!)
      : {won: 0, lost: 0, p: 1};
    const best = bestId ? byId.get(bestId)! : null;

    console.log(
      `GENERATION ${g}  vs ${opponents.map(x => x.label).join(', ')}`,
    );
    for (const [id, s] of [...finalScores].sort(
      (a, b) => b[1].rate - a[1].rate,
    )) {
      const [lo, hi] = wilson(s.wins, s.decided);
      const c = byId.get(id)!;
      console.log(
        `  ${id.padEnd(7)} ${String(s.wins).padStart(3)}/${String(s.decided).padEnd(3)}` +
          ` ${pct(s.rate).padStart(6)} [${pct(lo)}, ${pct(hi)}]` +
          `${s.undecided ? ` undec ${s.undecided}` : ''}` +
          `${s.monument ? ` mon ${s.monument}` : ''}` +
          `${id === bestId ? '  ←' : '   '} ${c.changes}`,
      );
    }

    const better = best !== null && promotes(paired, o.minPairs, o.maxP);
    console.log(
      `  incumbent ${pct(incScore.rate)} · dice ${pct(diceScore.rate)} · ` +
        `challenger ${bestId ?? '—'} paired ${paired.won}/${paired.lost} ` +
        `(p = ${paired.p.toFixed(3)}, needs ${o.minPairs} pairs at p ≤ ${o.maxP}) — ` +
        `${better ? 'PROMOTED' : 'no promotion'}`,
    );
    if (
      diceScore.rate > incScore.rate &&
      (!best || diceScore.rate >= finalScores.get(best.id)!.rate)
    ) {
      // Not a champion — a verdict on the generation. The bake-off's whole
      // discipline is that an advisor which cannot beat dice is not an
      // advisor; the same goes for a search.
      console.log(
        `  NOTE: the dice outscored every candidate this generation — ` +
          `that is a result about the search, not a playbook.`,
      );
    }
    console.log('');
    log({
      kind: 'generation',
      generation: g,
      best: bestId,
      promoted: better,
      paired,
      scores: [...finalScores].map(([id, s]) => ({id, ...s})),
    });

    if (better && best) {
      champion = {...best, id: `champ-g${g}`};
      league = trimLeague(
        [
          ...league,
          {label: `champ-g${g}`, lineage: best.lineage, delta: best.delta},
        ],
        o.leagueChampions,
      );

      // The main-exploiter analogue: a lineage bred to beat the CURRENT
      // champion and nothing else. It never takes the crown — it joins the
      // league, so the next generation has to answer it. This is the one
      // piece of AlphaStar that has no cheaper substitute: without it a
      // population climbs until it is merely unbeaten by its own children.
      if (o.exploiter) {
        const ex = mutate(strategyFor(champion.lineage, champion.delta), rng, {
          knobs: 2,
        });
        const exId = `exploit-g${g}`;
        const exInd: Individual = {
          id: exId,
          lineage: champion.lineage,
          delta: {...champion.delta, ...deltaOf(base, ex.strategy)},
          changes: describeMutation(ex),
        };
        const champOpp: Opponent = {
          label: 'champion',
          lineage: champion.lineage,
          delta: champion.delta,
        };
        const seeds = dealer.take(o.firstSeeds);
        const outs = await playAll(
          pairingsFor([exInd], [champOpp], seeds),
          () => ({strategyId: exInd.lineage, delta: exInd.delta}),
          () => ({strategyId: champOpp.lineage, delta: champOpp.delta}),
          o,
          () => {},
        );
        const s = scoreOf(outs);
        const joins = s.decided > 0 && s.rate >= o.exploiterBar;
        console.log(
          `  exploiter ${exId}: ${pct(s.rate)} vs the champion — ` +
            `${joins ? 'joins the league' : 'discarded'} (${exInd.changes})\n`,
        );
        log({kind: 'exploiter', generation: g, id: exId, ...s, joins});
        if (joins) {
          league = trimLeague(
            [
              ...league,
              {label: exId, lineage: exInd.lineage, delta: exInd.delta},
            ],
            o.leagueChampions,
          );
        }
      }
    }
  }

  // The holdout: the champion and the printed line it came from, against
  // every shipped playbook, on seeds the search never touched. A search
  // scores its own winner, and a winner picked out of a field is biased
  // upward by the picking; this is the number that is not.
  console.log(
    'HOLDOUT — seeds the search never saw, vs every shipped playbook',
  );
  const shipped: Opponent[] = AI_STRATEGY_ORDER.map(id => ({
    label: AI_STRATEGY_KEYS[id],
    lineage: id,
    delta: {},
  }));
  const arms: Individual[] = [
    {
      id: 'champion',
      lineage: champion.lineage,
      delta: champion.delta,
      changes: champion.changes,
    },
    {id: 'printed', lineage: o.lineage, delta: {}, changes: 'the shipped line'},
  ];
  const byArm = new Map(arms.map(a => [a.id, a]));
  const outs = await playAll(
    pairingsFor(arms, shipped, o.holdoutSeeds),
    id => {
      const a = byArm.get(id)!;
      return {strategyId: a.lineage, delta: a.delta};
    },
    label => {
      const s = shipped.find(x => x.label === label)!;
      return {strategyId: s.lineage, delta: s.delta};
    },
    o,
    (d, t) => {
      if (d % 20 === 0) process.stderr.write(`  holdout: ${d}/${t}\n`);
    },
  );
  const champOuts = outs.filter(x => x.candidate === 'champion');
  const printOuts = outs.filter(x => x.candidate === 'printed');
  for (const [label, set] of [
    ['champion', champOuts],
    ['printed ', printOuts],
  ] as const) {
    const s = scoreOf(set);
    const [lo, hi] = wilson(s.wins, s.decided);
    console.log(
      `  ${label}  ${s.wins}/${s.decided}  ${pct(s.rate)} [${pct(lo)}, ${pct(hi)}]` +
        `${s.undecided ? ` · undecided ${s.undecided}` : ''}` +
        ` · won on a monument ${s.monument}`,
    );
  }
  const hp = pairedFlips(champOuts, printOuts);
  console.log(
    `  paired on the same valleys: ${hp.won} toward the champion, ` +
      `${hp.lost} away (p = ${hp.p.toFixed(3)})`,
  );
  console.log('');
  console.log(`CHAMPION (${champion.id}) — ${champion.changes}`);
  console.log(`  ${JSON.stringify(champion.delta)}`);
  console.log('');
  console.log(`  ${((Date.now() - started) / 1000).toFixed(0)}s wall.`);
  log({
    kind: 'holdout',
    champion: champion.delta,
    champScore: scoreOf(champOuts),
    printedScore: scoreOf(printOuts),
    paired: hp,
  });
}

const HELP = `serf-valley playbook search

  node --experimental-strip-types tools/aiLab/evolve.ts [options]

  --lineage <id>        playbook to descend from (default: steward)
  --generations <n>     generations to run (default: 3)
  --population <n>      candidates per generation, incumbent and dice
                        included, so at least 3 (default: 8)
  --rounds <n>          racing rounds; the field halves and the seed
                        budget doubles each one (default: 3)
  --first-seeds <n>     seeds in the first racing round (default: 4)
  --opponents <n>       league members each generation is scored against
                        (default: 2)
  --league <n>          champions kept in the league besides the shipped
                        playbooks (default: 4)
  --min-pairs <n>       discordant pairs a promotion needs (default: 8)
  --max-p <f>           two-sided p a promotion must clear (default: 0.2)
  --no-exploiter        skip the per-generation exploiter
  --exploiter-bar <f>   win rate an exploiter needs against the champion
                        to join the league (default: 0.6)
  --train <a-b>         seed pool the search may use (default: 1-200)
  --holdout <a-b>       seeds kept back for the final score, and never
                        dealt to the search (default: 301-340)
  --map <n>             grid side (default: 96)
  --max-ticks <n>       undecided past here (default: 120000)
  --jobs <n>            matches in parallel (default: 4)
  --seed <n>            the run's own dice (default: 1)
  --out <file>          JSONL record of every round
  --match-timeout-ms <n>  wall-clock ceiling per match (default: 300000)

  Cost is (contenders × opponents × seeds × 2) summed over the rounds,
  per generation. The header prints it before anything is played.
`;

function num(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  if (i < 0) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

function str(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i < 0 ? fallback : (process.argv[i + 1] ?? fallback);
}

export function parseLineage(word: string): AiStrategyId {
  for (const id of AI_STRATEGY_ORDER) {
    if (AI_STRATEGY_KEYS[id] === word) return id;
  }
  throw new Error(
    `--lineage wants one of ${AI_STRATEGY_ORDER.map(i => AI_STRATEGY_KEYS[i]).join(', ')}, got "${word}"`,
  );
}

export function optionsFromArgv(): RunOptions {
  const train = parseSeeds(str('--train', '1-200'));
  const holdout = parseSeeds(str('--holdout', '301-340'));
  const overlap = train.filter((s: number) => holdout.includes(s));
  if (overlap.length > 0) {
    // A holdout the search has already been fitted to is not a holdout,
    // and the failure is silent — the number still prints.
    throw new Error(
      `--train and --holdout share ${overlap.length} seed(s): ${overlap.slice(0, 5).join(', ')}`,
    );
  }
  const population = num('--population', 8);
  if (population <= CONTROL_IDS.size) {
    // The population counts the incumbent and the dice, so anything at or
    // under two is a run with no mutants in it — a search that can only
    // ever re-elect what it started with, while halvingPlan's floor of one
    // mutant slot makes the printed schedule claim otherwise.
    throw new Error(
      `--population ${population} leaves no mutants: it counts the ` +
        `${CONTROL_IDS.size} controls, so it must be at least ${CONTROL_IDS.size + 1}`,
    );
  }
  return {
    lineage: parseLineage(str('--lineage', 'steward')),
    generations: num('--generations', 3),
    population,
    rounds: num('--rounds', 3),
    firstSeeds: num('--first-seeds', 4),
    opponentsPerGen: num('--opponents', 2),
    leagueChampions: num('--league', 4),
    exploiter: !process.argv.includes('--no-exploiter'),
    exploiterBar: num('--exploiter-bar', 0.6),
    minPairs: num('--min-pairs', 8),
    maxP: num('--max-p', 0.2),
    trainSeeds: train,
    holdoutSeeds: holdout,
    mapSize: num('--map', 96),
    maxTicks: num('--max-ticks', 120_000),
    jobs: num('--jobs', 4),
    seed: num('--seed', 1),
    out: process.argv.includes('--out')
      ? str('--out', 'runs/evolve.jsonl')
      : null,
    matchTimeoutMs: num('--match-timeout-ms', 300_000),
  };
}

if (process.argv[1]?.endsWith('evolve.ts')) {
  if (process.argv.includes('--help')) {
    console.log(HELP);
  } else {
    await run(optionsFromArgv());
  }
}
