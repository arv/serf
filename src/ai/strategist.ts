import { ADVICE_JSON_SCHEMA, parseAdvice, toOverride, type StrategyAdvice } from './advice.ts';
import { buildMessages, type ChatMessage } from './prompt.ts';
import type { AiWorldSummary } from './summary.ts';
import type { AiStrategy } from '../sim/defs/aiStrategies.ts';

/**
 * The LLM strategist: the main-thread controller that turns seat summaries
 * from the sim worker into playbook advice, by way of a small language
 * model running in its own worker (llmWorker.ts).
 *
 * Built to lose gracefully, because everything about it is best-effort:
 * the model is a ~600 MB download that may never finish, WebGPU may be
 * missing, inference takes seconds and may return nonsense. So the brain
 * never waits — it plays its playbook until advice lands — and any failure
 * just means the advice stops coming. Three strikes and the strategist
 * goes permanently inert for the match, telling the UI why.
 *
 * Advice accumulates per seat: the model is told to reply only with the
 * knobs it wants changed, so each reply merges over the last and the whole
 * pile is what rides down to the brain.
 *
 * Nothing here persists. A reloaded save plays the printed playbook until
 * the next consultation (~45 s) — documented, accepted.
 */

/** ~1 GB of VRAM, quick answers, and in WebLLM's prebuilt list. */
export const LLM_MODEL_ID = 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC';

/** An inference reply that takes this long is a machine that cannot run
 * the model usefully; counted as a failure rather than waited out. */
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;

export function webgpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

/** The one seam the engine is used through — tests inject a fake and the
 * whole strategist runs without WebLLM, WebGPU, or a worker. */
export interface ChatEngine {
  complete(messages: ChatMessage[], schemaJson: string): Promise<string>;
}

export type LlmStatus =
  | { state: 'loading'; pct: number; text: string }
  | { state: 'ready' }
  | { state: 'failed'; reason: string };

interface SeatMemory {
  busy: boolean;
  /** Every knob changed so far, newest over oldest. */
  advice: StrategyAdvice | null;
  /** The override as last posted, stringified — a model that repeats its
   * standing advice every consultation should not repeat the message. */
  sentKey: string | null;
  prevSummary: AiWorldSummary | null;
}

export interface LlmStrategistOpts {
  /** Validated, clamped advice for one seat — wire to SimHost.sendAiAdvice. */
  sendAdvice: (playerId: number, override: Partial<AiStrategy>) => void;
  onStatus: (status: LlmStatus) => void;
  /** Test injection; the default builds the real WebLLM worker engine. */
  engineFactory?: () => Promise<ChatEngine>;
  timeoutMs?: number;
}

export class LlmStrategist {
  #opts: LlmStrategistOpts;
  #engine: ChatEngine | null = null;
  #worker: Worker | null = null;
  #seats = new Map<number, SeatMemory>();
  #failures = 0;
  #dead = false;
  #disposed = false;

  constructor(opts: LlmStrategistOpts) {
    this.#opts = opts;
  }

  /** Load the model. Resolves when consultations can begin; a load that
   * fails leaves the strategist inert and the status saying why. */
  async start(): Promise<void> {
    try {
      const engine = await (this.#opts.engineFactory ?? (() => this.#buildEngine()))();
      if (this.#disposed) return;
      this.#engine = engine;
      this.#opts.onStatus({ state: 'ready' });
    } catch (err) {
      this.#fail(`model failed to load: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** A seat's summary arrived from the sim worker. Fire-and-forget: if the
   * engine is missing, dead, or already thinking about this seat, the
   * summary is simply dropped — another comes along in ~45 s. */
  onSummary(playerId: number, summary: AiWorldSummary): void {
    if (!this.#engine || this.#dead || this.#disposed) return;
    let seat = this.#seats.get(playerId);
    if (!seat) {
      seat = { busy: false, advice: null, sentKey: null, prevSummary: null };
      this.#seats.set(playerId, seat);
    }
    if (seat.busy) return;
    seat.busy = true;
    void this.#consult(playerId, seat, summary);
  }

  dispose(): void {
    this.#disposed = true;
    this.#engine = null;
    this.#worker?.terminate();
    this.#worker = null;
  }

  async #consult(playerId: number, seat: SeatMemory, summary: AiWorldSummary): Promise<void> {
    try {
      const messages = buildMessages(summary, seat.advice, seat.prevSummary);
      const raw = await this.#withTimeout(
        this.#engine!.complete(messages, JSON.stringify(ADVICE_JSON_SCHEMA)),
      );
      const advice = parseAdvice(raw);
      if (advice === null) throw new Error(`unparseable advice: ${raw.slice(0, 120)}`);
      this.#failures = 0;
      if (this.#disposed) return;
      if (import.meta.env.DEV) {
        console.log(`[strategist] seat ${playerId} advises`, advice);
      }
      // Only a reply that actually moved a dial goes downstairs: "keep
      // everything as it is" is a valid answer, and so is repeating the
      // standing advice word for word — neither costs a message.
      seat.advice = { ...seat.advice, ...advice };
      const override = toOverride(seat.advice);
      const key = JSON.stringify(override);
      if (Object.keys(override).length > 0 && key !== seat.sentKey) {
        seat.sentKey = key;
        this.#opts.sendAdvice(playerId, override);
      }
    } catch (err) {
      if (++this.#failures >= MAX_CONSECUTIVE_FAILURES && !this.#dead) {
        this.#fail(
          `giving up after ${MAX_CONSECUTIVE_FAILURES} failed consultations ` +
            `(${err instanceof Error ? err.message : String(err)})`,
        );
      }
    } finally {
      seat.busy = false;
      seat.prevSummary = summary;
    }
  }

  #withTimeout(work: Promise<string>): Promise<string> {
    const ms = this.#opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`inference timed out (${ms}ms)`)), ms);
      work.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }

  #fail(reason: string): void {
    this.#dead = true;
    this.#engine = null;
    // Inert is inert: a strategist that gave up must not keep a worker —
    // and the model's VRAM — alive for the rest of the match.
    this.#worker?.terminate();
    this.#worker = null;
    if (!this.#disposed) this.#opts.onStatus({ state: 'failed', reason });
  }

  /** The real thing: WebLLM in its own worker, engine package loaded only
   * now — no LLM opponent, no megabytes of inference glue. */
  async #buildEngine(): Promise<ChatEngine> {
    const webllm = await import('@mlc-ai/web-llm');
    this.#worker = new Worker(new URL('./llmWorker.ts', import.meta.url), { type: 'module' });
    const engine = await webllm.CreateWebWorkerMLCEngine(this.#worker, LLM_MODEL_ID, {
      initProgressCallback: (report) => {
        if (!this.#disposed) {
          this.#opts.onStatus({
            state: 'loading',
            pct: Math.round(report.progress * 100),
            text: report.text,
          });
        }
      },
    });
    // Schema-constrained JSON (xgrammar) is supported by the engine, but
    // whether a given model + schema actually compiles is a runtime
    // question. If it breaks, plain json_object mode is nearly as good —
    // parseAdvice treats every reply as hostile regardless — and far
    // better than three constrained failures making the strategist inert.
    let schemaBroken = false;
    return {
      complete: async (messages, schemaJson) => {
        const ask = (withSchema: boolean) =>
          engine.chat.completions.create({
            messages,
            temperature: 0.6,
            max_tokens: 192,
            response_format: withSchema
              ? { type: 'json_object', schema: schemaJson }
              : { type: 'json_object' },
          });
        let reply;
        if (schemaBroken) {
          reply = await ask(false);
        } else {
          try {
            reply = await ask(true);
          } catch (err) {
            schemaBroken = true;
            console.warn(
              `[strategist] schema-constrained generation failed, ` +
                `falling back to plain JSON mode: ${err instanceof Error ? err.message : String(err)}`,
            );
            reply = await ask(false);
          }
        }
        return reply.choices[0]?.message.content ?? '';
      },
    };
  }
}
