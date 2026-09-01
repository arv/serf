import {AiSeats} from '../../src/sim/aiSeats.ts';
/**
 * The tier duel: one difficulty against another, same playbook on both
 * seats, mirrored seatings.
 *
 *   node --experimental-strip-types tools/aiLab/tiers.ts [seeds] [offset]
 *
 * The instrument the balance sweep cannot be. That sweep asks how often a
 * seat takes a map from the bandits, which answers "is this seat effective"
 * and NOT "is this seat harder to beat" — and the two come apart exactly
 * where a difficulty setting lives. A hard seat marches sooner with fewer
 * men: against a bandit camp that is a gamble it sometimes loses, and the
 * sweep scores it down for the same aggression that makes it hard to sit
 * across from. What settles the question is putting the tiers against each
 * other.
 *
 * Both seats run the SAME playbook, so the tier is the only asymmetry, and
 * every seed is played in both seatings — tier A on seat 0 and again on
 * seat 1. That mirror is what makes the null hypothesis exactly 50%
 * whatever head start the valley hands a seat, the same cancellation
 * bakeoff.ts uses for advice. A Wilson 95% interval that straddles 50% is
 * not a result.
 */
import {
  AI_STRATEGY_KEYS,
  AI_STRATEGY_ORDER,
  type AiStrategyId,
} from '../../src/sim/defs/aiStrategies.ts';
import {
  DIFFICULTY_KEYS,
  type DifficultyId,
} from '../../src/sim/defs/difficulty.ts';
import * as DifficultyIdNs from '../../src/sim/defs/difficultyEnum.ts';
import * as MatchState from '../../src/sim/matchStateEnum.ts';
import * as PlayerKind from '../../src/sim/playerKindEnum.ts';
import {tickWorld} from '../../src/sim/tick.ts';
import {createWorld} from '../../src/sim/world.ts';
import {intArgOrExit} from './args.ts';

/** Long enough for a decided duel; a pair still standing is a draw, and a
 * draw counts for neither side. */
const MAX_TICKS = 60_000;

export interface Duel {
  /** 0 = the first tier's seat won, 1 = the second's, null = undecided. */
  winner: 0 | 1 | null;
  tick: number;
}

/**
 * One duel. `tiers[i]` is the difficulty of seat i; the caller does the
 * mirroring by swapping them.
 */
export function playDuel(
  strategy: AiStrategyId,
  tiers: readonly [DifficultyId, DifficultyId],
  seed: number,
  mapSize = 96,
  maxTicks = MAX_TICKS,
): Duel {
  const world = createWorld({
    seed,
    mapSize,
    // No bandits: a neutral third party that kills one seat turns a duel
    // into a coin toss about who met the camp, which is noise the mirror
    // cannot cancel (the two seats do not meet the same camp).
    //
    // The cost, and it is a real one: `prefersRivals` — whether a lord
    // comes for you or for the nearer bandit camp, and one of the knobs
    // `easy` softens — cannot show up in a valley with no camp in it. This
    // instrument measures the tiers with that lever silent, so the gap it
    // reports for easy is if anything an understatement of the gap in a
    // game that has bandits on. The balance sweep is where that knob shows.
    banditsEnabled: false,
    players: [
      {kind: PlayerKind.ai, strategy, difficulty: tiers[0]},
      {kind: PlayerKind.ai, strategy, difficulty: tiers[1]},
    ],
  });
  const seats = new AiSeats(world);
  for (
    let t = 0;
    t < maxTicks && world.outcome.state === MatchState.playing;
    t++
  ) {
    tickWorld(world, seats.decide(world));
  }
  const winner = (world.outcome as {winner?: number}).winner;
  return {
    winner: winner === 0 ? 0 : winner === 1 ? 1 : null,
    tick: world.tick,
  };
}

/** Wilson 95% interval for k of n, as percentages. */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 100];
  const z = 1.959_963_985;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(100 * (centre - half)) / d, (100 * (centre + half)) / d];
}

/**
 * How a seed's two seatings came out — the measurement that says whether a
 * tier or the VALLEY decided the match, and the one to read first.
 *
 * A mirrored win rate cannot tell those apart, and on this map generator
 * the difference is most of the story. Some seeds deal two starts so
 * unequal that whoever holds the better one wins both seatings whatever
 * tier is sitting there; such a seed contributes exactly one win and one
 * loss to the rate, so it drags every result toward 50% and caps what any
 * tier can ever score. Pairing the seatings separates them:
 *
 * - **sweep** — the tier won both seatings. It beat the valley.
 * - **split** — the same SEAT won both. The valley decided; the tier was
 *   not the variable.
 * - **lostBoth** — the weaker tier won both seatings. A genuine loss, and
 *   the only kind worth tuning against.
 *
 * `lostBoth === 0` is therefore the honest reading of "it always wins":
 * on every valley that did not decide itself, it did.
 */
export interface PairTally {
  sweeps: number;
  splits: number;
  lostBoth: number;
}

export interface DuelSweep {
  /** Duels the first tier won, and duels that reached a winner at all. */
  wins: number;
  decided: number;
  undecided: number;
  /** Seed-pairs by who decided them; see PairTally. */
  pairs: PairTally;
  /** The same, per playbook — so a tier that only works for one lord is
   * visible rather than averaged away. Collected in the one pass: a duel
   * costs about two seconds, and re-playing the sweep per playbook to
   * print a breakdown would double the bill for numbers already in hand. */
  byStrategy: Map<
    AiStrategyId,
    {wins: number; decided: number; pairs: PairTally}
  >;
}

/** Every playbook, every seed, both seatings: tier A against tier B. */
export function sweepTiers(
  a: DifficultyId,
  b: DifficultyId,
  seeds: readonly number[],
  strategies: readonly AiStrategyId[] = AI_STRATEGY_ORDER,
  mapSize = 96,
  maxTicks = MAX_TICKS,
): DuelSweep {
  let wins = 0;
  let decided = 0;
  let undecided = 0;
  const pairs: PairTally = {sweeps: 0, splits: 0, lostBoth: 0};
  const byStrategy: DuelSweep['byStrategy'] = new Map();
  for (const strategy of strategies) {
    const row = {
      wins: 0,
      decided: 0,
      pairs: {sweeps: 0, splits: 0, lostBoth: 0},
    };
    byStrategy.set(strategy, row);
    for (const seed of seeds) {
      // Both seatings of this seed together, so the pair can be classified
      // (see PairTally) rather than only counted.
      const took: boolean[] = [];
      for (const layout of [0, 1] as const) {
        const tiers: [DifficultyId, DifficultyId] =
          layout === 0 ? [a, b] : [b, a];
        const {winner} = playDuel(strategy, tiers, seed, mapSize, maxTicks);
        if (winner === null) {
          undecided++;
          continue;
        }
        decided++;
        row.decided++;
        // Seat `layout` is the one wearing tier A in this seating.
        const tookIt = winner === layout;
        took.push(tookIt);
        if (tookIt) {
          wins++;
          row.wins++;
        }
      }
      // An undecided seating leaves the pair unclassifiable — it says
      // nothing about who the valley favoured — so only complete pairs are
      // tallied.
      if (took.length !== 2) continue;
      const key =
        took[0] && took[1]
          ? 'sweeps'
          : !took[0] && !took[1]
            ? 'lostBoth'
            : 'splits';
      pairs[key]++;
      row.pairs[key]++;
    }
  }
  return {wins, decided, undecided, pairs, byStrategy};
}

if (process.argv[1]?.endsWith('tiers.ts')) {
  // Validated, not coerced: a NaN count runs zero duels and still prints
  // the table, every rate 0.0% and every verdict "no result" — a typo that
  // looks exactly like a finding. See args.ts.
  const usage = 'tiers.ts [seeds] [offset]';
  const count = intArgOrExit(process.argv[2], 12, 'seeds', 1, usage);
  const offset = intArgOrExit(process.argv[3], 101, 'offset', 0, usage);
  const seeds = Array.from({length: count}, (_, i) => offset + i * 7);
  const pairs: [DifficultyId, DifficultyId][] = [
    [DifficultyIdNs.normal, DifficultyIdNs.easy],
    [DifficultyIdNs.hard, DifficultyIdNs.normal],
    [DifficultyIdNs.hard, DifficultyIdNs.easy],
  ];
  console.log(
    `${count} seeds from ${offset}, ${AI_STRATEGY_ORDER.length} playbooks, ` +
      `both seatings — ${count * AI_STRATEGY_ORDER.length * 2} duels a pair\n`,
  );
  const sweeps = pairs.map(([a, b]) => {
    const t0 = Date.now();
    const sweep = sweepTiers(a, b, seeds);
    const [lo, hi] = wilson(sweep.wins, sweep.decided);
    const rate = sweep.decided ? (100 * sweep.wins) / sweep.decided : 0;
    const verdict = lo > 50 ? 'WINS' : hi < 50 ? 'LOSES' : 'no result';
    const p = sweep.pairs;
    console.log(
      `${DIFFICULTY_KEYS[a].padEnd(6)} v ${DIFFICULTY_KEYS[b].padEnd(6)} ` +
        `${String(sweep.wins).padStart(3)}/${String(sweep.decided).padEnd(3)} ` +
        `${rate.toFixed(1).padStart(5)}%  [${lo.toFixed(1)}, ${hi.toFixed(1)}]  ` +
        `${verdict}   valleys: ${p.sweeps} swept, ${p.splits} decided ` +
        `themselves, ${p.lostBoth} lost  (undecided ${sweep.undecided}, ` +
        `${((Date.now() - t0) / 1000).toFixed(0)}s)`,
    );
    return sweep;
  });
  console.log('');
  for (const strategy of AI_STRATEGY_ORDER) {
    const row = sweeps.map((sweep, i) => {
      const cell = sweep.byStrategy.get(strategy)!;
      const [a, b] = pairs[i]!;
      return (
        `${DIFFICULTY_KEYS[a][0]}v${DIFFICULTY_KEYS[b][0]} ` +
        `${cell.wins}/${cell.decided} (lost ${cell.pairs.lostBoth})`
      );
    });
    console.log(`${AI_STRATEGY_KEYS[strategy].padEnd(9)} ${row.join('   ')}`);
  }
}
