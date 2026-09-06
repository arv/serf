import {describe, expect, it} from 'vitest';
import {Rng} from '../../src/shared/rng.ts';
import {AI_STRATEGIES} from '../../src/sim/defs/aiStrategies.ts';
import * as AiStrategyId from '../../src/sim/defs/aiStrategyIdEnum.ts';
import type {Owner} from '../../src/sim/entities.ts';
import {parseSeeds} from './bakeoff.ts';
import {
  bestChallenger,
  CONTROL_IDS,
  deltaOf,
  halvingPlan,
  pairedFlips,
  pairingsFor,
  promotes,
  randomDelta,
  sample,
  scoreOf,
  SeedDealer,
  survivors,
  trimLeague,
  type Individual,
  type Opponent,
  type Outcome,
  type Score,
} from './evolve.ts';
import {playbookOf} from './evolveWorker.ts';
import {moveOne, MUTABLE_RANGES, mutate, stepCount} from './mutate.ts';

const cand = (id: string): Individual => ({
  id,
  lineage: AiStrategyId.steward,
  delta: {},
  changes: '',
});
const opp = (label: string): Opponent => ({
  label,
  lineage: AiStrategyId.steward,
  delta: {},
});
const score = (
  wins: number,
  decided: number,
  undecided = 0,
  monument = 0,
): Score => ({
  wins,
  decided,
  undecided,
  monument,
  rate: decided ? wins / decided : 0,
});

describe('the round schedule', () => {
  it('plays every pairing in both seatings', () => {
    const ps = pairingsFor([cand('a'), cand('b')], [opp('x')], [1, 2]);
    expect(ps).toHaveLength(8);
    // The mirror is the whole null: each (candidate, opponent, seed) is
    // played once from each chair, so the map's head start cancels.
    for (const c of ['a', 'b']) {
      for (const seed of [1, 2]) {
        const seats = ps
          .filter(p => p.candidate === c && p.seed === seed)
          .map(p => p.candidateSeat);
        expect([...seats].sort((x, y) => x - y)).toEqual([0, 1]);
      }
    }
  });

  it('halves the field while doubling the seeds', () => {
    // In MUTANT slots. A population of eight is six mutants and the two
    // controls, and the controls are not a field that can be halved —
    // counting them here cut eight to six and then to four instead of to
    // four and then two, because `survivors` keeps `keep` NON-protected.
    expect(halvingPlan(6, 3, 4)).toEqual([
      {mutants: 6, newSeeds: 4},
      {mutants: 3, newSeeds: 8},
      {mutants: 2, newSeeds: 16},
    ]);
  });

  it('never races fewer than one mutant, however deep the plan', () => {
    for (const step of halvingPlan(3, 6, 1)) {
      expect(step.mutants).toBeGreaterThanOrEqual(1);
    }
  });

  it('cuts the field to what the plan says once controls are protected', () => {
    // The schedule and the selection have to agree: a plan step of three
    // mutants must leave three mutants standing, plus the two controls.
    const scores = new Map([
      ['inc', score(1, 10)],
      ['dice', score(2, 10)],
      ['m1', score(9, 10)],
      ['m2', score(8, 10)],
      ['m3', score(7, 10)],
      ['m4', score(6, 10)],
      ['m5', score(5, 10)],
      ['m6', score(4, 10)],
    ]);
    const plan = halvingPlan(6, 2, 2);
    const kept = survivors(scores, plan[1]!.mutants, CONTROL_IDS);
    expect(kept.filter(id => !CONTROL_IDS.has(id))).toEqual(['m1', 'm2', 'm3']);
    expect(kept).toHaveLength(5);
  });
});

describe('scoring', () => {
  const outcome = (over: Partial<Outcome>): Outcome => ({
    candidate: 'a',
    opponent: 'x',
    seed: 1,
    candidateSeat: 0 as Owner,
    winner: 0 as Owner,
    ticks: 100,
    decided: true,
    ...over,
  });

  it('scores a win from whichever chair the candidate sat in', () => {
    const s = scoreOf([
      outcome({candidateSeat: 0 as Owner, winner: 0 as Owner}),
      outcome({candidateSeat: 1 as Owner, winner: 1 as Owner}),
      outcome({candidateSeat: 1 as Owner, winner: 0 as Owner}),
    ]);
    expect(s).toMatchObject({wins: 2, decided: 3});
  });

  it('counts a monument ending whoever won it', () => {
    // Two ways to win, one percentage. The split has to be visible or a
    // champion good at the war and bad at the race prints the same number
    // as one good at both — and it is a property of the MATCH, not of the
    // candidate, so a monument the candidate lost to counts too.
    const s = scoreOf([
      outcome({byMonument: false}),
      outcome({winner: 1 as Owner, byMonument: true}),
      outcome({
        candidateSeat: 1 as Owner,
        winner: 1 as Owner,
        byMonument: true,
      }),
    ]);
    expect(s).toMatchObject({wins: 2, decided: 3, monument: 2});
  });

  it('excludes undecided matches rather than awarding them', () => {
    // Awarding a loss would score the map's stalls as strategy; awarding a
    // win would make a stalling candidate the champion.
    const s = scoreOf([
      outcome({}),
      outcome({decided: false, winner: null}),
      outcome({decided: true, winner: null}),
    ]);
    expect(s).toMatchObject({wins: 1, decided: 1, undecided: 2, rate: 1});
  });
});

describe('selection', () => {
  it('keeps the best and breaks ties without touching insertion order', () => {
    const scores = new Map([
      ['b', score(6, 10)],
      ['a', score(6, 10)],
      ['c', score(9, 10)],
    ]);
    expect(survivors(scores, 2)).toEqual(['c', 'a']);
    // Same scores, different insertion order, same survivors — a search
    // whose field depends on Map order cannot be replayed.
    const reordered = new Map([
      ['a', score(6, 10)],
      ['c', score(9, 10)],
      ['b', score(6, 10)],
    ]);
    expect(survivors(reordered, 2)).toEqual(survivors(scores, 2));
  });

  it('prefers the candidate that ends its matches when rates tie', () => {
    const scores = new Map([
      ['stally', {...score(5, 10), undecided: 7}],
      ['clean', {...score(5, 10), undecided: 0}],
    ]);
    expect(survivors(scores, 1)).toEqual(['clean']);
  });
});

describe('the controls', () => {
  it('never cuts a protected id, however badly it is scoring', () => {
    // The incumbent IS the comparison. A shakedown cut it in round one on
    // twelve trials and then promoted a challenger against it on a single
    // discordant pair, because the paired test only sees the trials both
    // sides played.
    const scores = new Map([
      ['inc', score(1, 10)],
      ['dice', score(2, 10)],
      ['m1', score(9, 10)],
      ['m2', score(8, 10)],
      ['m3', score(7, 10)],
    ]);
    const kept = survivors(scores, 2, new Set(['inc', 'dice']));
    expect(kept).toContain('inc');
    expect(kept).toContain('dice');
    // Two mutants besides the two controls, and the worst mutant is gone.
    expect(kept.filter(id => id.startsWith('m'))).toEqual(['m1', 'm2']);
  });

  it('keeps the ranking order it was given', () => {
    const scores = new Map([
      ['inc', score(1, 10)],
      ['m1', score(9, 10)],
    ]);
    expect(survivors(scores, 1, new Set(['inc']))).toEqual(['m1', 'inc']);
  });

  it('will not crown a control', () => {
    // A dice that wins is a verdict on the search, not a playbook. Crown
    // it and the next generation's "incumbent vs dice" line compares one
    // lottery ticket against another.
    const scores = new Map([
      ['dice', score(9, 10)],
      ['inc', score(8, 10)],
      ['m1', score(7, 10)],
    ]);
    expect(bestChallenger(scores, new Set(['inc', 'dice']))).toBe('m1');
  });

  it('has no challenger when every candidate is a control', () => {
    const scores = new Map([['dice', score(9, 10)]]);
    expect(bestChallenger(scores, new Set(['dice']))).toBeNull();
  });
});

describe('the promotion bar', () => {
  it('refuses a winning record too small to mean anything', () => {
    // Both of these promoted in the first shakedown.
    expect(promotes({won: 3, lost: 1, p: 0.625}, 8, 0.2)).toBe(false);
    expect(promotes({won: 1, lost: 0, p: 1}, 8, 0.2)).toBe(false);
  });

  it('promotes a record that clears both the count and the p', () => {
    expect(promotes({won: 12, lost: 2, p: 0.013}, 8, 0.2)).toBe(true);
  });

  it('refuses a losing record whatever its size', () => {
    expect(promotes({won: 4, lost: 20, p: 0.001}, 8, 0.2)).toBe(false);
  });
});

describe('the league', () => {
  it('keeps every shipped playbook and only the newest champions', () => {
    const shipped = [opp('steward'), opp('warlord')];
    const champs = [1, 2, 3, 4].map(n => ({
      label: `champ-g${n}`,
      lineage: AiStrategyId.steward,
      delta: {serfTarget: 10 + n},
    }));
    const kept = trimLeague([...shipped, ...champs], 2);
    expect(kept.map(o => o.label)).toEqual([
      'steward',
      'warlord',
      'champ-g3',
      'champ-g4',
    ]);
  });
});

describe('the paired promotion test', () => {
  const at = (
    id: string,
    seed: number,
    seat: Owner,
    winner: Owner | null,
  ): Outcome => ({
    candidate: id,
    opponent: 'x',
    seed,
    candidateSeat: seat,
    winner,
    ticks: 1,
    decided: winner !== null,
  });

  it('counts only the trials both sides played, and only where they differ', () => {
    const challenger = [
      at('c', 1, 0 as Owner, 0 as Owner), // won
      at('c', 2, 0 as Owner, 1 as Owner), // lost
      at('c', 3, 0 as Owner, 0 as Owner), // won
      at('c', 9, 0 as Owner, 0 as Owner), // the incumbent never played it
    ];
    const incumbent = [
      at('inc', 1, 0 as Owner, 1 as Owner), // lost → a flip toward
      at('inc', 2, 0 as Owner, 1 as Owner), // lost too → concordant
      at('inc', 3, 0 as Owner, 0 as Owner), // won too → concordant
    ];
    expect(pairedFlips(challenger, incumbent)).toMatchObject({won: 1, lost: 0});
  });

  it('refuses the same trial twice rather than picking one', () => {
    // A repeat would silently overwrite, and which trial survived would
    // depend on the order a jobs pool happened to finish in — so the
    // promotion decision would too.
    const twice = [
      at('inc', 1, 0 as Owner, 0 as Owner),
      at('inc', 1, 0 as Owner, 1 as Owner),
    ];
    expect(() => pairedFlips([], twice)).toThrow(/same trial twice/);
  });

  it('calls an even record no evidence', () => {
    const c = [
      at('c', 1, 0 as Owner, 0 as Owner),
      at('c', 2, 0 as Owner, 1 as Owner),
    ];
    const i = [
      at('inc', 1, 0 as Owner, 1 as Owner),
      at('inc', 2, 0 as Owner, 0 as Owner),
    ];
    const flips = pairedFlips(c, i);
    expect(flips).toMatchObject({won: 1, lost: 1});
    expect(flips.p).toBe(1);
  });
});

describe('candidates', () => {
  it('draws a random candidate inside every published range', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 50; i++) {
      const delta = randomDelta(rng);
      for (const [knob, [lo, hi]] of Object.entries(MUTABLE_RANGES)) {
        expect(delta[knob]).toBeGreaterThanOrEqual(lo);
        expect(delta[knob]).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('reports a delta of exactly what moved', () => {
    const base = AI_STRATEGIES[AiStrategyId.steward];
    const next = {...base, serfTarget: base.serfTarget + 3};
    expect(deltaOf(base, next)).toEqual({serfTarget: base.serfTarget + 3});
    expect(deltaOf(base, {...base})).toEqual({});
  });

  it('reports a revert to the printed value as a change', () => {
    // The exploiter bug: its delta was read against the base captured
    // BEFORE the generation promoted, so a mutation landing back on the
    // pre-champion value vanished. The champion's 4 then survived the
    // merge and the exploiter played was not the one mutate() produced —
    // nor the one added to the league.
    const printed = AI_STRATEGIES[AiStrategyId.steward];
    const champBase = {...printed, homeGuard: printed.homeGuard + 4};
    const reverted = {...champBase, homeGuard: printed.homeGuard};

    // Read against the champion, the revert is a change, as it must be.
    expect(deltaOf(champBase, reverted)).toEqual({
      homeGuard: printed.homeGuard,
    });
    // Read against the stale printed base, it disappears — the bug.
    expect(deltaOf(printed, reverted)).toEqual({});
  });

  it('reconstructs the mutated strategy from the champion delta it records', () => {
    const printed = AI_STRATEGIES[AiStrategyId.steward];
    const championDelta = {homeGuard: printed.homeGuard + 4, serfTarget: 16};
    const champBase = {...printed, ...championDelta};
    const mutated = {...champBase, homeGuard: printed.homeGuard};

    const recorded = {...championDelta, ...deltaOf(champBase, mutated)};
    const rebuilt = playbookOf({
      strategyId: AiStrategyId.steward,
      delta: recorded,
    });
    expect(rebuilt.homeGuard).toBe(mutated.homeGuard);
    expect(rebuilt.serfTarget).toBe(16);
  });

  it('carries a moved opening into the delta, and back out unchanged', () => {
    // The opening is only in the mutation space when --opening asks for
    // it, and the moment it is, deltaOf has to SEE it: a delta that misses
    // a change is not a smaller delta, it is a candidate played as
    // something other than what mutate() produced.
    const base = AI_STRATEGIES[AiStrategyId.mason];
    const rng = new Rng(4);
    let moved = mutate(base, rng, {knobs: 1, opening: true});
    for (let i = 0; i < 60 && !moved.changes.some(c => c.knob === 'build'); i++)
      moved = mutate(base, rng, {knobs: 1, opening: true});
    expect(moved.changes.some(c => c.knob === 'build')).toBe(true);

    const delta = deltaOf(base, moved.strategy);
    expect(delta['build']).toBeDefined();
    const rebuilt = playbookOf({
      strategyId: AiStrategyId.mason,
      delta,
    });
    expect(rebuilt.build).toEqual(moved.strategy.build);
  });

  it('leaves the opening alone unless it is asked for', () => {
    // The default pool is what every recorded number was measured against.
    const base = AI_STRATEGIES[AiStrategyId.mason];
    const rng = new Rng(9);
    for (let i = 0; i < 80; i++) {
      const m = mutate(base, rng, {knobs: 3});
      expect(m.strategy.build).toBe(base.build);
      expect(m.strategy.researchOrder).toBe(base.researchOrder);
    }
  });

  it('rebuilds a candidate as its lineage plus the delta, opening intact', () => {
    const base = AI_STRATEGIES[AiStrategyId.steward];
    const built = playbookOf({
      strategyId: AiStrategyId.steward,
      delta: {serfTarget: 16},
    });
    expect(built.serfTarget).toBe(16);
    // The opening is the hand-built prior the whole search leans on: it
    // rides by reference and is never a thing the wire can corrupt.
    expect(built.build).toBe(base.build);
    expect(built.researchOrder).toBe(base.researchOrder);
  });
});

describe('the opening operators', () => {
  it('moves an entry rather than dropping or inventing one', () => {
    const rng = new Rng(2);
    for (let i = 0; i < 50; i++) {
      const out = moveOne([1, 2, 3, 4], rng)!;
      expect(out).toHaveLength(4);
      expect([...out].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
      expect(out).not.toEqual([1, 2, 3, 4]);
    }
  });

  it('will not move a list too short to have an order', () => {
    expect(moveOne([7], new Rng(1))).toBeNull();
    expect(moveOne([], new Rng(1))).toBeNull();
  });

  it('nudges a count without ever reaching zero', () => {
    // A count of zero is a deleted step in disguise, and deleting a step
    // is not a neighbour of anything — it is a village with no bakery.
    const base = AI_STRATEGIES[AiStrategyId.mason].build;
    const rng = new Rng(6);
    for (let i = 0; i < 200; i++) {
      const out = stepCount(base, rng);
      if (!out) continue;
      expect(out).toHaveLength(base.length);
      for (const step of out) expect(step.count).toBeGreaterThanOrEqual(1);
      // Exactly one step differs, and only in its count.
      const diff = out.filter((b, i2) => b.count !== base[i2]!.count);
      expect(diff).toHaveLength(1);
    }
  });
});

describe('seeds', () => {
  it('deals the whole pool before repeating any of it', () => {
    const dealer = new SeedDealer([1, 2, 3, 4], new Rng(3));
    const first = dealer.take(4);
    expect([...first].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it('deals a different set to the next generation', () => {
    // A champion fitted to four valleys is not a champion, so consecutive
    // generations must not be judged on the same ground.
    const dealer = new SeedDealer([1, 2, 3, 4, 5, 6, 7, 8], new Rng(5));
    expect(dealer.take(4)).not.toEqual(dealer.take(4));
  });

  it('parses ranges, lists and a mix of both, and refuses the rest', () => {
    // The bake-off's own parser, shared rather than reimplemented: the
    // first draft here accepted `1,a` as [1, NaN] and swallowed a
    // backwards range as an empty list, either of which seeds a world
    // with nonsense or silently narrows a sweep.
    expect(parseSeeds('1-4')).toEqual([1, 2, 3, 4]);
    expect(parseSeeds('2,5')).toEqual([2, 5]);
    expect(parseSeeds('1-3,9')).toEqual([1, 2, 3, 9]);
    expect(() => parseSeeds('1,a')).toThrow(/integers/);
    // The refusal names the flag it was called for, not the one the
    // parser grew up in: a "--seeds" error shown to someone who typed
    // --train sends them to the wrong flag.
    expect(() => parseSeeds('4-1', '--train')).toThrow(/--train range/);
    expect(() => parseSeeds('1,,2', '--holdout')).toThrow(/--holdout has/);
    expect(() => parseSeeds('4-1')).toThrow(/backwards/);
    expect(() => parseSeeds('')).toThrow(/empty entry/);
    expect(() => parseSeeds('1,,2')).toThrow(/empty entry/);
  });

  it('samples deterministically from one seeded stream', () => {
    const pool = ['a', 'b', 'c', 'd'];
    expect(sample(pool, 2, new Rng(11))).toEqual(sample(pool, 2, new Rng(11)));
    expect(sample(pool, 9, new Rng(2))).toHaveLength(4);
  });
});
