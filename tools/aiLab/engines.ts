import {ADVICE_RANGES, ADVISABLE_UNITS} from '../../src/ai/advice.ts';
import {
  choosePosture,
  choosePostureReadingOpponent,
  POSTURE_ORDER,
} from '../../src/ai/posture.ts';
import {
  type PostureId,
  postureFromKey,
  POSTURE_KEYS,
} from '../../src/ai/posture.ts';
import type {AiWorldSummary} from '../../src/ai/summary.ts';
import type {Enum} from '../../src/shared/enum.ts';
import {Rng} from '../../src/shared/rng.ts';
import * as UnitTypeId from '../../src/sim/defs/unitTypeIdEnum.ts';

type UnitTypeId = Enum<typeof UnitTypeId>;

/**
 * The advisors a bake-off can put in the strategist's seat.
 *
 * An engine reads one seat's summary and answers with advice as a JSON
 * string — the same wire format the LLM strategist used to emit, judged by
 * the same validator (parseAdvice) and applied through the same seam
 * (AiSeats.applyAdvice). The model era is over (it never beat the rule —
 * see the README's measurements), but the seam it was measured through is
 * the harness's instrument and stays: replies as strings through the real
 * parser, so what is measured is what a seat can actually be told.
 *
 * The engines that are not a model matter as much as ever:
 *
 *   - `none` is no advisor at all — the seat plays its printed playbook
 *     and its own brain. That is the control every arm is measured against.
 *   - `random` turns knobs at random, inside the same ranges and through
 *     the same validator. It is the noise floor, and it is the honest
 *     null: an advisor that cannot beat dice is not reading the summary,
 *     it is just perturbing the playbook, and perturbation alone moves win
 *     rates.
 *   - `script` answers with one fixed personality forever, which is how
 *     you sanity-check that advice reaches the field at all.
 *   - `posture` picks a stance by rule. It is the reference every recorded
 *     number was measured under, and the vehicle for testing a candidate
 *     stance rule as an override before it is ported into the shipped
 *     playbook data.
 */

/** An advisor: one seat's summary in, advice out as a JSON string. */
export interface LabEngine {
  /** For the report header and the JSONL records. */
  readonly label: string;
  /** One consultation. The reply goes through parseAdvice exactly as the
   * strategist's replies did; an unparseable one is recorded, not thrown. */
  advise(summary: AiWorldSummary): string;
}

export type EngineSpec =
  | {kind: 'none'}
  | {kind: 'script'; reply: unknown}
  | {kind: 'random'; seed: number}
  | {kind: 'posture'}
  | {kind: 'postureReads'}
  | {kind: 'postureFixed'; posture: PostureId};

/**
 * `--engine` text → a spec. Accepts:
 *   none                          the unadvised control
 *   random  |  random:7           the noise floor, optionally seeded
 *   posture                       rule-based stance picking
 *   posture-reads                 the same rule conditioned on an opponent
 *                                 archetype — measured, and it does not pay
 *   posture:siege                 one stance held all match, for ablation
 *   script:{"armyAttackSize":4}   one fixed personality
 */
export function parseEngineSpec(raw: string): EngineSpec {
  if (raw === 'none') return {kind: 'none'};
  if (raw === 'random') return {kind: 'random', seed: 1};
  if (raw === 'posture') return {kind: 'posture'};
  if (raw === 'posture-reads') return {kind: 'postureReads'};
  if (raw.startsWith('posture:')) {
    const word = raw.slice('posture:'.length);
    const posture = postureFromKey(word);
    if (posture === undefined) {
      throw new Error(
        `--engine posture: wants one of ${POSTURE_ORDER.map(id => POSTURE_KEYS[id]).join(', ')}, got "${word}"`,
      );
    }
    return {kind: 'postureFixed', posture};
  }
  if (raw.startsWith('random:')) {
    const seed = Number(raw.slice('random:'.length));
    if (!Number.isFinite(seed))
      throw new Error(`--engine random: wants a number, got "${raw}"`);
    return {kind: 'random', seed};
  }
  if (raw.startsWith('script:')) {
    const json = raw.slice('script:'.length);
    let reply: unknown;
    try {
      reply = JSON.parse(json);
    } catch {
      throw new Error(`--engine script: wants JSON, could not parse "${json}"`);
    }
    return {kind: 'script', reply};
  }
  throw new Error(
    `unrecognized --engine "${raw}" (want none | random[:n] | posture | posture-reads | ` +
      `posture:<${POSTURE_ORDER.join('|')}> | script:{...})`,
  );
}

/**
 * Spec → engine, or null for the unadvised control.
 *
 * `salt` distinguishes the engines of one bake-off from each other so the
 * random baseline is reproducible per (seed, seat) rather than replaying
 * one stream of dice across every match.
 */
export function buildEngine(spec: EngineSpec, salt: number): LabEngine | null {
  switch (spec.kind) {
    case 'none':
      return null;
    case 'script':
      return scriptEngine(spec.reply);
    case 'random':
      return randomEngine(spec.seed * 1_000_003 + salt);
    // describeSpec is the one author of these labels: engine.label rides
    // every advised[] JSONL line and describeSpec the report header, and a
    // divergence files the two halves of one run under different names.
    case 'posture':
      return postureEngine(choosePosture, describeSpec(spec));
    case 'postureReads':
      return postureEngine(choosePostureReadingOpponent, describeSpec(spec));
    case 'postureFixed':
      return scriptEngine({posture: spec.posture, reason: 'fixed'});
  }
}

/** How the spec should read in a report header. */
export function describeSpec(spec: EngineSpec): string {
  switch (spec.kind) {
    case 'none':
      return 'none (unadvised)';
    case 'script':
      return `script ${JSON.stringify(spec.reply)}`;
    case 'random':
      return `random (seed ${spec.seed})`;
    case 'posture':
      // NOT opponent-reading: choosePosture decides without a look at the
      // rival (that variant is 'postureReads'). This label rides every
      // report header and archived JSONL line, and posture vs posture-reads
      // is exactly the opponent-conditioning ablation the README scores —
      // a run filed under the wrong arm is indistinguishable from its null.
      return 'posture (rule-based, no model)';
    case 'postureReads':
      return 'posture-reads (rule-based, conditioned on an opponent archetype)';
    case 'postureFixed':
      return `posture ${spec.posture} (fixed)`;
  }
}

/** One fixed personality, forever. */
export function scriptEngine(reply: unknown): LabEngine {
  return {
    label: `script ${JSON.stringify(reply)}`,
    advise: () => JSON.stringify(reply),
  };
}

/**
 * The noise floor: valid advice chosen by dice.
 *
 * Deliberately *valid* — in range, right types, right enum members — so a
 * bake-off against it isolates the one thing under test. An advisor that
 * wins against `none` but ties against `random` bought you variance, not
 * judgment.
 *
 * The draw sequence is load-bearing: the recorded 46.6% / 47.0% noise-floor
 * readings reproduce only while a consultation spends its dice in exactly
 * this order over exactly ADVICE_RANGES' keys. That is the standing reason
 * ADVICE_RANGES is read and never added to.
 */
export function randomEngine(seed: number): LabEngine {
  const rng = new Rng(seed);
  const numeric = Object.keys(ADVICE_RANGES) as (keyof typeof ADVICE_RANGES)[];

  return {
    label: `random (seed ${seed})`,
    advise: () => {
      const reply: Record<string, unknown> = {reason: 'dice'};
      // One to four knobs, like a terse model that names only what moved.
      const knobs = 1 + rng.int(4);
      for (let i = 0; i < knobs; i++) {
        const which = rng.int(numeric.length + 3);
        if (which < numeric.length) {
          const key = numeric[which]!;
          const [lo, hi] = ADVICE_RANGES[key];
          reply[key] = lo + rng.int(hi - lo + 1);
        } else if (which === numeric.length) {
          reply['prefersRivals'] = rng.next() < 0.5;
        } else if (which === numeric.length + 1) {
          const order: UnitTypeId[] = [...ADVISABLE_UNITS];
          // Fisher-Yates, so every priority order is reachable.
          for (let j = order.length - 1; j > 0; j--) {
            const k = rng.int(j + 1);
            const swap = order[j]!;
            order[j] = order[k]!;
            order[k] = swap;
          }
          reply['trainPreference'] = order;
        } else {
          reply['weaponMix'] = Array.from({length: 1 + rng.int(3)}, () =>
            rng.pick([0, 1, 2]),
          );
        }
      }
      return JSON.stringify(reply);
    },
  };
}

/**
 * The rule-based strategist: a posture rule over the seat's summary.
 *
 * Deterministic and free, which made it the reference every model number
 * was read against — and the model never beat it, which is why there is no
 * model any more. It doubles as the test bench for stance rules: run a
 * candidate cascade here as advice, and only a paired win over the shipped
 * one earns it a place in the playbook data.
 *
 * The rule is a parameter because there are two of them: `choosePosture`,
 * the reference, and `choosePostureReadingOpponent`, which conditions on an
 * archetype and does not (yet) pay for it. The second is the first one's
 * null — conditioning on an opponent has to beat ignoring them, and running
 * both over the same seeds is the only way to know (`--engine
 * posture-reads` against `--engine posture`).
 */
export function postureEngine(
  pick: (summary: AiWorldSummary) => PostureId,
  label: string,
): LabEngine {
  return {
    label,
    advise: summary => JSON.stringify({posture: pick(summary), reason: 'rule'}),
  };
}
