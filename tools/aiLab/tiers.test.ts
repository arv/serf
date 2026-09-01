import {beforeAll, describe, expect, it} from 'vitest';
import {AI_STRATEGY_KEYS} from '../../src/sim/defs/aiStrategies.ts';
import * as AiStrategyId from '../../src/sim/defs/aiStrategyIdEnum.ts';
import {DIFFICULTY_KEYS} from '../../src/sim/defs/difficulty.ts';
import * as DifficultyId from '../../src/sim/defs/difficultyEnum.ts';
import {sweepTiers, wilson} from './tiers.ts';

/**
 * The tier ordering, pinned: normal beats easy, hard beats both.
 *
 * A regression pin rather than a measurement. The sim is deterministic, so
 * each of these duels has exactly one answer and there is no sampling here
 * to draw a conclusion from — the numbers to argue from are in README.md,
 * where `pnpm tiers` runs the same duels twenty-four seeds deep on two
 * independent ranges. What this file buys is that a change which INVERTS
 * the ordering fails CI instead of waiting for someone to remember to
 * re-run a sweep.
 *
 * Small for that reason: two seeds, four playbooks, both seatings is 16
 * duels a pair, which is enough to catch an inversion and nowhere near
 * enough to decide one. So the assertions are shaped to what 16 duels can
 * honestly carry — each pair merely must not go BACKWARDS, and the strict
 * majority is asked of the pooled three pairings and of hard-against-easy,
 * the widest and most robust gap (69.9% over 183 duels on the sweep, where
 * hard-against-normal is 58.3% over 127 and is the one an under-powered
 * pin would fail on a coin toss).
 *
 * A failure here means "go run `pnpm tiers 24` on both ranges", not "the
 * tier is broken".
 */

/** Two seeds, strided as the sweeps stride them. */
const SEEDS = [101, 108] as const;
/** Well past a decided duel at this size; the sweeps use 60k, and the
 * extra 20k buys suite time and nothing else. */
const MAX_TICKS = 40_000;
const STRATEGIES = [
  AiStrategyId.steward,
  AiStrategyId.warlord,
  AiStrategyId.abbot,
  AiStrategyId.fletcher,
];

type Tier = (typeof DifficultyId)[keyof typeof DifficultyId];

/** The three orderings, harder tier first. */
const PAIRS: [Tier, Tier][] = [
  [DifficultyId.normal, DifficultyId.easy],
  [DifficultyId.hard, DifficultyId.easy],
  [DifficultyId.hard, DifficultyId.normal],
];

interface Scored {
  label: string;
  wins: number;
  decided: number;
  rows: string;
}

describe('the difficulty tiers, against each other', () => {
  /**
   * Every pair once, in a hook rather than at collection time — 48 duels is
   * about a minute of work, and a file is collected before it is allowed to
   * take that long. Played once for all three assertions below, so the
   * suite pays for 48 duels and not 144.
   */
  const scored: Scored[] = [];
  beforeAll(() => {
    for (const [harder, weaker] of PAIRS) {
      const sweep = sweepTiers(
        harder,
        weaker,
        SEEDS,
        STRATEGIES,
        96,
        MAX_TICKS,
      );
      scored.push({
        label: `${DIFFICULTY_KEYS[harder]} v ${DIFFICULTY_KEYS[weaker]}`,
        wins: sweep.wins,
        decided: sweep.decided,
        rows: [...sweep.byStrategy]
          .map(([id, r]) => `${AI_STRATEGY_KEYS[id]} ${r.wins}/${r.decided}`)
          .join(', '),
      });
    }
  }, 300_000);
  const say = (s: Scored): string =>
    `${s.label}: ${s.wins}/${s.decided} — ${s.rows}`;

  it('never lets a harder tier fall behind a weaker one', () => {
    // Non-inferiority, which is all 16 duels can carry per pair. An
    // inversion — the harder tier losing the pairing outright — is what
    // this is here to catch.
    for (const s of scored) {
      expect(s.wins * 2, say(s)).toBeGreaterThanOrEqual(s.decided);
    }
  });

  it('wins the ordering pooled across the three pairings', () => {
    const wins = scored.reduce((n, s) => n + s.wins, 0);
    const decided = scored.reduce((n, s) => n + s.decided, 0);
    expect(
      wins * 2,
      `pooled ${wins}/${decided} — ${scored.map(say).join(' | ')}`,
    ).toBeGreaterThan(decided);
  });

  it('wins the widest gap outright: hard against easy', () => {
    const s = scored.find(x => x.label === 'hard v easy')!;
    expect(s.wins * 2, say(s)).toBeGreaterThan(s.decided);
  });

  it('scores a mirrored sweep against a 50% null', () => {
    // The arithmetic the sweeps' verdicts rest on, checked without playing
    // anything: an interval clear of 50 is a result, one straddling it is
    // not, and no duels at all is no information.
    expect(wilson(0, 0)).toEqual([0, 100]);
    const [lo, hi] = wilson(128, 183); // the recorded hard-v-easy sweep
    expect(lo).toBeGreaterThan(50);
    expect(hi).toBeLessThan(100);
    const [near] = wilson(53, 95); // ...and one that straddled it
    expect(near).toBeLessThan(50);
  });
});
