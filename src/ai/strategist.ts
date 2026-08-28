import { parseAdvice, toOverride, type StrategyAdvice } from './advice.ts';
import { POSTURE_JSON_SCHEMA } from './posture.ts';
import { ensureModelCached, withModelDownloadLock } from './modelDownload.ts';
import { buildMessages, type ChatMessage, CHAT_ROLE_KEYS } from './prompt.ts';
import type { AiWorldSummary, SeatKnobs } from './summary.ts';
import type { AiStrategy } from '../sim/defs/aiStrategies.ts';
import type { Enum } from '../shared/enum.ts';
import * as LlmStateNs from './llmStateEnum.ts';
export * as LlmState from './llmStateEnum.ts';
export type LlmState = Enum<typeof LlmStateNs>;
import * as ConsultOutcomeNs from './consultOutcomeEnum.ts';
export * as ConsultOutcome from './consultOutcomeEnum.ts';
export type ConsultOutcome = Enum<typeof ConsultOutcomeNs>;

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

/**
 * Small enough that CPU prefill stays in seconds, and in llama.cpp's
 * best-supported format. ~230 MB, cached by wllama after the first game.
 *
 * Chosen by the bake-off rather than by reputation. The seat used to run
 * qwen2.5-0.5b, which measured 33.8% as a knob-author — *below* the 46.7%
 * random noise floor, flipping matches away from the advised seat thirteen
 * times against two toward. Asked for a posture instead (see ai/posture.ts),
 * this model scored 63.4% and beat that floor on a paired McNemar
 * (p = 0.0225), the first engine in the harness to clear it at all. It is
 * also 40% smaller and answers in 180ms at the median against qwen's 1538ms,
 * which in a game where the valley keeps moving during inference is the
 * difference between advice about now and advice about a minute ago.
 *
 * What the lab could not measure is wasm: those numbers come from
 * llama-server, so the decisions transfer and the milliseconds do not.
 * wllama's bundled llama.cpp does know the LFM2 architecture — check a
 * first-run download in the browser before trusting a release to it.
 */
export const LLM_MODEL_URL =
  'https://huggingface.co/LiquidAI/LFM2.5-350M-GGUF/resolve/main/LFM2.5-350M-Q4_K_M.gguf';

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
  | { state: LlmStateNs.loading; pct: number; text: string }
  | { state: LlmStateNs.ready }
  | { state: LlmStateNs.failed; reason: string };

/**
 * One consultation, recorded whole for whoever is watching the model work:
 * exactly what it was shown, what it said, how long it chewed, and what the
 * sim was told as a result. Emitted through onTrace for every consultation
 * that settles — a hide-abort is a pause, not model behavior, and leaves no
 * trace. The strategist itself never reads these; main.ts wires them to the
 * dev overlay and the console in dev builds, and to nothing in production.
 */
export interface ConsultTrace {
  playerId: number;
  /** Game-time of the summary that prompted the consultation. */
  minutes: number;
  /** The seat's playbook values at the time — what the advice moved off. */
  knobs: SeatKnobs;
  /** Wall-clock inference time. */
  ms: number;
  /** The prompt, verbatim. */
  messages: ChatMessage[];
  /** The model's reply, verbatim — '' when the engine threw before one. */
  raw: string;
  /** sent = advice went downstairs; kept = the reply parsed but changed
   * nothing (an empty {} or a repeat of standing advice); failed = the
   * engine threw or the reply was unsalvageable. */
  outcome: ConsultOutcome;
  /** This reply alone, clamped — reason included (sent/kept). */
  advice?: StrategyAdvice;
  /** The whole standing pile after merging this reply (sent/kept). */
  standing?: StrategyAdvice;
  /** What actually went to the brain (sent only). */
  override?: Partial<AiStrategy>;
  /** Why the consultation failed (failed only). */
  error?: string;
}

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
  /** Every settled consultation, whole — see ConsultTrace. Production
   * leaves it unset, and pays only a timestamp and a dead closure per
   * consultation — nothing next to the seconds of inference beside them. */
  onTrace?: (trace: ConsultTrace) => void;
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
  /** Aborts a model download still in flight when the match ends — the
   * bytes it already banked stay in the partial store for the next load
   * to resume (modelDownload.ts). */
  readonly #loadAbort = new AbortController();

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
      this.#opts.onStatus({ state: LlmStateNs.ready });
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
    this.#loadAbort.abort();
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
    // Hoisted past the try so the failure trace still carries the prompt
    // and (for a reply that parsed to nothing) the reply itself.
    const startedAt = performance.now();
    const messages = buildMessages(summary, seat.advice, seat.prevSummary);
    let raw = '';
    const trace = (
      t: Omit<ConsultTrace, 'playerId' | 'minutes' | 'knobs' | 'ms' | 'messages' | 'raw'>,
    ) => {
      this.#opts.onTrace?.({
        playerId,
        minutes: summary.minutes,
        knobs: summary.seat.knobs,
        ms: performance.now() - startedAt,
        messages,
        raw,
        ...t,
      });
    };
    try {
      raw = await this.#withTimeout((signal) =>
        this.#engine!.complete(messages, JSON.stringify(POSTURE_JSON_SCHEMA), signal),
      );
      const advice = parseAdvice(raw);
      if (advice === null) throw new Error(`unparseable advice: ${raw.slice(0, 120)}`);
      this.#failures = 0;
      if (this.#disposed) return;
      // Only a reply that actually moved a dial goes downstairs: "keep
      // everything as it is" is a valid answer, and so is repeating the
      // standing advice word for word — neither costs a message.
      seat.advice = { ...seat.advice, ...advice };
      const override = toOverride(seat.advice);
      const key = JSON.stringify(override);
      if (Object.keys(override).length > 0 && key !== seat.sentKey) {
        seat.sentKey = key;
        this.#opts.sendAdvice(playerId, override);
        trace({ outcome: ConsultOutcomeNs.sent, advice, standing: seat.advice, override });
      } else {
        trace({ outcome: ConsultOutcomeNs.kept, advice, standing: seat.advice });
      }
    } catch (err) {
      // A hide aborts the consultation on purpose; only genuine failures
      // count toward giving up — or into the trace ledger.
      if (!this.#currentPaused && !this.#disposed) {
        trace({
          outcome: LlmStateNs.failed,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
    if (!this.#disposed) this.#opts.onStatus({ state: LlmStateNs.failed, reason });
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
    const loading = ({ loaded, total }: { loaded: number; total: number }): void => {
      if (!this.#disposed && total > 0) {
        this.#opts.onStatus({
          state: LlmStateNs.loading,
          pct: Math.round((loaded / total) * 100),
          text: 'downloading model',
        });
      }
    };
    // The bytes first, resumably: an unfinished download from the menu's
    // warm-up — or any earlier session — is picked up where it stopped
    // instead of starting over, and wllama's own wreckage is swept out of
    // the way (see modelDownload.ts). 'unsupported' just means no
    // resumable storage in this browser, and then loadModelFromUrl below
    // downloads for itself exactly as it always did.
    await ensureModelCached(wllama.cacheManager, LLM_MODEL_URL, {
      onProgress: loading,
      signal: this.#loadAbort.signal,
    });
    // ensureModelCached's install step does not watch the signal, so a
    // dispose during it resolves rather than rejects — and the wllama
    // below has already been released. Stop here instead of loading a
    // model into a worker that is gone. (.aborted, not throwIfAborted():
    // the latter is missing from browsers old enough to still reach the
    // native fallback below.)
    if (this.#loadAbort.signal.aborted) throw new Error('match ended during the model load');
    // Under the download lock: on the 'unsupported' path this call is
    // also the download, and a download belongs in the same critical
    // section as every other (modelDownload.ts). On a cache hit the lock
    // is uncontended and costs nothing.
    await withModelDownloadLock(
      () =>
        wllama.loadModelFromUrl(LLM_MODEL_URL, {
          n_ctx: N_CTX,
          n_gpu_layers: GPU_LAYERS,
          progressCallback: loading,
          // A disposed match must stop the fallback fetch too; a cache
          // hit never consults it.
          signal: this.#loadAbort.signal,
        }),
      this.#loadAbort.signal,
    );
    let schemaBroken = false;
    return {
      complete: async (messages, schemaJson, signal) => {
        const ask = (withSchema: boolean) =>
          wllama.createChatCompletion({
            // The words, not the ids: llama.cpp keys the model's chat
            // template on 'system' and 'user'. This is the only place the
            // spelling is needed, and the only place it is spelled.
            messages: messages.map((m) => ({ role: CHAT_ROLE_KEYS[m.role], content: m.content })),
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
 * Warm the model cache from the start menu, so the download runs while the
 * player is still picking opponents instead of through the opening minutes
 * of the match. Pure download — no engine, no CPU, no model memory beyond
 * the fetch. A finished download survives into the match, where the
 * strategist finds the file on disk and skips the network.
 *
 * A launch mid-download no longer starts the fetch over: the bytes the
 * warm-up banked persist between loads, and the match — or tomorrow's
 * menu — resumes where they stop (modelDownload.ts). Only a browser
 * without resumable storage still restarts from zero, through wllama's
 * own downloader, the way every load once did.
 */
export function warmModel(onStatus: (status: LlmStatus) => void): { dispose: () => void } {
  const controller = new AbortController();
  let disposed = false;
  const report = (status: LlmStatus): void => {
    if (!disposed) onStatus(status);
  };
  const progress = ({ loaded, total }: { loaded: number; total: number }): void => {
    if (total > 0) {
      report({
        state: LlmStateNs.loading,
        pct: Math.round((loaded / total) * 100),
        text: 'downloading model',
      });
    }
  };
  void (async () => {
    try {
      const { CacheManager, ModelManager } = await import('@wllama/wllama/esm/index.js');
      const cache = new CacheManager();
      const ensured = await ensureModelCached(cache, LLM_MODEL_URL, {
        signal: controller.signal,
        onProgress: progress,
      });
      if (ensured.status === 'unsupported') {
        // No resumable storage in this browser: wllama's own downloader
        // over the same cache, exactly as before — ensureModelCached has
        // already swept any wreckage out of its way (modelCache.ts), and
        // the download lock keeps a concurrent caller from sweeping this
        // one's half-written file in turn.
        await withModelDownloadLock(
          () =>
            new ModelManager({ cacheManager: cache }).downloadModel(LLM_MODEL_URL, {
              signal: controller.signal,
              progressCallback: progress,
            }),
          controller.signal,
        );
      }
      report({ state: LlmStateNs.ready });
    } catch (err) {
      report({
        state: LlmStateNs.failed,
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

/** The spelling of each outcome, for the dev overlay's row class and label. */
export const CONSULT_OUTCOME_KEYS: Readonly<Record<ConsultOutcome, string>> = {
  [ConsultOutcomeNs.sent]: 'sent',
  [ConsultOutcomeNs.kept]: 'kept',
  [ConsultOutcomeNs.failed]: 'failed',
};
