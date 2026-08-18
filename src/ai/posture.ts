import type { StrategyAdvice } from './advice.ts';
import type { AiWorldSummary } from './summary.ts';

/**
 * Postures: the strategist's vocabulary, five named stances instead of
 * eleven loose dials.
 *
 * The bake-off is why this exists. Asking a small model to *author* knob
 * values put qwen2.5-0.5b below the random noise floor (33.8% advised win
 * rate against a 46.7% floor) and reduced lfm2.5-350m to echoing the
 * prompt back — across 862 consultations it emitted two distinct replies,
 * one of which was the playbook's own `trainPreference` restated, so not
 * one of its eighty matches diverged from its control by a single tick.
 * Authoring eleven independent numbers is a generation task, and a
 * few-hundred-million-parameter model is not a generator. Choosing among
 * five labelled stances is a classification task, which it is.
 *
 * So the model no longer says how far to turn anything. It names a stance;
 * the numbers under that stance are authored here, once, by someone who
 * can read the sim. That trade — the model picks, the table decides — is
 * the whole idea, and it is also what makes a seat play less like a
 * playbook: what reads as adaptive is a lord who *switches stance* when
 * the valley turns, not one whose serfTarget drifts by two.
 *
 * Every posture sets the same key set on purpose. Advice merges over the
 * standing pile in LlmStrategist, so a posture that left a knob unset
 * would leave the *previous* posture's value in place and the seat would
 * play a blend of two stances that nobody authored. Identical keys mean
 * switching posture actually switches.
 *
 * Not in the table: trainPreference and weaponMix. The brain already
 * counter-forges against sighted army compositions on its own, and it
 * reads fresher intel than a 90-second consultation cadence can. Posture
 * steers how big the army is and when it marches; the captain keeps the
 * choice of what to arm it with.
 */

export type PostureId = 'expand' | 'fortify' | 'raid' | 'muster' | 'siege';

/** Menu order — also the order quoted to the model, economy first. */
export const POSTURE_ORDER: readonly PostureId[] = [
  'expand',
  'fortify',
  'raid',
  'muster',
  'siege',
];

export interface Posture {
  id: PostureId;
  /** One line, quoted verbatim into the prompt's menu. Written as the
   * condition to pick it under, not as a description of the knobs — the
   * model is matching a situation, not reading a spec. */
  when: string;
  /** The stance, as knobs. Same keys in every posture (see the header) —
   * `Required` is what enforces that, so adding a stance that forgets one
   * is a type error rather than a seat playing a blend of two. */
  knobs: Readonly<
    Required<Omit<StrategyAdvice, 'trainPreference' | 'weaponMix' | 'reason' | 'posture'>>
  >;
}

/**
 * The five stances. Values are relative to `steward`'s printed line
 * (serfTarget 10, armyAttackSize 7, attackCooldown 900, homeGuard 0,
 * prefersRivals false, houseLimit 4, housingHeadroom 3, researchReserve
 * 10, barracksQueueDepth 2) — each posture pushes that baseline somewhere
 * deliberate rather than everywhere at once.
 */
export const POSTURES: Record<PostureId, Posture> = {
  expand: {
    id: 'expand',
    when: 'the valley is quiet and you are still small — grow the village before it fights',
    knobs: {
      serfTarget: 16,
      armyAttackSize: 10,
      attackCooldown: 1200,
      homeGuard: 0,
      prefersRivals: false,
      barracksQueueDepth: 1,
      houseLimit: 7,
      housingHeadroom: 5,
      researchReserve: 16,
    },
  },
  fortify: {
    id: 'fortify',
    when: 'enemies are at your gates, or a rival fields more soldiers than you do',
    knobs: {
      serfTarget: 10,
      armyAttackSize: 6,
      attackCooldown: 1600,
      homeGuard: 14,
      prefersRivals: false,
      barracksQueueDepth: 4,
      houseLimit: 4,
      housingHeadroom: 3,
      researchReserve: 6,
    },
  },
  raid: {
    id: 'raid',
    when: 'bandit camps are near and no rival castle is found yet — keep the army working',
    knobs: {
      serfTarget: 11,
      armyAttackSize: 5,
      attackCooldown: 400,
      homeGuard: 0,
      prefersRivals: false,
      barracksQueueDepth: 3,
      houseLimit: 4,
      housingHeadroom: 3,
      researchReserve: 8,
    },
  },
  muster: {
    id: 'muster',
    when: 'a rival is found but your army is too thin to take a castle — build it up first',
    knobs: {
      serfTarget: 13,
      armyAttackSize: 14,
      attackCooldown: 900,
      homeGuard: 6,
      prefersRivals: false,
      barracksQueueDepth: 4,
      houseLimit: 5,
      housingHeadroom: 4,
      researchReserve: 10,
    },
  },
  siege: {
    id: 'siege',
    when: 'you have the soldiers and a rival castle is found — go and raze it',
    knobs: {
      serfTarget: 11,
      armyAttackSize: 12,
      attackCooldown: 500,
      homeGuard: 0,
      prefersRivals: true,
      barracksQueueDepth: 4,
      houseLimit: 4,
      housingHeadroom: 3,
      researchReserve: 4,
    },
  },
};

/**
 * What the strategist asks a real engine to constrain generation to. One
 * enum and one string: a grammar this narrow cannot emit an out-of-range
 * knob, so the clamping in parseAdvice becomes a second line of defence
 * rather than the only one.
 */
export const POSTURE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    posture: { type: 'string', enum: [...POSTURE_ORDER] },
    reason: { type: 'string' },
  },
  required: ['posture'],
  additionalProperties: false,
} as const;

export function isPostureId(raw: unknown): raw is PostureId {
  return typeof raw === 'string' && Object.hasOwn(POSTURES, raw);
}

/** A posture's knobs as advice. Copied, because the caller merges into it
 * and the table is shared across every seat in the process. */
export function postureAdvice(id: PostureId): StrategyAdvice {
  return { ...POSTURES[id].knobs };
}

/**
 * The rule-based selector: the same five stances, chosen from the summary
 * without a model in the loop.
 *
 * This is the honest opponent to beat. `random` proves advice-shaped noise
 * moves win rates; this proves how much of the win is in the *vocabulary*
 * versus in the judgement picking from it. A model that cannot beat a
 * dozen lines of if/else is not reading the valley, and shipping it would
 * be paying 400 MB and a CPU core for something a switch statement does.
 *
 * Ordered as a priority cascade — survival, then tempo, then aggression —
 * because the situations overlap and the first true one should win.
 */
export function choosePosture(summary: AiWorldSummary): PostureId {
  const mine = armyOf(summary);
  const livingRivals = summary.rivals.filter((r) => r.alive);
  const found = livingRivals.filter((r) => r.found);

  // Someone is in the yard: nothing else matters this consultation.
  if (summary.me.underAttack) return 'fortify';

  // Outgunned by a rival we have actually seen. Stale intel still counts —
  // an army sighted two minutes ago has not shrunk.
  const strongestSighting = Math.max(0, ...found.map((r) => r.intel?.total ?? 0));
  if (strongestSighting > mine + 2) return 'fortify';

  // The village cannot field an army it has no hands to feed. Early, or
  // simply small, means grow — this is the branch that fires most often
  // in the opening minutes and it is the one that compounds.
  if (summary.me.serfs < 9 || summary.me.pop < 12) return 'expand';

  // Nobody located yet. Bandit camps are the only thing to hit, and
  // hitting them is also how the map gets explored.
  if (found.length === 0) {
    return summary.bandits.camps > 0 ? 'raid' : 'expand';
  }

  // A castle is on the map. Take it if the army can, build the army if not.
  return mine >= POSTURES.siege.knobs.armyAttackSize ? 'siege' : 'muster';
}

function armyOf(summary: AiWorldSummary): number {
  const { knight, spearman, archer } = summary.me.army;
  return knight + spearman + archer;
}
