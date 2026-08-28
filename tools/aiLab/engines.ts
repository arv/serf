import { ADVICE_RANGES, ADVISABLE_UNITS } from '../../src/ai/advice.ts';
import {
  choosePosture,
  choosePostureReadingOpponent,
  POSTURE_ORDER,
} from '../../src/ai/posture.ts';
import { extractSummary } from '../../src/ai/prompt.ts';
import { Rng } from '../../src/shared/rng.ts';
import { type PostureId, postureFromKey, POSTURE_KEYS } from '../../src/ai/posture.ts';
import type { AiWorldSummary } from '../../src/ai/summary.ts';
import type { ChatEngine } from '../../src/ai/strategist.ts';
import { UnitTypeId } from '../../src/sim/defs/units.ts';

/**
 * The models a bake-off can put in the strategist's seat.
 *
 * Everything here satisfies ChatEngine — the same one-method seam the real
 * wllama engine implements — so a match runs the genuine pipeline either
 * way: real prompts out of prompt.ts, real parsing and clamping through
 * advice.ts, real failure counting in LlmStrategist. Only the weights
 * change.
 *
 * The three that are not a model matter as much as the one that is:
 *
 *   - `none` is no strategist at all — the seat plays its printed
 *     playbook. That is the control every arm is measured against.
 *   - `random` turns knobs at random, inside the same ranges and through
 *     the same validator. It is the noise floor, and it is the honest
 *     null: a model that cannot beat dice is not reading the summary, it
 *     is just perturbing the playbook, and perturbation alone moves win
 *     rates. Run it before you believe any model's number.
 *   - `script` answers with one fixed personality forever, which is how
 *     you sanity-check that advice reaches the field at all.
 *   - `posture` picks a stance by rule, with no model in the loop. It is
 *     the bar that matters now that the strategist chooses from a menu:
 *     `random` only asks whether a model beats dice, while this asks the
 *     sharper question — whether it beats the dozen lines of if/else that
 *     read the same summary for free. A model that ties this is a 400 MB
 *     download standing in for a switch statement.
 *
 * Real weights are reached over HTTP rather than through wllama, because
 * wllama is a browser thing (workers, cache storage, SharedArrayBuffer)
 * and a lab wants a CLI. `llama-server -m model.gguf` puts the *same GGUF*
 * behind the *same llama.cpp grammar-constrained decoding* the browser
 * would use, so the decisions measured here are the decisions that ship.
 * What it does NOT measure is wasm inference speed — see the README.
 */

/** A ChatEngine that also says what it is and keeps whatever token
 * accounting its backend volunteered. */
export interface LabEngine extends ChatEngine {
  /** For the report header and the JSONL records. */
  readonly label: string;
  /** Appended per call, when the backend reports usage; empty otherwise. */
  readonly usage: TokenUsage[];
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export type EngineSpec =
  | { kind: 'none' }
  | { kind: 'script'; reply: unknown }
  | { kind: 'random'; seed: number }
  | { kind: 'posture' }
  | { kind: 'postureReads' }
  | { kind: 'postureFixed'; posture: PostureId }
  | { kind: 'http'; baseUrl: string; model: string };

/**
 * `--engine` text → a spec. Accepts:
 *   none                          the unadvised control
 *   random  |  random:7           the noise floor, optionally seeded
 *   posture                       rule-based stance picking, no model
 *   posture-reads                 the same rule conditioned on an opponent
 *                                 archetype — measured, and it does not pay
 *   posture:siege                 one stance held all match, for ablation
 *   script:{"armyAttackSize":4}   one fixed personality
 *   http://host:port/v1           any OpenAI-compatible server
 */
export function parseEngineSpec(raw: string, model = 'local-model'): EngineSpec {
  if (raw === 'none') return { kind: 'none' };
  if (raw === 'random') return { kind: 'random', seed: 1 };
  if (raw === 'posture') return { kind: 'posture' };
  if (raw === 'posture-reads') return { kind: 'postureReads' };
  if (raw.startsWith('posture:')) {
    const word = raw.slice('posture:'.length);
    const posture = postureFromKey(word);
    if (posture === undefined) {
      throw new Error(
        `--engine posture: wants one of ${POSTURE_ORDER.map((id) => POSTURE_KEYS[id]).join(', ')}, got "${word}"`,
      );
    }
    return { kind: 'postureFixed', posture };
  }
  if (raw.startsWith('random:')) {
    const seed = Number(raw.slice('random:'.length));
    if (!Number.isFinite(seed)) throw new Error(`--engine random: wants a number, got "${raw}"`);
    return { kind: 'random', seed };
  }
  if (raw.startsWith('script:')) {
    const json = raw.slice('script:'.length);
    let reply: unknown;
    try {
      reply = JSON.parse(json);
    } catch {
      throw new Error(`--engine script: wants JSON, could not parse "${json}"`);
    }
    return { kind: 'script', reply };
  }
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return { kind: 'http', baseUrl: raw.replace(/\/+$/, ''), model };
  }
  throw new Error(
    `unrecognized --engine "${raw}" (want none | random[:n] | posture | posture-reads | ` +
      `posture:<${POSTURE_ORDER.join('|')}> | script:{...} | http://…/v1)`,
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
      return scriptEngine({ posture: spec.posture, reason: 'fixed' });
    case 'http':
      return httpEngine(spec.baseUrl, spec.model);
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
    case 'http':
      return `${spec.model} @ ${spec.baseUrl}`;
  }
}

/** One fixed personality, forever. */
export function scriptEngine(reply: unknown): LabEngine {
  return {
    label: `script ${JSON.stringify(reply)}`,
    usage: [],
    complete: () => Promise.resolve(JSON.stringify(reply)),
  };
}

/**
 * The noise floor: valid advice chosen by dice.
 *
 * Deliberately *valid* — in range, right types, right enum members — so a
 * bake-off against it isolates the one thing under test. If the model wins
 * against `none` but ties against `random`, what it bought you was
 * variance, not judgment.
 */
export function randomEngine(seed: number): LabEngine {
  const rng = new Rng(seed);
  const numeric = Object.keys(ADVICE_RANGES) as (keyof typeof ADVICE_RANGES)[];

  return {
    label: `random (seed ${seed})`,
    usage: [],
    complete: () => {
      const reply: Record<string, unknown> = { reason: 'dice' };
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
          reply['weaponMix'] = Array.from({ length: 1 + rng.int(3) }, () => rng.pick([0, 1, 2]));
        }
      }
      return Promise.resolve(JSON.stringify(reply));
    },
  };
}

/**
 * The rule-based strategist: a posture rule over the summary recovered from
 * the prompt, wearing a ChatEngine's clothes.
 *
 * Deterministic and free, which makes it the reference every model number
 * should be read against. It also doubles as a shippable opponent — the
 * same stances the model chooses from, chosen well, with no download and no
 * inference.
 *
 * The rule is a parameter because there are two of them: `choosePosture`,
 * the reference, and `choosePostureReadingOpponent`, which conditions on an
 * archetype and does not (yet) pay for it. The
 * second is the first one's null — conditioning on an opponent has to beat
 * ignoring them, and running both over the same seeds is the only way to
 * know (`--engine posture-reads` against `--engine posture`).
 *
 * A prompt whose summary cannot be recovered answers `{}` rather than
 * throwing: an unreadable prompt is a bug in the harness, and failing the
 * match would hide it behind the strategist's three-strikes rule.
 */
export function postureEngine(
  pick: (summary: AiWorldSummary) => PostureId,
  label: string,
): LabEngine {
  return {
    label,
    usage: [],
    complete: (messages) => {
      const summary = extractSummary(messages);
      if (!summary) return Promise.resolve('{}');
      return Promise.resolve(JSON.stringify({ posture: pick(summary), reason: 'rule' }));
    },
  };
}

/**
 * Any OpenAI-compatible chat endpoint: llama.cpp's `llama-server`, Ollama,
 * vLLM, LM Studio. Sampling matches strategist.ts so the lab and the game
 * ask the same question of the same weights.
 *
 * The schema fallback mirrors the real engine too: a server that cannot
 * compile the JSON schema into a grammar drops to plain JSON mode for the
 * rest of the run rather than failing the match — parseAdvice was always
 * the real gate, and a model that needs the fallback is itself a finding
 * worth seeing in the report.
 */
export function httpEngine(baseUrl: string, model: string): LabEngine {
  const usage: TokenUsage[] = [];
  let schemaBroken = false;

  const post = async (body: unknown, signal?: AbortSignal): Promise<Response> =>
    fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Servers that want a key read it here; llama-server ignores it.
        ...(process.env['OPENAI_API_KEY']
          ? { authorization: `Bearer ${process.env['OPENAI_API_KEY']}` }
          : {}),
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });

  return {
    label: `${model} @ ${baseUrl}`,
    usage,
    complete: async (messages, schemaJson, signal) => {
      const ask = async (withSchema: boolean): Promise<string> => {
        const res = await post(
          {
            model,
            messages,
            temperature: 0.6,
            max_tokens: 128,
            response_format: withSchema
              ? {
                  type: 'json_schema',
                  json_schema: { name: 'advice', schema: JSON.parse(schemaJson) as unknown },
                }
              : { type: 'json_object' },
          },
          signal,
        );
        if (!res.ok) {
          throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`);
        }
        const json = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        if (json.usage) {
          usage.push({
            promptTokens: json.usage.prompt_tokens ?? 0,
            completionTokens: json.usage.completion_tokens ?? 0,
          });
        }
        return json.choices?.[0]?.message?.content ?? '';
      };

      if (schemaBroken) return ask(false);
      try {
        return await ask(true);
      } catch (err) {
        if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
        schemaBroken = true;
        console.warn(
          `[aiLab] schema-constrained generation failed, falling back to plain JSON mode: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        return ask(false);
      }
    },
  };
}
