import type {Enum} from '../../shared/enum.ts';
import type {AiStrategy} from './aiStrategies.ts';
import * as DifficultyIdNs from './difficultyEnum.ts';
import {goodEntries, type GoodAmounts} from './goods.ts';
import * as UnitTypeIdNs from './unitTypeIdEnum.ts';

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
 * ## Why `hard` is tuned gently, and what that cost
 *
 * Because piling more on it makes it WORSE, which is not a thing anyone
 * guesses. A deliberate ceiling test — every hard knob pushed to its clamp
 * at once, mustering at three, a quarter of the cooldown, twice the
 * village, thinking twice as often — scored 52.2% against `normal` where
 * the gentle table scores ~56-60%, and dragged the Warlord to 29%: a
 * playbook mustering at three with no time to arm them throws its men away
 * one at a time. The knobs are not a difficulty axis that keeps going.
 * They tune a line that was already tuned, and past a point they detune
 * it.
 *
 * Three narrower candidates went the same way and are recorded so nobody
 * re-runs them: forcing `retreats: false` (36/63, against 36/63 for
 * leaving it alone — identical, to the duel), a wider village (70/124
 * against 74/127), and a faster clock for hard (33/63). A confidence gate
 * on hard is the interesting one: it HELPED against easy (+5 points, by
 * keeping hard from feeding its army to a Fletcher's towers) and HURT
 * against normal by the same amount, because refusing marginal fights
 * against an equal is just passivity. It is not in the table for that
 * reason.
 *
 * So `hard` buys what its knobs can honestly buy and stops. Against
 * `easy` that is total (see below). Against `normal` it is 59.6%
 * [54.5, 64.5] over 369 duels — a real edge with genuine losses in it,
 * uneven across the deck (the Warlord clears 75%, the Steward is not
 * established as ahead at all), and one neither the intel and stance
 * levers nor micro measurably widened —
 * and the way to more is not a bigger number here. It is either a
 * capability `normal` lacks (reading the rival's arms and training the
 * counter, say) or the resource handout this table exists to avoid.
 *
 * ## What `easy` is for, and why it lost its home guard
 *
 * `easy` was first written as a turtle: a twelve-tile home guard, refusing
 * any fight without clear odds. That is a *defensively strong* seat, which
 * is the opposite of the brief — it survived sieges it had no business
 * surviving. What makes a seat beatable is not timidity, it is a village
 * that never grows the army in the first place: the house limit at its
 * floor, the hire target at its floor, one man in the barracks queue, the
 * research purse held shut, spears instead of swords, and a muster bar it
 * will never reach so it never comes for your castle at all.
 *
 * Measured that way, over 192 seed-and-playbook pairs across two ranges,
 * `hard` lost two valleys to `easy` that the valleys themselves had not
 * already decided (tools/aiLab/tiers.ts pair tally, one per range).
 * The raw mirrored rate is 85%, and it cannot be 100% for a reason that
 * has nothing to do with the tiers: this map generator deals some starts
 * so unequal that whoever holds the better one wins both seatings whatever
 * tier sits in it, and a seed like that contributes one win and one loss
 * to any rate, forever. See tools/aiLab/README.md for why that makes the
 * pair tally, not the percentage, the number to read — and for how that
 * tally read a clean zero at half the depth, which is its own lesson.
 *
 * `normal` over `easy` reads 82.3% pooled on the same sweep, so the deck
 * is ordered on the raw rate as well as on the tally.
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
   * Percent of AI_INTEL.trustFor — how long a sighting still says something
   * about tomorrow's battle.
   *
   * Memory, never vision. A tier may change how long a seat remembers what
   * it legitimately saw and how much of it it takes seriously; it may never
   * change what its people can see. That line is what keeps `hard` from
   * being a cheat, and it is why the fog model (systems/ai.ts) is untouched
   * at every setting.
   *
   * It reaches further than it looks. `#counterPlan` will not retool for a
   * rival whose picture has gone stale, so an easy seat that forgets
   * quickly stops answering what you field at all — it keeps making what
   * its playbook printed while you walk knights into its spearmen. The
   * counter-arming is not removed from easy; it is starved of the evidence
   * it runs on, which is the same weakness a slow scout would produce and
   * needs no second switch.
   */
  intelTrustPct: number;
  /**
   * Added to AI_INTEL.minSighting — fighters that have to be seen at once
   * before the seat calls it an army rather than an anecdote. Higher is a
   * seat that under-reacts to a real muster; lower is one that takes a
   * thin sighting seriously. Never below 1.
   */
  minSighting: number;
  /**
   * Whether the seat micros its soldiers: focus fire, and pulling the
   * wounded out of the line (warBehaviorIdEnum `focusFire`,
   * `withdrawWounded`).
   *
   * A capability rather than a magnitude, and the only one in this table —
   * everything else here scales something every tier already does. It sits
   * outside the header's "hard may only sharpen" rule for the same reason
   * the war behaviours sit outside a playbook: micro is brain competence,
   * not a lord's character. No playbook expresses an opinion about pulling
   * a bleeding man out of a fight, so granting it to `hard` flattens
   * nobody — where granting `hard` a sortie the Abbot refuses would.
   *
   * Worth more here than in most games of this shape, because damage is
   * flat: `strikeUnit` reads the attacker's printed damage, never its
   * remaining health, and nothing heals. So a soldier pulled out at a
   * sliver was contributing his full output right up to the moment he
   * would have died, and he is still worth that in the next fight.
   *
   * Measured, and the first version was NEGATIVE: focusing the whole
   * squad, melee included, scored 57.7% against `normal` where no micro
   * at all scores 60.8% — worse on both seed ranges. A spearman already
   * swinging at the man in front of him, told to attack somebody else,
   * leaves that fight to walk; the verb bought a hole in the line and
   * spent the damage it meant to concentrate. Restricted to archers
   * choosing among what they can already hit, it reads 59.6%
   * [54.5, 64.5]: no longer a cost, and indistinguishable from leaving it
   * off. Against `easy` the lost-valley count went from two in 192 pairs
   * to zero — but that is two events, and the win rate on the same
   * pairing moved by one duel in 384, so it is not evidence of a gain and
   * is not offered as one.
   *
   * So this is kept for legibility, under the rule warBehaviorIdEnum
   * states for its own verbs: a payoff that is drama rather than win rate
   * still owes proof that it does not COST a rate. The first cut failed
   * that; this one pays it. The two verbs have only ever been measured
   * together — `setWarBehaviors` is the seam for telling them apart.
   */
  micro: boolean;
  /**
   * Whether the seat learns from a march that was wiped out
   * (warBehaviorIdEnum `wipedMarch`, AI_WAR.wipeLesson): the next march on
   * the same castle wants more men than the party that died there,
   * whatever the muster bar's clamps would settle for.
   *
   * A capability, like `micro`, and outside the header's rule for the same
   * reason: no playbook expresses an opinion about marching the same three
   * knights into the same tower every cooldown. The lesson is the reverse
   * of the confidence gate the header records as measured and rejected —
   * that one refused fights it predicted losing, which against an equal
   * read as passivity; this one refuses only a fight it has already lost
   * outright, with that exact force, and marches the moment it has more.
   * On for `normal` as well — a lord who keeps feeding the same three men
   * to the same tower reads as broken rather than beatable — and off for
   * `easy` on purpose, which is the one tier meant to be beaten that way.
   */
  remembersWipes: boolean;
  /**
   * Whether the seat marches around the towers it knows of
   * (warBehaviorIdEnum `flankMarch`, AI_WAR.flankLeg and friends): the
   * all-in march plans its own road to the castle, charging every tile a
   * known enemy tower reaches, and walks it in legs where that road
   * differs from the shortest. A capability like `micro`, and `hard`
   * alone: reading a wall and going round it is brain competence, and the
   * lower tiers are meant to walk under it.
   */
  flanksTowers: boolean;
  /**
   * Percent of the stance engine's clocks (AI_STANCE.evalPeriod and
   * `dwell`) — how often a seat re-reads which mood it should be in, and
   * how long it must hold one before it may change again.
   *
   * A different weakness from a slow decision beat, and it reads
   * differently across the table. A late seat is uniformly behind; a seat
   * with long stance clocks is behind ONLY when the situation turns, and
   * then very visibly — it keeps besieging after its own yard is burning,
   * it keeps turtling long after you have left. The break-in to `fortify`
   * is exempt in the engine itself, so even the sluggish tier still
   * answers a hostile in the yard on the beat.
   */
  stanceLatencyPct: number;

  /**
   * Soldiers standing before the seat's `found` stance takes over — the
   * moment it stops opening and starts prosecuting a war it has seen a
   * castle for (AiStrategy.stances.foundAfterArmy). Null leaves the
   * playbook's own.
   *
   * The one knob here that changes WHEN a seat commits rather than how
   * hard it swings, which is why it moves the needle where a dozen
   * magnitude nudges did not. Hard commits the moment it finds you; easy
   * waits for a muster its own house limit will not let it reach, so it
   * opens all game and never comes.
   */
  foundAfterArmy: number | null;
  /**
   * Arms every soldier with the spear and nothing else — the cheapest
   * weapon in the game and the one that loses to the knight it will meet.
   * A playbook's `trainPreference` and `weaponMix` are among the loudest
   * things about it (the Fletcher's bows, the Warlord's swords), so this
   * is a softening lever only: `easy` uses it, and the header's rule keeps
   * `hard` from having an equivalent.
   */
  spearsOnly: boolean;
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
  /**
   * Percent of the gap between raid waves after the first. The opening
   * peace is the more dramatic number and the between-waves clock is the
   * one that decides the commission: a mission is won or lost on whether
   * the village can rebuild between raids, and that gap is where the
   * pressure actually lives.
   */
  raidIntervalPct: number;
  /**
   * Added to RAID_CAP, the most raiders one wave may hold. The wave's
   * composition still escalates exactly as authored; this is only how many
   * of it arrive.
   */
  raidCap: number;
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
/** How long a sighting still counts, at this tier (AI_INTEL.trustFor). */
export function scaleIntelTrust(
  printed: number,
  tier: DifficultyId | undefined,
): number {
  return Math.max(500, pct(printed, difficultyOf(tier).intelTrustPct));
}

/** Fighters seen at once before the seat calls it an army
 * (AI_INTEL.minSighting). Never below one — a seat that cannot believe in
 * a single soldier has no picture at all. */
export function scaleMinSighting(
  printed: number,
  tier: DifficultyId | undefined,
): number {
  return Math.max(1, printed + difficultyOf(tier).minSighting);
}

/** One of the stance engine's clocks, at this tier (AI_STANCE.evalPeriod or
 * `dwell` — both move together, since a mood re-read more often but held
 * just as long is a mood that still cannot change). */
export function scaleStanceClock(
  printed: number,
  tier: DifficultyId | undefined,
): number {
  return Math.max(100, pct(printed, difficultyOf(tier).stanceLatencyPct));
}

/** The gap between raid waves on a commission (raidIntervalFor). */
export function scaleRaidInterval(
  printed: number,
  tier: DifficultyId | undefined,
): number {
  const d = difficultyOf(tier);
  return d.raidIntervalPct === 100 ? printed : pct(printed, d.raidIntervalPct);
}

/** The most raiders one wave may hold on a commission (RAID_CAP). Never
 * below two: a "wave" of one is not a raid, it is a straggler. */
export function scaleRaidCap(
  printed: number,
  tier: DifficultyId | undefined,
): number {
  return Math.max(2, printed + difficultyOf(tier).raidCap);
}

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
    // would otherwise take.
    marchConfidence: 60,
    // No floor, and this is the correction the measurements forced. A home
    // guard reads like timidity and plays like a wall: the twelve tiles
    // that used to be here kept an easy seat's whole army in its own yard,
    // where it defended the castle far better than it had any business
    // doing. An easy lord is beatable because it never fields much, not
    // because it huddles.
    homeGuardFloor: 0,
    prefersRivals: false,
    retreats: true,
    harass: 'off',
    scoutRefreshPct: 175,
    intelTrustPct: 60,
    minSighting: 2,
    stanceLatencyPct: 250,
    micro: false,
    remembersWipes: false,
    flanksTowers: false,
    // A muster this village cannot reach: fourteen soldiers on a thirty-bed
    // cap that also has to staff every post. So an easy seat never leaves
    // its opening for the stance that goes and takes a castle — it defends,
    // it putters, and it does not come for you.
    foundAfterArmy: 14,
    spearsOnly: true,
    // A thought every two seconds where everyone else gets one a second.
    // The seat is not dumber for it — same playbook, same rules — it is
    // LATE: the raid is already in the yard, the sortie has already died,
    // the shelf has been full for a beat longer than the game gave anyone
    // else. That reads as an opponent you can get ahead of, which is what
    // an easy setting is for.
    decisionIntervalPct: 200,
    // The village, at its floors. Everything above is about when the army
    // moves; this is why there is barely an army to move — the house limit
    // clamps to 2 (thirty beds against the printed forty), the hire target
    // to 6, and the research purse stays shut so even those come slowly.
    serfTarget: -6,
    researchReservePct: 175,
    houseLimit: -3,
    housingHeadroom: -3,
    startStockPct: 150,
    startSerfs: 2,
    firstRaidTickPct: 150,
    raidIntervalPct: 150,
    raidCap: -2,
  },

  // The printed game. Every additive is 0, every percentage is 100 and
  // every override is null, and applyDifficulty short-circuits on the id
  // besides — a normal match is byte-for-byte the match this build played
  // before difficulty existed, which is what keeps the balance sweep's
  // standing numbers (tools/aiLab/README.md) meaningful. The one
  // capability it carries, `remembersWipes`, is read beside the knobs
  // rather than through them, and is part of the printed game now.
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
    intelTrustPct: 100,
    minSighting: 0,
    stanceLatencyPct: 100,
    foundAfterArmy: null,
    micro: false,
    remembersWipes: true,
    flanksTowers: false,
    spearsOnly: false,
    decisionIntervalPct: 100,
    serfTarget: 0,
    researchReservePct: 100,
    houseLimit: 0,
    housingHeadroom: 0,
    startStockPct: 100,
    startSerfs: 0,
    firstRaidTickPct: 100,
    raidIntervalPct: 100,
    raidCap: 0,
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
    intelTrustPct: 150,
    minSighting: -1,
    stanceLatencyPct: 70,
    micro: true,
    remembersWipes: true,
    flanksTowers: true,
    foundAfterArmy: null,
    spearsOnly: false,
    decisionIntervalPct: 100,
    serfTarget: 3,
    researchReservePct: 60,
    houseLimit: 1,
    housingHeadroom: 1,
    startStockPct: 70,
    startSerfs: -1,
    firstRaidTickPct: 70,
    raidIntervalPct: 70,
    raidCap: 2,
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
    stances:
      d.foundAfterArmy === null
        ? s.stances
        : {...s.stances, foundAfterArmy: d.foundAfterArmy},
    ...(d.spearsOnly
      ? {
          // Index 0 of a forge's recipeOptions is the spear; one entry
          // means every smith, however old, takes it (see
          // AiStrategy.weaponMix).
          trainPreference: [UnitTypeIdNs.spearman],
          weaponMix: [0],
        }
      : {}),
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
