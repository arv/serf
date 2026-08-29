import type {Enum} from '../../shared/enum.ts';
import * as PostureIdNs from './postureIdEnum.ts';

export type PostureId = Enum<typeof PostureIdNs>;

/**
 * Postures: a handful of named stances instead of eleven loose dials.
 *
 * The bake-off is why this table exists, and why it is authored rather than
 * learned. Asking a small model to *author* knob values put qwen2.5-0.5b
 * below the random noise floor (33.8% advised win rate against a 46.7%
 * floor); asking it to *choose* from this menu worked — and then a dozen
 * lines of if/else choosing from the same menu worked as well as the model
 * did, which is why there is no model any more (tools/aiLab/README.md).
 * The numbers under each stance are authored here, once, by someone who can
 * read the sim; what varies at runtime is only WHICH stance a seat holds.
 *
 * Two consumers, one table:
 *
 * - **The brain's stance engine** (systems/ai.ts). A playbook names the
 *   stances of its personality (`AiStrategy.stances`) and the brain switches
 *   between them as the match turns — the fortify break-in when raiders
 *   reach the yard, the found-stance once a rival castle is on explored
 *   ground. The brain applies only the WAR knobs (`STANCE_KNOB_KEYS`): the
 *   economy keys stay the playbook's own, because a seat's economy is its
 *   identity and a stance is its mood.
 * - **The advice seam** (src/ai/). `{"posture":"siege"}` still parses as
 *   advice and expands into the full knob set, which is how the lab's
 *   posture engines steer whole matches and how a candidate stance rule is
 *   measured before it earns a place in playbook data.
 *
 * In sim/defs because the brain reads it: everything that steers commands
 * has to live inside the replay-version hash surface (src/sim/**), and the
 * sim never imports src/ai.
 *
 * Every posture sets the same key set on purpose. The advice seam merges
 * replies over a standing pile, so a posture that left a knob unset would
 * leave the *previous* posture's value in place and the seat would play a
 * blend of two stances that nobody authored. Identical keys mean switching
 * posture actually switches. (The brain's partial application is different
 * and safe: it recomputes {playbook + stance} from scratch every beat, so
 * nothing lingers.)
 *
 * Not in the table: marchConfidence, which is the brain's own march gate and
 * is measured on its own rather than folded into a stance — the recorded
 * posture numbers all assume it off. Nor trainPreference and weaponMix. The
 * brain already counter-forges against sighted army compositions on its own.
 * Posture steers how big the army is and when it marches; the captain keeps
 * the choice of what to arm it with.
 */

/** Menu order — economy first. Also the order the lab quotes stances in. */
export const POSTURE_ORDER: readonly PostureId[] = [
  PostureIdNs.expand,
  PostureIdNs.fortify,
  PostureIdNs.raid,
  PostureIdNs.muster,
  PostureIdNs.siege,
  PostureIdNs.pounce,
];

/**
 * The spelling of each stance. Load-bearing on the advice wire: a reply
 * names a stance as a word (`{"posture":"siege"}`), and the lab's
 * `--engine posture:<word>` flag speaks the same vocabulary. Inside the
 * seat a posture is a number like the rest.
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
  POSTURE_ORDER.map(id => [POSTURE_KEYS[id], id]),
);

/** The stance a word names, or undefined — the read side of POSTURE_KEYS. */
export function postureFromKey(key: unknown): PostureId | undefined {
  return typeof key === 'string' ? POSTURE_BY_KEY.get(key) : undefined;
}

export function isPostureId(raw: unknown): raw is PostureId {
  return typeof raw === 'number' && Object.hasOwn(POSTURES, raw);
}

/** A stance, as knobs. The nine keys advice may steer, minus the ones the
 * header explains away — mirrors StrategyAdvice (src/ai/advice.ts), which
 * asserts the correspondence from its side so the two cannot drift. */
export interface PostureKnobs {
  serfTarget: number;
  armyAttackSize: number;
  attackCooldown: number;
  homeGuard: number;
  prefersRivals: boolean;
  barracksQueueDepth: number;
  houseLimit: number;
  housingHeadroom: number;
  researchReserve: number;
}

export interface Posture {
  id: PostureId;
  /** The situation to pick it under, in one line — written for a menu, kept
   * for the reader. */
  when: string;
  knobs: Readonly<PostureKnobs>;
}

/**
 * The WAR half of a stance — what the brain's stance engine applies over a
 * playbook. The economy keys (serfTarget, houseLimit, housingHeadroom,
 * researchReserve) deliberately stay the playbook's own: the abbot's wide
 * village and the warlord's lean one are their identities, and a mood that
 * rewrote them would flatten the very differences the personalities exist
 * to show. Advice through the seam still overrides everything, which is how
 * the lab measures full-stance steering.
 */
export const STANCE_KNOB_KEYS = [
  'armyAttackSize',
  'attackCooldown',
  'homeGuard',
  'prefersRivals',
  'barracksQueueDepth',
] as const;

export type StanceKnobs = Pick<PostureKnobs, (typeof STANCE_KNOB_KEYS)[number]>;

/** One stance assignment in a playbook: the posture whose war knobs to
 * wear, with any playbook-specific holds layered over — how the fletcher
 * keeps its own homeGuard through a stance that would drop it. */
export interface StancePick {
  posture: PostureId;
  hold?: Partial<StanceKnobs>;
}

/** A stance pick, resolved to the war knobs the brain lays over the
 * playbook. A fresh object every call — callers merge into it. */
export function stanceWarKnobs(pick: StancePick): StanceKnobs {
  const k = POSTURES[pick.posture].knobs;
  return {
    armyAttackSize: k.armyAttackSize,
    attackCooldown: k.attackCooldown,
    homeGuard: k.homeGuard,
    prefersRivals: k.prefersRivals,
    barracksQueueDepth: k.barracksQueueDepth,
    ...pick.hold,
  };
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
   * knows when". A rival that has been found, has been watched, and has
   * shown nothing that could hold a wall is the when — which is why the
   * warlord's playbook names it as the stance to take a discovered rival
   * under, and why nothing names it blind.
   *
   * Held constant for whole matches it scores 56.6% (86/152) at eighty
   * seeds, the best arm measured on the build that added it — and it beats
   * neither rule when paired (p = 0.324 against `posture`), so that is
   * a hint and not a finding. What is *not* ambiguous is the horizon: a seat
   * that marches at five leaves 8 of 240 matches undecided against the
   * rule's 19. Aggression ends games.
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
