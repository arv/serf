import { readOpponent, Archetype } from './archetype.ts';
import type { StrategyAdvice } from './advice.ts';
import type { AiWorldSummary } from './summary.ts';
import type { Enum } from '../shared/enum.ts';
import * as PostureIdNs from './postureIdEnum.ts';
export * as PostureId from './postureIdEnum.ts';
export type PostureId = Enum<typeof PostureIdNs>;

/**
 * Postures: the strategist's vocabulary, a handful of named stances instead
 * of eleven loose dials.
 *
 * The bake-off is why this exists. Asking a small model to *author* knob
 * values put qwen2.5-0.5b below the random noise floor (33.8% advised win
 * rate against a 46.7% floor) and reduced lfm2.5-350m to echoing the
 * prompt back — across 862 consultations it emitted two distinct replies,
 * one of which was the playbook's own `trainPreference` restated, so not
 * one of its eighty matches diverged from its control by a single tick.
 * Authoring eleven independent numbers is a generation task, and a
 * few-hundred-million-parameter model is not a generator. Choosing among a
 * half-dozen labelled stances is a classification task, which it is.
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
 * Not in the table: marchConfidence, which is the brain's own march gate and is
 * measured on its own rather than folded into a stance — the recorded posture
 * numbers all assume it off. Nor trainPreference and weaponMix. The brain already
 * counter-forges against sighted army compositions on its own, and it
 * reads fresher intel than a 90-second consultation cadence can. Posture
 * steers how big the army is and when it marches; the captain keeps the
 * choice of what to arm it with.
 */

/** Menu order — also the order quoted to the model, economy first. */
export const POSTURE_ORDER: readonly PostureId[] = [
  PostureIdNs.expand,
  PostureIdNs.fortify,
  PostureIdNs.raid,
  PostureIdNs.muster,
  PostureIdNs.siege,
  PostureIdNs.pounce,
];

/**
 * The spelling of each stance. Load-bearing at both ends of the model's
 * turn: the menu is quoted into the prompt in words, and the reply comes
 * back as a word. Inside the seat a posture is a number like the rest.
 */
export const POSTURE_KEYS: Readonly<Record<PostureId, string>> = {
  [PostureIdNs.expand]: 'expand',
  [PostureIdNs.fortify]: 'fortify',
  [PostureIdNs.raid]: 'raid',
  [PostureIdNs.muster]: 'muster',
  [PostureIdNs.siege]: 'siege',
  [PostureIdNs.pounce]: 'pounce',
};

const POSTURE_BY_KEY = new Map<string, PostureId>(
  POSTURE_ORDER.map((id) => [POSTURE_KEYS[id], id]),
);

/** The stance a word names, or undefined — the read side of POSTURE_KEYS. */
export function postureFromKey(key: unknown): PostureId | undefined {
  return typeof key === 'string' ? POSTURE_BY_KEY.get(key) : undefined;
}

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
    Required<
      Omit<
        StrategyAdvice,
        'trainPreference' | 'weaponMix' | 'reason' | 'posture' | 'marchConfidence'
      >
    >
  >;
}

/**
 * The stances. Values are relative to `steward`'s printed line
 * (serfTarget 10, armyAttackSize 7, attackCooldown 900, homeGuard 0,
 * prefersRivals false, houseLimit 4, housingHeadroom 3, researchReserve
 * 10, barracksQueueDepth 2) — each posture pushes that baseline somewhere
 * deliberate rather than everywhere at once.
 */
export const POSTURES: Record<PostureId, Posture> = {
  [PostureIdNs.expand]: {
    id: PostureIdNs.expand,
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
  [PostureIdNs.fortify]: {
    id: PostureIdNs.fortify,
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
  [PostureIdNs.raid]: {
    id: PostureIdNs.raid,
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
  [PostureIdNs.muster]: {
    id: PostureIdNs.muster,
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
  [PostureIdNs.siege]: {
    id: PostureIdNs.siege,
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
  /**
   * `siege` with the muster bar dropped to five: march on their castle with
   * whatever is standing.
   *
   * This exists for exactly one situation and must not be read as a general
   * appetite. A muster bar of four, taken blind, scores 43.4% at eighty
   * seeds — well under the noise floor — and that replicates (tools/aiLab/
   * README.md). The finding attached to it is the reason this stance is in
   * the table at all: "marching sooner is worth something only if something
   * knows when". `readOpponent` is the something; a rival that has been
   * found, has been watched, and has shown nothing that could hold a wall is
   * the when.
   *
   * Held constant for whole matches it scores 56.6% (86/152) at eighty
   * seeds, which is the best arm measured on this build — and it beats
   * neither rule when paired (p = 0.324 against `posture`), so that is
   * a hint and not a finding. What is *not* ambiguous is the horizon: a seat
   * that marches at five leaves 8 of 240 matches undecided against the
   * rule's 19. Aggression ends games, which is phase 1's problem answered
   * from an unexpected direction.
   */
  [PostureIdNs.pounce]: {
    id: PostureIdNs.pounce,
    when: 'a rival castle is found and they have no army worth the name — go now, before they do',
    knobs: {
      serfTarget: 11,
      armyAttackSize: 5,
      attackCooldown: 400,
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
    posture: { type: 'string', enum: POSTURE_ORDER.map((id) => POSTURE_KEYS[id]) },
    reason: { type: 'string' },
  },
  required: ['posture'],
  additionalProperties: false,
} as const;

export function isPostureId(raw: unknown): raw is PostureId {
  return typeof raw === 'number' && Object.hasOwn(POSTURES, raw);
}

/** A posture's knobs as advice. Copied, because the caller merges into it
 * and the table is shared across every seat in the process. */
export function postureAdvice(id: PostureId): StrategyAdvice {
  return { ...POSTURES[id].knobs };
}

/**
 * The rule-based selector, and the reference the harness means by
 * `--engine posture`: stances chosen from the summary, without a model and
 * without reading the opponent.
 *
 * It is the reference on the evidence. `choosePostureReadingOpponent` below
 * conditions the same cascade on an archetype and does not beat it — 0 won,
 * 2 lost, p = 0.50 over eighty seeds — so the simpler rule holds the name
 * that every recorded number was measured under, and the classifier waits
 * behind `--engine posture-reads` until a fair test says otherwise.
 *
 * It is also the honest opponent for a model to beat. `random` proves advice-shaped noise
 * moves win rates; this proves how much of the win is in the *vocabulary*
 * versus in the judgement picking from it. A model that cannot beat a
 * dozen lines of if/else is not reading the valley, and shipping it would
 * be paying 400 MB and a CPU core for something a switch statement does.
 *
 * The shape of this cascade is measured, not reasoned. Its first draft was
 * the intuitive one — grow while small, raid while nothing is found, siege
 * once strong — and holding each stance for a whole match instead
 * (`--engine posture:<id>`, 40 seeds) said the intuition was wrong:
 *
 *     posture:siege    68.4%   (19 flips toward the advised seat, 6 away)
 *     posture:muster   60.8%
 *     posture:expand   50.0%
 *     the draft rule   51.3%
 *     random            46.6%
 *
 * Paired McNemar over the same seeds: siege beat the draft rule (p =
 * 0.012) and beat expand (p = 0.0024); the draft rule did not beat random
 * at all (p = 0.63). A cascade losing to its own best constant means the
 * *picking* was the problem, not the menu — so the picking now defaults to
 * the aggressive end and deviates only where standing pat is untenable.
 *
 * The lesson under the numbers is about this valley: matches resolve in
 * about eleven minutes, so an economy stance spends the decisive window
 * paying for growth that never gets to fight. `expand` and `raid` stay in
 * the table because the *model* may still name them — they are honest
 * options on maps and seat counts the bake-off has not swept, and one map
 * at forty seeds is not enough evidence to delete a stance — but nothing
 * in this function chooses them.
 */
export function choosePosture(summary: AiWorldSummary): PostureId {
  // Someone is in the yard. The only situation worth breaking stance for:
  // an army that marches while its castle burns loses the castle.
  if (summary.me.underAttack) return PostureIdNs.fortify;

  // Nothing located yet. `siege` sets prefersRivals, which parks the army
  // until a castle is found — so until one is, mass instead, which leaves
  // the captain free to clear the camps he can reach.
  const found = summary.rivals.some((r) => r.alive && r.found);
  if (!found) return PostureIdNs.muster;

  // A castle is on the map. Go and take it — including when the army is
  // still thin, which is where the draft rule went wrong: it waited, and
  // waiting is what `expand` and the printed playbook already lose to.
  return PostureIdNs.siege;
}

/**
 * The same cascade with one more input: what kind of lord is on the other
 * side (src/ai/archetype.ts).
 *
 * Two deviations from the blind rule, and only two, so that a measurement
 * has something to attribute:
 *
 *  - **A quiet neighbour is pounced on.** A rival whose castle is found and
 *    whose army has never amounted to anything gets marched on at five
 *    soldiers instead of twelve. This is the one thing the march-gate
 *    negative result asked for by name: blind early aggression loses, so
 *    make it not blind.
 *  - **A lone raider no longer breaks the siege.** `underAttack` is any
 *    hostile in sight of the castle, bandits included, and dropping stance
 *    for one of them is exactly the kind of deviation that left the blind
 *    rule (58.3%) short of the `siege` constant it could have named
 *    (68.4%). Stance now breaks for an opponent who has actually come at us
 *    in force — a rusher — and for an unread board, where fortifying is the
 *    safe read of ignorance.
 *
 * Both were hypotheses, and both were measured against the null that
 * matters — the same cascade with `readOpponent` deleted. Eighty seeds,
 * same build, same valley:
 *
 *     posture       (opponent ignored)   51.8%   (73/141)
 *     posture-reads (opponent read)      50.7%   (73/144)
 *     paired McNemar over the same seeds: 0 trials won, 2 lost, p = 0.50
 *
 * The branch is not inert — it changes the stance on about one consultation
 * in seven, and the two arms end up in a materially different world in 41
 * of 160 paired trials, with a different winner in five. It simply does not
 * win those trials. **Conditioning on the opponent, here, decides nothing.**
 *
 * So this function is kept the way `combatOdds.ts` is kept: as the wiring a
 * better read would plug into, with the measurement that says it is not
 * paying yet written down beside it. If you are about to build on it, the
 * thing to fix first is upstream — three playbooks as different as
 * `warlord` and `abbot` look far more alike from behind the fog than they
 * do in their blurbs, and a classifier cannot separate what scouting never
 * showed it.
 */
export function choosePostureReadingOpponent(summary: AiWorldSummary): PostureId {
  const opponent = readOpponent(summary);

  if (summary.me.underAttack && opponent !== Archetype.booming && opponent !== Archetype.turtling) {
    return PostureIdNs.fortify;
  }

  const found = summary.rivals.some((r) => r.alive && r.found);
  if (!found) return PostureIdNs.muster;

  if (opponent === Archetype.booming) return PostureIdNs.pounce;

  return PostureIdNs.siege;
}
