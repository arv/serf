import {beforeAll, describe, expect, it} from 'vitest';
import {AI_STRATEGY_KEYS} from '../../src/sim/defs/aiStrategies.ts';
import * as AiStrategyId from '../../src/sim/defs/aiStrategyIdEnum.ts';
import {DIFFICULTY_KEYS} from '../../src/sim/defs/difficulty.ts';
import * as DifficultyId from '../../src/sim/defs/difficultyEnum.ts';
import {sweepTiers, wilson, type DuelSweep} from './tiers.ts';

/**
 * The tier ordering, pinned: normal beats easy, hard beats both, and hard
 * all but never loses a valley to easy that the valley did not decide
 * itself (one in 192 pairs on the full sweeps).
 *
 * That last clause is the assertion to read, and the reason the headline
 * here is a pair tally rather than a percentage. A mirrored win rate
 * cannot reach 100% on this map generator however strong a tier is: some
 * seeds deal two starts so unequal that whoever holds the better one wins
 * BOTH seatings whatever tier is sitting there, and each such seed
 * contributes one win and one loss to the rate forever. Pairing the
 * seatings separates the valley from the tier — see PairTally in tiers.ts
 * — and `lostBoth === 0` is what "it always wins" honestly means.
 *
 * A regression pin, not a measurement: the sim is deterministic, so each
 * duel here has exactly one answer and there is no sampling to conclude
 * from. The numbers to argue from are in README.md, twenty-four seeds deep
 * on two independent ranges. A failure here means "go run `pnpm tiers 24`
 * on both ranges", not "the tier is broken".
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

const PAIRS: [Tier, Tier][] = [
  [DifficultyId.normal, DifficultyId.easy],
  [DifficultyId.hard, DifficultyId.easy],
  [DifficultyId.hard, DifficultyId.normal],
];

const played = new Map<string, DuelSweep>();
const key = (a: Tier, b: Tier): string =>
  `${DIFFICULTY_KEYS[a]} v ${DIFFICULTY_KEYS[b]}`;

/** What a sweep came out as, spelled for a failure message. */
function say(a: Tier, b: Tier): string {
  const s = played.get(key(a, b))!;
  const rows = [...s.byStrategy]
    .map(
      ([id, r]) =>
        `${AI_STRATEGY_KEYS[id]} ${r.wins}/${r.decided} ` +
        `(swept ${r.pairs.sweeps}, split ${r.pairs.splits}, lost ${r.pairs.lostBoth})`,
    )
    .join(', ');
  return `${key(a, b)}: ${s.wins}/${s.decided} — ${rows}`;
}

describe('the difficulty tiers, against each other', () => {
  beforeAll(() => {
    // Every pairing once, in a hook rather than at collection time — 48
    // duels is about a minute of work, and a file is collected before it is
    // allowed to take that long. Played once for every assertion below.
    for (const [a, b] of PAIRS) {
      played.set(key(a, b), sweepTiers(a, b, SEEDS, STRATEGIES, 96, MAX_TICKS));
    }
  }, 300_000);

  it('loses no valley to easy on the pinned seeds', () => {
    // The strong claim, and the one that survives the map generator's
    // lopsided starts. Over the full sweeps — 192 seed-and-playbook pairs
    // on two ranges — hard lost exactly one, so this is a pin on seeds
    // known to be clean rather than a claim of never. Per playbook, so a
    // tier that only works for three lords fails here.
    const s = played.get(key(DifficultyId.hard, DifficultyId.easy))!;
    for (const [id, row] of s.byStrategy) {
      expect(
        row.pairs.lostBoth,
        `${AI_STRATEGY_KEYS[id]} — ${say(DifficultyId.hard, DifficultyId.easy)}`,
      ).toBe(0);
    }
    expect(s.pairs.lostBoth).toBe(0);
  });

  it('leaves easy behind on the raw rate too', () => {
    // Both stronger tiers, comfortably — easy loses 83% of its duels to
    // normal and 87% to hard on the sweeps, so a strict majority at this
    // sample size is not a coin toss.
    for (const harder of [DifficultyId.normal, DifficultyId.hard]) {
      const s = played.get(key(harder, DifficultyId.easy))!;
      expect(s.wins * 2, say(harder, DifficultyId.easy)).toBeGreaterThan(
        s.decided,
      );
    }
  });

  it('keeps hard ahead of normal', () => {
    // Non-inferiority, and deliberately no more. Hard is around 60% against
    // normal on the full sweeps — a real edge, but one that 16 duels cannot
    // resolve, and the ceiling test in defs/difficulty.ts is why it is not
    // higher: the knobs stop paying long before 75%. An inversion is what
    // this catches.
    const s = played.get(key(DifficultyId.hard, DifficultyId.normal))!;
    expect(
      s.wins * 2,
      say(DifficultyId.hard, DifficultyId.normal),
    ).toBeGreaterThanOrEqual(s.decided);
  });

  it('scores a mirrored sweep against a 50% null', () => {
    // The arithmetic the sweeps' verdicts rest on, checked without playing
    // anything: an interval clear of 50 is a result, one straddling it is
    // not, and no duels at all is no information.
    expect(wilson(0, 0)).toEqual([0, 100]);
    const [lo, hi] = wilson(317, 381); // the pooled normal-v-easy sweep
    expect(lo).toBeGreaterThan(50);
    expect(hi).toBeLessThan(100);
    const [near] = wilson(53, 95); // ...and one that straddled it
    expect(near).toBeLessThan(50);
  });
});
