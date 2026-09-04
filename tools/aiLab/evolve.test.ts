import {describe, expect, it} from 'vitest';
import {Rng} from '../../src/shared/rng.ts';
import {AI_STRATEGIES} from '../../src/sim/defs/aiStrategies.ts';
import * as AiStrategyId from '../../src/sim/defs/aiStrategyIdEnum.ts';
import type {Owner} from '../../src/sim/entities.ts';
import {
  deltaOf,
  halvingPlan,
  pairedFlips,
  pairingsFor,
  parseSeeds,
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
import {MUTABLE_RANGES} from './mutate.ts';

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
const score = (wins: number, decided: number, undecided = 0): Score => ({
  wins,
  decided,
  undecided,
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
    expect(halvingPlan(8, 3, 4)).toEqual([
      {contenders: 8, newSeeds: 4},
      {contenders: 4, newSeeds: 8},
      {contenders: 2, newSeeds: 16},
    ]);
  });

  it('never races fewer than two, however deep the plan', () => {
    for (const step of halvingPlan(3, 6, 1)) {
      expect(step.contenders).toBeGreaterThanOrEqual(2);
    }
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

  it('parses ranges, lists and a mix of both', () => {
    expect(parseSeeds('1-4')).toEqual([1, 2, 3, 4]);
    expect(parseSeeds('2,5')).toEqual([2, 5]);
    expect(parseSeeds('1-3,9')).toEqual([1, 2, 3, 9]);
  });

  it('samples deterministically from one seeded stream', () => {
    const pool = ['a', 'b', 'c', 'd'];
    expect(sample(pool, 2, new Rng(11))).toEqual(sample(pool, 2, new Rng(11)));
    expect(sample(pool, 9, new Rng(2))).toHaveLength(4);
  });
});
