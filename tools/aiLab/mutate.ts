import {
  ADVICE_RANGES,
  ADVISABLE_UNITS,
  MARCH_CONFIDENCE_RANGE,
  type StrategyAdvice,
} from '../../src/ai/advice.ts';
import type { AiStrategy } from '../../src/sim/defs/aiStrategies.ts';
import type { Rng } from '../../src/shared/rng.ts';
import type { UnitTypeId } from '../../src/sim/defs/units.ts';

/**
 * The mutation space over a playbook: one small, bounded, reversible step
 * away from a strategy that already works.
 *
 * This is the primitive a search loop drives, and nothing more — no
 * population, no selection, no generation counter. Those belong to whoever
 * writes the loop; what has to be settled first is *what a neighbour is*,
 * because that choice decides what the search can ever find and what it can
 * break on the way.
 *
 * ## What may move, and why exactly that
 *
 * The mutable set is **exactly the advice whitelist** (`src/ai/advice.ts`),
 * bounded by exactly its ranges. Three things fall out of that choice, and
 * all three are the reason for it:
 *
 * - **Every mutant is expressible as advice.** `adviceOf` on a mutant
 *   round-trips through the shipped `parseAdvice` unchanged, which the
 *   tests assert. A mutant is therefore deliverable through the seam that
 *   already exists — `AiSeats.applyAdvice` at tick zero — so a search loop
 *   needs no new sim plumbing and no new `AiStrategyId`, and a discovered
 *   winner can ship as a posture without translation.
 * - **Whatever the search finds, a model could have said.** The knobs the
 *   search explores are the knobs the strategist is allowed to turn, so a
 *   result transfers directly into `ai/posture.ts` rather than into a
 *   parallel vocabulary nobody prompts with.
 * - **The opening is out of reach.** `build` and `researchOrder` are passed
 *   through by reference, untouched. They encode hard-won knowledge — the
 *   gates in `defs/aiStrategies.ts`'s comments were each paid for by a
 *   campaign that stopped being winnable — and reordering them is a much
 *   riskier second step that deserves its own experiment. `survivalFloor`
 *   and `growthAfter` sit out for the same reason: neither is range-bounded
 *   anywhere, so there is nothing to mutate them *within*.
 *
 * ## Neighbours, not lottery tickets
 *
 * A mutation is a step, not a redraw. Numeric knobs move by a fraction of
 * their own range (never less than 1, so a narrow knob still moves) and
 * clamp at the edges; list knobs swap, drop or insert one entry. That keeps
 * a mutant close enough to its parent that a win is attributable to the
 * change, which is the only reason to hill-climb rather than sample.
 *
 * The lab's `random` engine samples the same ranges from scratch every
 * consultation and scores 47% over eighty seeds — the noise floor. That is
 * this file's control: a mutation operator that cannot beat redrawing the
 * knobs at random is not a search, it is the same dice with extra steps.
 */

/** A knob a mutation may turn, and how far it may turn it. */
type NumericKnob = keyof typeof ADVICE_RANGES | 'marchConfidence';

/**
 * The numeric half of the space. `ADVICE_RANGES` is READ here and never
 * added to: the `random` engine walks that table's keys and draws
 * `rng.int(numeric.length + 3)` per knob, so a new key would lengthen its
 * stream and stop the recorded 46.6% / 47.0% noise floor reproducing.
 * `marchConfidence` is kept outside the table for that exact reason and is
 * spliced back in here, which is the same trick `parseAdvice` plays.
 */
export const MUTABLE_RANGES: Readonly<Record<NumericKnob, readonly [number, number]>> = {
  ...ADVICE_RANGES,
  marchConfidence: MARCH_CONFIDENCE_RANGE,
};

/** Recipe indices a forge understands: 0 spear, 1 sword, 2 bow. */
const WEAPON_RECIPES = [0, 1, 2] as const;
const WEAPON_MIX_MAX_LEN = 3;

/** Every knob a mutation may touch, in a fixed order — the order is the
 * RNG's, so it has to be stable for a run to replay. */
export const MUTABLE_KNOBS = [
  ...(Object.keys(MUTABLE_RANGES) as NumericKnob[]),
  'prefersRivals',
  'trainPreference',
  'weaponMix',
] as const;

export type MutableKnob = (typeof MUTABLE_KNOBS)[number];

export interface MutateOptions {
  /** How many knobs one mutation turns (default 1). A single knob keeps a
   * win attributable; more explores faster and explains less. */
  knobs?: number;
  /**
   * Numeric step as a share of the knob's own range (default 0.2). Always
   * at least 1 after rounding, or `barracksQueueDepth` (range 1-4) would
   * never move at all.
   */
  step?: number;
  /** Knobs to leave alone — for ablations, and for a search that has
   * already decided one axis. */
  frozen?: readonly MutableKnob[];
}

/** What one mutation changed, for the run log. A search that cannot say
 * which knob moved cannot tell a discovery from a coincidence. */
export interface Mutation {
  knob: MutableKnob;
  from: unknown;
  to: unknown;
}

export interface Mutant {
  strategy: AiStrategy;
  changes: Mutation[];
}

/** The knob values of a playbook, as the advice shape. Exactly the fields
 * `parseAdvice` can produce, so a mutant can be handed to `applyAdvice`. */
export function adviceOf(s: AiStrategy): StrategyAdvice {
  return {
    serfTarget: s.serfTarget,
    armyAttackSize: s.armyAttackSize,
    attackCooldown: s.attackCooldown,
    homeGuard: s.homeGuard,
    barracksQueueDepth: s.barracksQueueDepth,
    houseLimit: s.houseLimit,
    housingHeadroom: s.housingHeadroom,
    researchReserve: s.researchReserve,
    marchConfidence: s.marchConfidence,
    prefersRivals: s.prefersRivals,
    trainPreference: [...s.trainPreference],
    weaponMix: [...s.weaponMix],
  };
}

const clamp = (v: number, [lo, hi]: readonly [number, number]): number =>
  Math.min(hi, Math.max(lo, Math.round(v)));

/**
 * One numeric knob, one step up or down. Returns the old value when the
 * knob is already pinned at the edge it was pushed towards — the caller
 * treats that as "this mutation did nothing" and tries another knob, which
 * is what keeps a mutant from silently being its own parent.
 */
function stepNumber(value: number, knob: NumericKnob, rng: Rng, stepShare: number): number {
  const range = MUTABLE_RANGES[knob];
  const span = range[1] - range[0];
  const size = Math.max(1, Math.round(span * stepShare));
  const up = rng.int(2) === 0;
  const moved = clamp(value + (up ? size : -size), range);
  // Pinned against the edge it was pushed towards: try the other way rather
  // than burning the mutation. A knob at a boundary is common — every
  // printed playbook holds marchConfidence at 0.
  if (moved === value) return clamp(value + (up ? -size : size), range);
  return moved;
}

/** A preference list one step from this one: swap two, drop one, or add a
 * missing unit. Never empties — an empty preference leaves the barracks
 * training nothing, which is why `parseAdvice` drops one too. */
function stepPreference(list: readonly UnitTypeId[], rng: Rng): UnitTypeId[] {
  const next: UnitTypeId[] = [...list];
  const missing = ADVISABLE_UNITS.filter((u) => !next.includes(u));
  const canSwap = next.length >= 2;
  const canDrop = next.length >= 2;
  const moves: ('swap' | 'drop' | 'add')[] = [
    ...(canSwap ? (['swap'] as const) : []),
    ...(canDrop ? (['drop'] as const) : []),
    ...(missing.length > 0 ? (['add'] as const) : []),
  ];
  const move = rng.pick(moves);
  if (move === 'swap') {
    const i = rng.int(next.length);
    let j = rng.int(next.length - 1);
    if (j >= i) j++;
    const swap = next[i]!;
    next[i] = next[j]!;
    next[j] = swap;
  } else if (move === 'drop') {
    next.splice(rng.int(next.length), 1);
  } else {
    // Inserted anywhere, not appended: where a unit sits in the list is the
    // whole meaning of the list.
    next.splice(rng.int(next.length + 1), 0, rng.pick(missing));
  }
  return next;
}

/** A forge assignment one step from this one: retask a smith, hire another,
 * or hand the last one's bench to the smith before it. */
function stepWeaponMix(mix: readonly number[], rng: Rng): number[] {
  const next = [...mix];
  const moves: ('retask' | 'grow' | 'shrink')[] = [
    'retask',
    ...(next.length < WEAPON_MIX_MAX_LEN ? (['grow'] as const) : []),
    ...(next.length > 1 ? (['shrink'] as const) : []),
  ];
  const move = rng.pick(moves);
  if (move === 'grow') {
    next.push(rng.pick(WEAPON_RECIPES));
    return next;
  }
  if (move === 'shrink') {
    next.pop();
    return next;
  }
  const i = rng.int(next.length);
  const others = WEAPON_RECIPES.filter((r) => r !== next[i]);
  next[i] = rng.pick(others);
  return next;
}

/** Did this knob actually move? Lists compare by content. */
function changed(before: unknown, after: unknown): boolean {
  if (Array.isArray(before) && Array.isArray(after)) {
    return before.length !== after.length || before.some((v, i) => v !== after[i]);
  }
  return before !== after;
}

/**
 * One playbook, one step away.
 *
 * Deterministic in `rng` and nothing else — same seed, same mutant, which
 * is what lets a generation be replayed after the fact and what the sim's
 * own determinism rules would demand if this ever moved under `src/`.
 * (It has not, and should not: `Math.round` and friends are banned there.)
 *
 * `build` and `researchOrder` come through by reference. That is deliberate
 * and asserted: the opening is out of the mutation space, so a mutant
 * sharing its parent's array is the honest representation.
 *
 * `id`, `name` and `blurb` come through untouched too. A mutant is NOT a
 * registered playbook — nothing adds it to `AI_STRATEGIES` and nothing
 * should, since a save that named an id the table has lost would break.
 * It keeps its lineage's id because that is what it is a step away from,
 * and it reaches a seat as an override, not as a name.
 */
export function mutate(base: AiStrategy, rng: Rng, opts: MutateOptions = {}): Mutant {
  const wanted = Math.max(1, opts.knobs ?? 1);
  const stepShare = opts.step ?? 0.2;
  const frozen = new Set<MutableKnob>(opts.frozen ?? []);
  const pool = MUTABLE_KNOBS.filter((k) => !frozen.has(k));

  const next: AiStrategy = { ...base };
  const changes: Mutation[] = [];
  const tried = new Set<MutableKnob>();

  // Every knob at most once per mutation, and a knob that could not move
  // (pinned at both edges of a one-value range) costs an attempt rather
  // than looping forever.
  while (changes.length < wanted && tried.size < pool.length) {
    const candidates = pool.filter((k) => !tried.has(k));
    if (candidates.length === 0) break;
    const knob = rng.pick(candidates);
    tried.add(knob);
    const before = next[knob];
    let after: unknown;
    if (knob === 'prefersRivals') after = !next.prefersRivals;
    else if (knob === 'trainPreference') after = stepPreference(next.trainPreference, rng);
    else if (knob === 'weaponMix') after = stepWeaponMix(next.weaponMix, rng);
    else after = stepNumber(next[knob], knob, rng, stepShare);
    if (!changed(before, after)) continue;
    // Assign through a computed key: the union of knob types is wider than
    // any one field, and the branches above are what keeps it sound.
    Object.assign(next, { [knob]: after });
    changes.push({ knob, from: before, to: after });
  }

  return { strategy: next, changes };
}

/** One line per knob that moved — what a run log wants beside the win rate,
 * because "generation 4 candidate 11" is not a finding. */
export function describeMutation(m: Mutant): string {
  if (m.changes.length === 0) return `${m.strategy.id} (unchanged)`;
  const show = (v: unknown): string => (Array.isArray(v) ? `[${v.join(',')}]` : String(v));
  return m.changes.map((c) => `${c.knob} ${show(c.from)}→${show(c.to)}`).join(', ');
}
