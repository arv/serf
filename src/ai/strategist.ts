import { ADVICE_JSON_SCHEMA, parseAdvice, toOverride, type StrategyAdvice } from './advice.ts';
import { discardPartialModel, type ModelCache } from './modelCache.ts';
import { buildMessages, type ChatMessage } from './prompt.ts';
import type { AiWorldSummary } from './summary.ts';
import type { AiStrategy } from '../sim/defs/aiStrategies.ts';

/**
 * The LLM strategist: the main-thread controller that turns seat summaries
 * from the sim worker into playbook advice, by way of a small language
 * model running on the CPU (llama.cpp via wllama, whose compute lives in
 * its own worker with wasm threads).
 *
 * CPU on purpose. The first cut ran WebGPU inference, and the game froze
 * on every consultation: the model and the renderer shared one GPU, and a
 * prompt's prefill starved WebGL of the frames the valley is drawn with.
 * A CPU model is slower to answer — tens of seconds instead of a few —
 * but the strategist is fire-and-forget on a slow cadence, so nobody is
 * waiting; what matters is that thinking never costs a frame. The wasm
 * threads wllama wants come free here: the app already ships
 * cross-origin isolation for its SharedArrayBuffer hot path.
 *
 * CPU takes saying so: wllama defaults n_gpu_layers to 99999, so wherever
 * WebGPU exists it quietly puts the whole model back on the GPU — weight
 * upload wedges the compositor for a second, and every consultation after
 * that drops frames exactly like the WebLLM cut did. GPU_LAYERS pins it.
 *
 * Built to lose gracefully, because everything about it is best-effort:
 * the model is a ~400 MB download that may never finish, inference may
 * time out or return nonsense. So the brain never waits — it plays its
 * playbook until advice lands — and any failure just means the advice
 * stops coming. Three strikes and the strategist goes permanently inert
 * for the match, telling the UI why.
 *
 * Advice accumulates per seat: the model is told to reply only with the
 * knobs it wants changed, so each reply merges over the last and the whole
 * pile is what rides down to the brain. One consultation runs at a time
 * ACROSS seats — a second model chewing in parallel would double the CPU
 * bill for advice that can wait a beat.
 *
 * Nothing here persists. A reloaded save plays the printed playbook until
 * the next consultation — documented, accepted.
 */

/** Small enough that CPU prefill stays in seconds, and in llama.cpp's
 * best-supported format. ~400 MB, cached by wllama after the first game. */
export const LLM_MODEL_URL =
  'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf';

/** CPU inference is slow but must not be unbounded: a consultation that
 * cannot finish inside this is a machine too weak to advise on. */
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;
/** Short replies: a handful of JSON knobs, decoded on a CPU. */
const MAX_TOKENS = 128;
/** Room for the ~900-token prompt and the reply, nothing more — context
 * is memory, and llama.cpp allocates it up front. */
const N_CTX = 2048;
/** Zero, always: the GPU belongs to the renderer (see the header). Left
 * unset, wllama offloads every layer to WebGPU when the browser has it. */
export const GPU_LAYERS = 0;

/** Wasm threads want SharedArrayBuffer, which the app's cross-origin
 * isolation already guarantees everywhere it boots at all. */
export function llmSupported(): boolean {
  return typeof SharedArrayBuffer !== 'undefined';
}

/** The one seam the engine is used through — tests inject a fake and the
 * whole strategist runs without wllama or a model. */
export interface ChatEngine {
  complete(messages: ChatMessage[], schemaJson: string, signal?: AbortSignal): Promise<string>;
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
  /** Test injection; the default builds the real wllama engine. */
  engineFactory?: () => Promise<ChatEngine>;
  timeoutMs?: number;
}

export class LlmStrategist {
  #opts: LlmStrategistOpts;
  #engine: ChatEngine | null = null;
  /** The live wllama instance, for freeing its worker and model memory. */
  #wllama: { exit(): Promise<void> } | null = null;
  #seats = new Map<number, SeatMemory>();
  #failures = 0;
  /** One consultation at a time across every seat — the load-shedding. */
  #thinking = false;
  #dead = false;
  #disposed = false;
  /** Page hidden: no consultations. The sim freezes alongside, so no new
   * summaries arrive anyway — this exists to stop the one already chewing. */
  #hidden = false;
  /** The in-flight consultation's abort, so hiding can stop the CPU now
   * rather than a minute of inference later. */
  #current: AbortController | null = null;
  /** Set when #current was aborted by a hide, cleared as the consultation
   * settles. The catch reads this, not #hidden: the page may already be
   * visible again by the time the abort's rejection lands, and the flag is
   * what keeps that late rejection from counting as a model failure. */
  #currentPaused = false;

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
   * engine is missing, dead, or a consultation is already running — this
   * seat's or anyone's — the summary is simply dropped; another comes
   * along on the next cadence. */
  onSummary(playerId: number, summary: AiWorldSummary): void {
    if (!this.#engine || this.#dead || this.#disposed || this.#thinking || this.#hidden) return;
    let seat = this.#seats.get(playerId);
    if (!seat) {
      seat = { busy: false, advice: null, sentKey: null, prevSummary: null };
      this.#seats.set(playerId, seat);
    }
    if (seat.busy) return;
    seat.busy = true;
    this.#thinking = true;
    void this.#consult(playerId, seat, summary);
  }

  dispose(): void {
    this.#disposed = true;
    this.#engine = null;
    this.#releaseWllama();
  }

  /** Backgrounded: a phone in a pocket must not spend a minute of CPU on
   * advice, so the running consultation is aborted mid-thought and dropped
   * — a pause, not a strike against the model (see #consult's catch). The
   * next summary after the page returns starts a fresh one. */
  setHidden(hidden: boolean): void {
    this.#hidden = hidden;
    if (hidden && this.#current) {
      this.#currentPaused = true;
      this.#current.abort();
    }
  }

  async #consult(playerId: number, seat: SeatMemory, summary: AiWorldSummary): Promise<void> {
    try {
      const messages = buildMessages(summary, seat.advice, seat.prevSummary);
      const raw = await this.#withTimeout((signal) =>
        this.#engine!.complete(messages, JSON.stringify(ADVICE_JSON_SCHEMA), signal),
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
      // A hide aborts the consultation on purpose; only genuine failures
      // count toward giving up.
      if (!this.#currentPaused && ++this.#failures >= MAX_CONSECUTIVE_FAILURES && !this.#dead) {
        this.#fail(
          `giving up after ${MAX_CONSECUTIVE_FAILURES} failed consultations ` +
            `(${err instanceof Error ? err.message : String(err)})`,
        );
      }
    } finally {
      seat.busy = false;
      this.#thinking = false;
      this.#current = null;
      this.#currentPaused = false;
      seat.prevSummary = summary;
    }
  }

  /** Run one consultation under the clock. The signal reaches the engine
   * so a timeout actually stops the model chewing — an abandoned CPU
   * inference would otherwise keep burning cores for nobody. */
  #withTimeout(work: (signal: AbortSignal) => Promise<string>): Promise<string> {
    const ms = this.#opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    this.#current = controller;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`inference timed out (${ms}ms)`));
      }, ms);
      work(controller.signal).then(
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
    // Inert is inert: a strategist that gave up must not keep the model —
    // and its memory and worker — alive for the rest of the match.
    this.#releaseWllama();
    if (!this.#disposed) this.#opts.onStatus({ state: 'failed', reason });
  }

  #releaseWllama(): void {
    const wllama = this.#wllama;
    this.#wllama = null;
    if (wllama) void wllama.exit().catch(() => {});
  }

  /** The real thing: wllama loaded only now — no LLM opponent, none of
   * its code or wasm either. The engine keeps the schema constraint as
   * long as it compiles; a model+schema pair that fails at runtime falls
   * back to plain JSON mode, where parseAdvice was the real gate anyway. */
  async #buildEngine(): Promise<ChatEngine> {
    // The built entry, not the package root: the package also ships its
    // .ts sources, which the root specifier resolves to — dragging their
    // code into this project's (stricter) typecheck.
    const [{ Wllama, LoggerWithoutDebug }, wasm] = await Promise.all([
      import('@wllama/wllama/esm/index.js'),
      import('@wllama/wllama/esm/wasm/wllama.wasm?url'),
    ]);
    const wllama = new Wllama(
      { default: wasm.default },
      { logger: LoggerWithoutDebug, allowOffline: true },
    );
    this.#wllama = wllama;
    // Before the load, not after a failure: a half-written GGUF from an
    // earlier session is a permanent "Model file not found" otherwise —
    // and the menu's aborted warm-up is the likeliest way to have one.
    await sweepPartialModel(wllama.cacheManager);
    await wllama.loadModelFromUrl(LLM_MODEL_URL, {
      n_ctx: N_CTX,
      n_gpu_layers: GPU_LAYERS,
      progressCallback: ({ loaded, total }) => {
        if (!this.#disposed && total > 0) {
          this.#opts.onStatus({
            state: 'loading',
            pct: Math.round((loaded / total) * 100),
            text: 'downloading model',
          });
        }
      },
    });
    let schemaBroken = false;
    return {
      complete: async (messages, schemaJson, signal) => {
        const ask = (withSchema: boolean) =>
          wllama.createChatCompletion({
            messages,
            temperature: 0.6,
            max_tokens: MAX_TOKENS,
            abortSignal: signal,
            response_format: withSchema
              ? {
                  type: 'json_schema',
                  json_schema: { name: 'advice', schema: JSON.parse(schemaJson) as unknown },
                }
              : { type: 'json_object' },
          });
        let reply;
        if (schemaBroken) {
          reply = await ask(false);
        } else {
          try {
            reply = await ask(true);
          } catch (err) {
            if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
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

/**
 * A partial download is worse than none — see modelCache.ts. Best-effort:
 * a cache that cannot even be listed is not a reason to skip the attempt,
 * since the download is what the player is waiting for.
 */
async function sweepPartialModel(cache: ModelCache): Promise<void> {
  try {
    const discarded = await discardPartialModel(cache, LLM_MODEL_URL);
    if (discarded > 0) {
      console.warn('[strategist] discarded an unfinished model download; fetching it again');
    }
  } catch (err) {
    console.warn(`[strategist] could not check the model cache: ${String(err)}`);
  }
}

/**
 * Warm the model cache from the start menu, so the download runs while the
 * player is still picking opponents instead of through the opening minutes
 * of the match. Pure download — wllama's ModelManager writes the GGUF into
 * cache storage without loading a byte of it, so the menu spends no CPU
 * and no memory beyond the fetch. A finished download survives into the
 * match, where the strategist finds the file on disk and skips the network.
 *
 * A launch mid-download does NOT resume: wllama has no notion of a partial
 * file, so the match starts the fetch over — and the leftover bytes are
 * swept first, because left in place they would poison every later attempt
 * (modelCache.ts).
 */
export function warmModel(onStatus: (status: LlmStatus) => void): { dispose: () => void } {
  const controller = new AbortController();
  let disposed = false;
  const report = (status: LlmStatus): void => {
    if (!disposed) onStatus(status);
  };
  void (async () => {
    try {
      const { ModelManager } = await import('@wllama/wllama/esm/index.js');
      const manager = new ModelManager();
      const models = await manager.getModels();
      if (models.some((m) => m.url === LLM_MODEL_URL)) {
        report({ state: 'ready' });
        return;
      }
      if (disposed) return;
      // getModels only lists whole models, so reaching here means either a
      // clean cache or the wreckage of an earlier attempt. Clear the second
      // out before asking for the file, or wllama mistakes it for a hit.
      await sweepPartialModel(manager.cacheManager);
      if (disposed) return;
      await manager.downloadModel(LLM_MODEL_URL, {
        signal: controller.signal,
        progressCallback: ({ loaded, total }) => {
          if (total > 0) {
            report({
              state: 'loading',
              pct: Math.round((loaded / total) * 100),
              text: 'downloading model',
            });
          }
        },
      });
      report({ state: 'ready' });
    } catch (err) {
      report({
        state: 'failed',
        reason: `model failed to download: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  })();
  return {
    dispose: (): void => {
      disposed = true;
      controller.abort();
    },
  };
}
