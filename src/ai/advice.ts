import { isPostureId, postureAdvice, type PostureId } from './posture.ts';
import type { AiStrategy } from '../sim/defs/aiStrategies.ts';
import { UnitTypeId } from '../sim/defs/units.ts';
import { asUnitTypeId } from '../sim/defs/units.ts';
import { postureFromKey } from './posture.ts';

/**
 * The contract between the LLM strategist and the AI brain: which playbook
 * knobs the model may turn, and how far. Everything else in this directory
 * exists to produce or consume this shape.
 *
 * The whitelist is deliberately narrow. The build order and research line
 * are NOT here: they encode hard-won opening knowledge (see the notes in
 * defs/aiStrategies.ts), and a 1B model rewriting them is how a seat bricks
 * itself. The model steers posture — how big an army, how soon it marches,
 * what it trains, how deep the economy grows — and the playbook keeps its
 * opening.
 *
 * Every reply is treated as hostile until parseAdvice has been over it:
 * keys are picked one by one (never spread, so __proto__ and friends stay
 * inert), numbers are rounded and clamped into the ranges below, enum
 * arrays are filtered to known ids. What survives is safe to merge over an
 * AiStrategy sight unseen.
 */

/** What the model may say. Every field optional: omitted means unchanged. */
export interface StrategyAdvice {
  /** Serfs hired up to. */
  serfTarget?: number;
  /** Soldiers standing before the army marches. */
  armyAttackSize?: number;
  /** Ticks between marches. */
  attackCooldown?: number;
  /** Recall radius around the castle; 0 leaves the army out. */
  homeGuard?: number;
  /** March on rivals even when a bandit camp is nearer. */
  prefersRivals?: boolean;
  /** Trained in order of preference. */
  trainPreference?: UnitTypeId[];
  /** Forge assignment by smith age: recipe index [spear, sword, bow]. */
  weaponMix?: number[];
  barracksQueueDepth?: number;
  houseLimit?: number;
  housingHeadroom?: number;
  /** Silver held back from hiring while research is pending. */
  researchReserve?: number;
  /** The stance these knobs came from, when they came from one. Carried so
   * the next prompt can name it and the debug overlay can show it; stripped
   * by toOverride like `reason`, since the sim knows only knobs. */
  posture?: PostureId;
  /** Share of our own army expected to survive the fight, below which the
   * march is refused; 0 marches on headcount alone, as every printed playbook
   * does. See MARCH_CONFIDENCE_RANGE. */
  marchConfidence?: number;
  /** The model's one-line rationale. Debug overlay only — never the sim. */
  reason?: string;
}

/** [min, max] per numeric knob — the ranges quoted to the model in the
 * prompt and enforced on whatever comes back. */
export const ADVICE_RANGES = {
  serfTarget: [6, 20],
  armyAttackSize: [3, 16],
  attackCooldown: [200, 2000],
  homeGuard: [0, 20],
  barracksQueueDepth: [1, 4],
  houseLimit: [2, 8],
  housingHeadroom: [1, 6],
  researchReserve: [0, 20],
} as const satisfies Partial<Record<keyof StrategyAdvice, readonly [number, number]>>;

/**
 * How much of his own army a captain must expect to still be standing after
 * the fight before he will march, as a percentage (sim/combatOdds.ts). 0 is
 * off. Not a power ratio: power is quadratic in headcount, so that scale
 * needed a bar near 1000% before it ever refused anything.
 *
 * Deliberately NOT a member of ADVICE_RANGES. The lab's `random` engine walks
 * that table's keys and draws `rng.int(numeric.length + 3)` per knob
 * (tools/aiLab/engines.ts), so a new key there lengthens the stream and every
 * recorded noise-floor number — 46.6% at forty seeds, 47.0% at eighty — stops
 * reproducing. The floor is load-bearing evidence; a knob is not worth
 * invalidating it for. Parsed by its own branch below instead, which is what
 * prefersRivals and weaponMix already do.
 */
export const MARCH_CONFIDENCE_RANGE: readonly [number, number] = [0, 90];

/** The soldiers a barracks can train — the only ids trainPreference keeps. */
export const ADVISABLE_UNITS: readonly UnitTypeId[] = [UnitTypeId.knight, UnitTypeId.spearman, UnitTypeId.archer];

/** Recipe indices a forge understands: 0 spear, 1 sword, 2 bow. */
const WEAPON_MIX_MAX = 2;
const REASON_MAX = 200;

/** Handed to WebLLM as response_format, so a conforming engine cannot even
 * emit a key outside the whitelist. parseAdvice still assumes it did. */
export const ADVICE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    serfTarget: { type: 'integer', minimum: 6, maximum: 20 },
    armyAttackSize: { type: 'integer', minimum: 3, maximum: 16 },
    attackCooldown: { type: 'integer', minimum: 200, maximum: 2000 },
    homeGuard: { type: 'integer', minimum: 0, maximum: 20 },
    prefersRivals: { type: 'boolean' },
    trainPreference: {
      type: 'array',
      items: { type: 'string', enum: [...ADVISABLE_UNITS] },
      maxItems: 3,
    },
    weaponMix: {
      type: 'array',
      items: { type: 'integer', minimum: 0, maximum: 2 },
      minItems: 1,
      maxItems: 3,
    },
    barracksQueueDepth: { type: 'integer', minimum: 1, maximum: 4 },
    houseLimit: { type: 'integer', minimum: 2, maximum: 8 },
    housingHeadroom: { type: 'integer', minimum: 1, maximum: 6 },
    researchReserve: { type: 'integer', minimum: 0, maximum: 20 },
    marchConfidence: { type: 'integer', minimum: 0, maximum: 90 },
    reason: { type: 'string' },
  },
  additionalProperties: false,
} as const;

function clampedInt(raw: unknown, range: readonly [number, number]): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.min(range[1], Math.max(range[0], Math.round(raw)));
}

/**
 * Raw model text → validated advice, or null when there is nothing to
 * salvage. A reply that parses but offers no usable knob comes back as {}:
 * "change nothing" is valid advice, garbage is not.
 *
 * Two reply shapes are accepted. `{"posture":"siege"}` is what the
 * strategist asks for now — a stance name, expanded here into the knob set
 * authored in posture.ts. Raw knobs still parse as they always did, which
 * is what keeps the lab's `random` noise floor and `script` engines
 * measuring the same thing they measured before postures existed. A reply
 * carrying both wins on the explicit knob: the posture lays the floor and
 * anything named individually overrides it.
 */
export function parseAdvice(raw: string): StrategyAdvice | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  // Read through a null-prototype copy is overkill; reading own properties
  // one key at a time is enough, since nothing here walks the prototype.
  const obj = parsed as Record<string, unknown>;
  // A posture names every knob it steers, so it goes down first and the
  // per-key passes below overwrite whatever the reply also spelled out.
  const advice: StrategyAdvice = {};
  // The model answers with the word it was shown; a posture reaching this
  // screen as an id (the lab, a replayed trace) is read too.
  const posture = postureFromKey(obj['posture']) ?? (isPostureId(obj['posture']) ? obj['posture'] : undefined);
  if (posture !== undefined) {
    Object.assign(advice, postureAdvice(posture));
    advice.posture = posture;
  }

  for (const key of Object.keys(ADVICE_RANGES) as (keyof typeof ADVICE_RANGES)[]) {
    if (!Object.hasOwn(obj, key)) continue;
    const v = clampedInt(obj[key], ADVICE_RANGES[key]);
    if (v !== undefined) advice[key] = v;
  }

  if (Object.hasOwn(obj, 'prefersRivals') && typeof obj['prefersRivals'] === 'boolean') {
    advice.prefersRivals = obj['prefersRivals'];
  }

  if (Object.hasOwn(obj, 'marchConfidence')) {
    const v = clampedInt(obj['marchConfidence'], MARCH_CONFIDENCE_RANGE);
    if (v !== undefined) advice.marchConfidence = v;
  }

  if (Object.hasOwn(obj, 'trainPreference') && Array.isArray(obj['trainPreference'])) {
    const seen = new Set<UnitTypeId>();
    for (const entry of obj['trainPreference']) {
      const unit = asUnitTypeId(entry);
      if (unit === undefined || !ADVISABLE_UNITS.includes(unit)) continue;
      seen.add(unit);
      if (seen.size >= 3) break;
    }
    // An empty preference would leave the barracks training nothing — a
    // list that filtered to nothing is dropped, not applied.
    if (seen.size > 0) advice.trainPreference = [...seen];
  }

  if (Object.hasOwn(obj, 'weaponMix') && Array.isArray(obj['weaponMix'])) {
    const mix: number[] = [];
    for (const entry of obj['weaponMix'].slice(0, 3)) {
      const v = clampedInt(entry, [0, WEAPON_MIX_MAX]);
      if (v === undefined) {
        mix.length = 0; // one bad entry poisons the list: partial mixes lie
        break;
      }
      mix.push(v);
    }
    if (mix.length > 0) advice.weaponMix = mix;
  }

  if (Object.hasOwn(obj, 'reason') && typeof obj['reason'] === 'string') {
    advice.reason = obj['reason'].slice(0, REASON_MAX);
  }

  return advice;
}

/** Advice → the override AiBrain merges over its playbook. `reason` and
 * `posture` are for humans and the next prompt; they stay behind. */
export function toOverride(advice: StrategyAdvice): Partial<AiStrategy> {
  const { reason: _reason, posture: _posture, ...knobs } = advice;
  return knobs;
}
