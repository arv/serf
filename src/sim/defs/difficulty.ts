import type {Enum} from '../../shared/enum.ts';
import type {AiStrategy} from './aiStrategies.ts';
import * as DifficultyIdNs from './difficultyEnum.ts';
import {goodEntries, type GoodAmounts} from './goods.ts';

export type DifficultyId = Enum<typeof DifficultyIdNs>;

/**
 * How hard the match is set to — one setting, two entirely separate jobs.
 *
 * **The computer seats play better or worse.** A tier is a transform over
 * the knobs a brain has already composed for this beat, not a fifth
 * playbook and not a resource handout. The seats keep their own build
 * orders, their own research lines and their own moods; what moves is how
 * big the army has to be before it marches, how often it marches, how deep
 * the village grows behind it, and how soon it comes to look at you. An AI
 * seat's opening larder is the same at every tier as the player's — the
 * one thing a difficulty setting here will never do is cheat, because the
 * whole intel model (systems/ai.ts) exists so the seats play the fog
 * honestly, and buying strength with a stock bonus spends that for nothing.
 *
 * **The campaign's scenarios open harder or softer.** A commission is an
 * authored recipe (defs/missions.ts), and the tier scales the human seat's
 * half of it: the larder it opens with, the hands standing in the yard,
 * and how long the peace lasts before the first raid. Nothing about the
 * authored ground, the objectives or the prebuilt village moves — a
 * commission teaches the same lesson at every tier, it just gives you less
 * room to learn it in.
 *
 * ## The rule the table follows
 *
 * **Easy may soften anything; hard may only sharpen what a playbook
 * already does.**
 *
 * Not symmetry for its own sake. Half of what the four playbooks are is
 * what they REFUSE to do — the abbot never harasses, the steward turns a
 * losing march for home, and defs/aiStrategies.ts is explicit that those
 * refusals are meant to read through the fog as clearly as the raids do.
 * A hard tier that granted every seat a sortie and forbade every retreat
 * would hand you four copies of the same lord, which is exactly the
 * complaint the playbook deck was written to answer. So hard turns
 * magnitudes only: an existing sortie gets bigger and comes round sooner,
 * an army musters lower and marches more often, a village grows wider.
 * Easy is under no such duty — a seat that has been talked out of
 * harassing you is not a personality being flattened, it is the same lord
 * playing badly, which is what was asked for.
 *
 * The rule survived a check rather than a vote. Three candidates were
 * tried against hard-versus-normal in the tier duel and none of them beat
 * the table as printed: forcing `retreats: false` (36/63, against 36/63
 * for leaving it alone — identical, to the duel), a distinctly wider
 * village (70/124 against 74/127), and a faster decision clock for hard
 * (33/63). Those are small samples and the honest reading of them is "no
 * effect worth the identity", not "measurably worse" — but the rule asked
 * for evidence to break it and none arrived, so the lords keep their
 * refusals. The tiers' own ordering is measured properly, twenty-four
 * seeds deep on two independent ranges: normal over easy 59.7%, hard over
 * easy 67.9%, hard over normal 60.7%, every interval clear of the 50%
 * null and the two ranges agreeing to within three points. See
 * tools/aiLab/README.md.
 *
 * Pure data and integer arithmetic, like everything else in defs/: the
 * brain runs beside the sim on whichever host owns the world, and two
 * hosts reading this table have to reach the same numbers.
 */
export interface Difficulty {
  id: DifficultyId;
  /** Shown on the difficulty picker. */
  name: string;
  /** One line on what it changes. */
  blurb: string;

  // — The computer seats: war —
  /** Added to the soldiers wanted before the army marches. */
  armyAttackSize: number;
  /** Percent of the composed cooldown between marches. */
  attackCooldownPct: number;
  /** Added to the barracks queue depth. */
  barracksQueueDepth: number;
  /** Set outright, when set: the odds a captain wants before he will march
   * (see AiStrategy.marchConfidence). Null leaves the playbook's, which is
   * 0 on every printed line — marching on headcount alone. */
  marchConfidence: number | null;
  /** A floor under the recall radius: a seat told to keep this many tiles
   * of guard around its castle fights at home rather than abroad. 0 is no
   * floor. */
  homeGuardFloor: number;
  /** Forced, when set: whether a rival is preferred over a nearer bandit
   * camp. Null leaves the playbook's (and the stance's) own answer. */
  prefersRivals: boolean | null;
  /** Forced, when set: whether a losing march turns home. Null leaves the
   * playbook's character alone — which is what `hard` does. */
  retreats: boolean | null;
  /**
   * What happens to the playbook's harassment sorties.
   *
   * `off` strikes them, `keep` leaves them, `press` sharpens the ones a
   * playbook already runs (a bigger party, coming round sooner) and grants
   * none to a playbook that runs none. That last clause is the "hard only
   * sharpens" rule at its sharpest: the abbot's refusal to raid survives
   * the hardest setting in the game.
   */
  harass: 'off' | 'keep' | 'press';
  /** Percent of the doorstep re-scout period — how soon this lord comes to
   * read your yard again. */
  scoutRefreshPct: number;
  /**
   * Percent of AI_PACING.decisionInterval — how long this lord takes
   * between thoughts. A slower beat is a seat that notices a raid, a stall
   * or a fallen sortie later than the game moves, which is a different kind
   * of weakness from a smaller army and the one a player reads as "it is
   * not paying attention".
   *
   * Cuts both ways. The seats spread their beats ACROSS the interval
   * (AI_PACING.seatSlots) rather than by a fixed stride, so "no two brains
   * on one tick" survives the interval moving in either direction — the
   * fixed stride it replaced did not, and would have put seats 0 and 2 on
   * the same tick at half the cadence. Floored at MIN_DECISION_INTERVAL,
   * since past a point a faster clock is a CPU bill rather than a
   * personality.
   */
  decisionIntervalPct: number;

  // — The computer seats: economy —
  /** Added to the serfs hired up to. */
  serfTarget: number;
  /** Percent of the silver held back from hiring while research is pending
   * (less held back is a faster village). */
  researchReservePct: number;
  /** Added to the standing house ceiling. */
  houseLimit: number;
  /** Added to the empty-bed headroom kept standing. */
  housingHeadroom: number;

  // — The campaign's scenarios (the human seat's opening) —
  /** Percent of the commission's opening larder. */
  startStockPct: number;
  /** Added to the hands standing in the yard at the first tick. */
  startSerfs: number;
  /** Percent of the opening peace before the first bandit raid. */
  firstRaidTickPct: number;
}

/**
 * Bounds every tier's arithmetic lands inside, whatever playbook it was
 * applied to. Deliberately NOT src/ai/advice.ts's ADVICE_RANGES, which
 * these mostly agree with: those are a contract with an advisor (they are
 * quoted into a prompt and enforced on what comes back), and src/ai
 * imports the sim rather than the other way round. difficulty.test.ts
 * asserts the two agree where they overlap, so a change to either is a
 * decision rather than a drift.
 */
const CLAMP = {
  armyAttackSize: [3, 16],
  attackCooldown: [200, 2000],
  barracksQueueDepth: [1, 4],
  marchConfidence: [0, 90],
  homeGuard: [0, 20],
  scoutRefreshAfter: [500, 20_000],
  serfTarget: [6, 20],
  researchReserve: [0, 20],
  houseLimit: [2, 8],
  housingHeadroom: [1, 6],
} as const satisfies Record<string, readonly [number, number]>;

/**
 * The doorstep re-scout period a playbook that prints no `scoutRefreshAfter`
 * runs on — AI_INTEL.refreshAfter, copied rather than imported: this file is
 * defs/ and that constant lives in systems/ai.ts, which reads defs/. The
 * copy is pinned by difficulty.test.ts, so the two cannot drift apart in
 * silence.
 */
export const DEFAULT_SCOUT_REFRESH = 4_000;

function clamp(v: number, [lo, hi]: readonly [number, number]): number {
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

/** Percent of a value, as an integer. */
function pct(v: number, percent: number): number {
  return Math.round((v * percent) / 100);
}

/**
 * The shortest beat any tier may think on. One tick per seat is the hard
 * floor — the brains stagger across the interval (AI_PACING.seatSlots) and
 * two of them landing on the same tick is the one thing that arrangement
 * exists to prevent — and this sits well above it, because a seat thinking
 * every other tick is a CPU bill, not a personality.
 */
const MIN_DECISION_INTERVAL = 8;

/**
 * Ticks between one seat's decision beats at this tier, given the printed
 * cadence. See Difficulty.decisionIntervalPct.
 */
export function scaleDecisionInterval(
  printed: number,
  tier: DifficultyId | undefined,
): number {
  const d = difficultyOf(tier);
  return Math.max(MIN_DECISION_INTERVAL, pct(printed, d.decisionIntervalPct));
}

export const DIFFICULTIES: Record<DifficultyId, Difficulty> = {
  [DifficultyIdNs.easy]: {
    id: DifficultyIdNs.easy,
    name: 'Easy',
    blurb:
      'Opponents muster late, raid nobody and turn for home when a fight ' +
      'sours. Commissions open with a full larder and a long peace.',
    // Three more men before it will march, and half again as long between
    // marches: the same lord, arriving later and less often.
    armyAttackSize: 3,
    attackCooldownPct: 175,
    barracksQueueDepth: -1,
    // 60 wants a clear win before marching at all (see
    // AiStrategy.marchConfidence): an easy seat refuses the even fight it
    // would otherwise take, which is what makes it beatable rather than
    // merely slow.
    marchConfidence: 60,
    // Twelve tiles of guard: an easy lord answers a knock at his own gate
    // instead of pressing an attack on yours.
    homeGuardFloor: 12,
    prefersRivals: false,
    retreats: true,
    harass: 'off',
    scoutRefreshPct: 175,
    // A thought every two seconds where everyone else gets one a second.
    // The seat is not dumber for it — same playbook, same rules — it is
    // LATE: the raid is already in the yard, the sortie has already died,
    // the shelf has been full for a beat longer than the game gave anyone
    // else. That reads as an opponent you can get ahead of, which is what
    // an easy setting is for.
    decisionIntervalPct: 200,
    serfTarget: -3,
    researchReservePct: 175,
    houseLimit: -1,
    housingHeadroom: -1,
    startStockPct: 150,
    startSerfs: 2,
    firstRaidTickPct: 150,
  },

  // The printed game. Every additive is 0, every percentage is 100 and
  // every override is null, and applyDifficulty short-circuits on the id
  // besides — a normal match is byte-for-byte the match this build played
  // before difficulty existed, which is what keeps the balance sweep's
  // standing numbers (tools/aiLab/README.md) meaningful.
  [DifficultyIdNs.normal]: {
    id: DifficultyIdNs.normal,
    name: 'Normal',
    blurb: 'The printed game: every playbook and every commission as written.',
    armyAttackSize: 0,
    attackCooldownPct: 100,
    barracksQueueDepth: 0,
    marchConfidence: null,
    homeGuardFloor: 0,
    prefersRivals: null,
    retreats: null,
    harass: 'keep',
    scoutRefreshPct: 100,
    decisionIntervalPct: 100,
    serfTarget: 0,
    researchReservePct: 100,
    houseLimit: 0,
    housingHeadroom: 0,
    startStockPct: 100,
    startSerfs: 0,
    firstRaidTickPct: 100,
  },

  [DifficultyIdNs.hard]: {
    id: DifficultyIdNs.hard,
    name: 'Hard',
    blurb:
      'Opponents grow wider, muster sooner, raid harder and come looking ' +
      'for you early. Commissions open lean and the peace runs short.',
    // Two fewer men and a third off the wait. Nothing here forces a
    // behavior a playbook does not already have — see the header's rule:
    // `retreats` and `prefersRivals` stay null, and `harass: press`
    // sharpens a sortie without granting one.
    armyAttackSize: -2,
    attackCooldownPct: 70,
    barracksQueueDepth: 1,
    marchConfidence: null,
    homeGuardFloor: 0,
    prefersRivals: null,
    retreats: null,
    harass: 'press',
    scoutRefreshPct: 65,
    decisionIntervalPct: 100,
    serfTarget: 3,
    researchReservePct: 60,
    houseLimit: 1,
    housingHeadroom: 1,
    startStockPct: 70,
    startSerfs: -1,
    firstRaidTickPct: 70,
  },
};

export const DIFFICULTY_ORDER: DifficultyId[] = [
  DifficultyIdNs.easy,
  DifficultyIdNs.normal,
  DifficultyIdNs.hard,
];

/**
 * The spelling of each tier, for the places a person names one: the
 * ?difficulty parameter, the lobby's config patches, and a replay's config
 * head.
 */
export const DIFFICULTY_KEYS: Readonly<Record<DifficultyId, string>> = {
  [DifficultyIdNs.easy]: 'easy',
  [DifficultyIdNs.normal]: 'normal',
  [DifficultyIdNs.hard]: 'hard',
};

const DIFFICULTY_BY_KEY = new Map<string, DifficultyId>(
  DIFFICULTY_ORDER.map(id => [DIFFICULTY_KEYS[id], id]),
);

/**
 * One tier id, or undefined for 'not stated'. The single gate for anything
 * a player can write — a URL is hand-editable and a lobby patch arrives off
 * a socket. `Object.hasOwn` on the key table, so no prototype row answers.
 */
export function parseDifficultyId(raw: unknown): DifficultyId | undefined {
  if (typeof raw === 'string') return DIFFICULTY_BY_KEY.get(raw);
  return typeof raw === 'number' && Object.hasOwn(DIFFICULTY_KEYS, raw)
    ? (raw as DifficultyId)
    : undefined;
}

/** A tier id from anywhere, resolved. Nothing stated is `normal` — the
 * setting a save from before difficulty existed is played at, and the one
 * every recorded measurement was taken under. */
export function difficultyOf(id: DifficultyId | undefined): Difficulty {
  return DIFFICULTIES[id ?? DifficultyIdNs.normal];
}

/**
 * The playbook a seat actually plays this beat, at this tier.
 *
 * Applied over knobs the brain has ALREADY composed — playbook, then the
 * stance's mood, then any advice — rather than merged in among them, and
 * the order is load-bearing. The five war knobs a stance sets
 * (STANCE_KNOB_KEYS in defs/aiPostures.ts) are the same five a difficulty
 * most wants to move, so a tier merged before the stance would be erased by
 * the seat's next mood, and a tier merged as a flat object would pin those
 * knobs and leave the stance engine with nothing to say. A transform over
 * the composed result scales whatever mood the seat is in, which is the
 * only arrangement in which "harder" and "has personalities" are both true.
 *
 * `normal` returns its input untouched, by reference: the printed game.
 */
export function applyDifficulty(
  s: AiStrategy,
  tier: DifficultyId | undefined,
): AiStrategy {
  const d = difficultyOf(tier);
  if (d.id === DifficultyIdNs.normal) return s;
  return {
    ...s,
    armyAttackSize: clamp(
      s.armyAttackSize + d.armyAttackSize,
      CLAMP.armyAttackSize,
    ),
    attackCooldown: clamp(
      pct(s.attackCooldown, d.attackCooldownPct),
      CLAMP.attackCooldown,
    ),
    barracksQueueDepth: clamp(
      s.barracksQueueDepth + d.barracksQueueDepth,
      CLAMP.barracksQueueDepth,
    ),
    marchConfidence:
      d.marchConfidence === null
        ? s.marchConfidence
        : clamp(d.marchConfidence, CLAMP.marchConfidence),
    homeGuard: clamp(Math.max(s.homeGuard, d.homeGuardFloor), CLAMP.homeGuard),
    prefersRivals: d.prefersRivals ?? s.prefersRivals,
    retreats: d.retreats ?? s.retreats,
    ...harassAt(s, d),
    scoutRefreshAfter: clamp(
      pct(s.scoutRefreshAfter ?? DEFAULT_SCOUT_REFRESH, d.scoutRefreshPct),
      CLAMP.scoutRefreshAfter,
    ),
    // Never below the panic floor, whatever the tier subtracts: a village
    // told to keep fewer hands than the number it hires at regardless is
    // not an easier opponent, it is an incoherent one.
    serfTarget: Math.max(
      s.survivalFloor,
      clamp(s.serfTarget + d.serfTarget, CLAMP.serfTarget),
    ),
    researchReserve: clamp(
      pct(s.researchReserve, d.researchReservePct),
      CLAMP.researchReserve,
    ),
    houseLimit: clamp(s.houseLimit + d.houseLimit, CLAMP.houseLimit),
    housingHeadroom: clamp(
      s.housingHeadroom + d.housingHeadroom,
      CLAMP.housingHeadroom,
    ),
  };
}

/** The sortie clause of applyDifficulty, spelled apart because `harass` is
 * the one knob a tier may delete outright. A spread of `{}` leaves the
 * playbook's own, `{harass: undefined}` strikes it. */
function harassAt(
  s: AiStrategy,
  d: Difficulty,
): Pick<AiStrategy, 'harass'> | Record<string, never> {
  if (d.harass === 'keep') return {};
  if (d.harass === 'off') return {harass: undefined};
  // press: sharpen a party that already rides, grant none that does not.
  if (!s.harass) return {};
  return {
    harass: {
      size: s.harass.size + 1,
      cooldown: Math.max(200, pct(s.harass.cooldown, 70)),
      maxAge: s.harass.maxAge,
    },
  };
}

/**
 * A commission's opening larder at this tier — every good scaled, and
 * nothing rounded away to nothing: a tier that turned the last hammer into
 * no hammer would change what a commission teaches rather than how hard it
 * is to learn, so a good the recipe lists at all still arrives.
 */
export function scaleStartStock(
  stock: GoodAmounts,
  tier: DifficultyId | undefined,
): GoodAmounts {
  const d = difficultyOf(tier);
  if (d.startStockPct === 100) return stock;
  const out: GoodAmounts = {};
  for (const [good, amount] of goodEntries(stock)) {
    out[good] = amount > 0 ? Math.max(1, pct(amount, d.startStockPct)) : amount;
  }
  return out;
}

/** The hands standing in the yard at the first tick. Never fewer than two:
 * one serf cannot build and haul at once, and a commission that cannot be
 * started is not a hard one. */
export function scaleStartSerfs(
  serfs: number,
  tier: DifficultyId | undefined,
): number {
  return Math.max(2, serfs + difficultyOf(tier).startSerfs);
}

/** The opening peace, in ticks, before the first bandit raid. */
export function scaleFirstRaidTick(
  ticks: number,
  tier: DifficultyId | undefined,
): number {
  const d = difficultyOf(tier);
  return d.firstRaidTickPct === 100 ? ticks : pct(ticks, d.firstRaidTickPct);
}
