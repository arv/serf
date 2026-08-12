import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorld } from '../sim/world.ts';
import { AiBrain } from '../sim/systems/ai.ts';
import { strategyOf } from '../sim/defs/aiStrategies.ts';
import { LlmStrategist, warmModel, type ChatEngine, type LlmStatus } from './strategist.ts';
import { summarizeForSeat, type AiWorldSummary } from './summary.ts';

/**
 * The engine-adapter and warmModel tests go through the strategist's real
 * #buildEngine / download paths, so the wllama module is mocked at the
 * boundary: a stand-in Wllama class whose chat behavior each test hangs
 * on `wllamaMock.chat`, and a stand-in ModelManager over an in-memory
 * cache. Tests that inject their own engineFactory never touch this.
 */
type ChatOpts = {
  response_format?: { type?: string };
  abortSignal?: AbortSignal;
};
type ChatReply = { choices: { message: { content: string } }[] };
type Progress = (p: { loaded: number; total: number }) => void;
const wllamaMock = vi.hoisted(() => ({
  /** Every Wllama the adapter constructed, with its exit count. */
  instances: [] as { exited: number }[],
  loadFails: false,
  /** The model's answer; null = tests must not reach inference. */
  chat: null as null | ((opts: ChatOpts) => Promise<ChatReply>),
  /** Model URLs ModelManager reports as already downloaded. */
  cachedUrls: [] as string[],
  downloads: [] as { url: string; signal: AbortSignal | undefined }[],
  /** Override the download itself; null = instant success with progress. */
  downloadGate: null as
    | null
    | ((opts?: { signal?: AbortSignal; progressCallback?: Progress }) => Promise<unknown>),
}));
vi.mock('@wllama/wllama/esm/index.js', () => ({
  LoggerWithoutDebug: {},
  Wllama: class {
    exited = 0;
    constructor() {
      wllamaMock.instances.push(this);
    }
    loadModelFromUrl(_url: string, params?: { progressCallback?: Progress }): Promise<void> {
      if (wllamaMock.loadFails) return Promise.reject(new Error('403 from the weights CDN'));
      params?.progressCallback?.({ loaded: 1, total: 2 });
      return Promise.resolve();
    }
    createChatCompletion(opts: ChatOpts): Promise<ChatReply> {
      if (!wllamaMock.chat) return Promise.reject(new Error('wllamaMock.chat unset'));
      return wllamaMock.chat(opts);
    }
    exit(): Promise<void> {
      this.exited++;
      return Promise.resolve();
    }
  },
  ModelManager: class {
    getModels(): Promise<{ url: string }[]> {
      return Promise.resolve(wllamaMock.cachedUrls.map((url) => ({ url })));
    }
    downloadModel(
      url: string,
      opts?: { signal?: AbortSignal; progressCallback?: Progress },
    ): Promise<unknown> {
      wllamaMock.downloads.push({ url, signal: opts?.signal });
      if (wllamaMock.downloadGate) return wllamaMock.downloadGate(opts);
      opts?.progressCallback?.({ loaded: 1, total: 4 });
      return Promise.resolve({ url });
    }
  },
}));
vi.mock('@wllama/wllama/esm/wasm/wllama.wasm?url', () => ({ default: 'wllama.wasm' }));

/**
 * The strategist run against fake engines — the failure half is the point.
 * A model that answers well is the easy case; what these pin down is that
 * garbage never reaches sendAdvice, a busy seat drops summaries instead of
 * queueing them, and a failing engine takes the strategist down politely
 * after three strikes rather than erroring forever.
 */

function testSummary(): AiWorldSummary {
  const world = createWorld({ seed: 5, players: [{ kind: 'human' }, { kind: 'ai' }] });
  const brain = new AiBrain(1, strategyOf(world.players[1]!.strategy));
  brain.decide(world); // one beat, so vision exists
  return summarizeForSeat(world, brain);
}

interface Harness {
  strategist: LlmStrategist;
  sent: { playerId: number; override: Record<string, unknown> }[];
  statuses: LlmStatus[];
}

function harness(engine: ChatEngine, timeoutMs?: number): Harness {
  const sent: Harness['sent'] = [];
  const statuses: LlmStatus[] = [];
  const strategist = new LlmStrategist({
    sendAdvice: (playerId, override) => sent.push({ playerId, override }),
    onStatus: (s) => statuses.push(s),
    engineFactory: () => Promise.resolve(engine),
    timeoutMs,
  });
  return { strategist, sent, statuses };
}

/** Let the fire-and-forget consultation settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  wllamaMock.instances.length = 0;
  wllamaMock.loadFails = false;
  wllamaMock.chat = null;
  wllamaMock.cachedUrls.length = 0;
  wllamaMock.downloads.length = 0;
  wllamaMock.downloadGate = null;
});

describe('LlmStrategist', () => {
  it('turns a valid reply into clamped advice for the right seat', async () => {
    const { strategist, sent, statuses } = harness({
      complete: async () => '{"armyAttackSize": 99, "reason": "overwhelm them"}',
    });
    await strategist.start();
    expect(statuses).toEqual([{ state: 'ready' }]);
    strategist.onSummary(1, testSummary());
    await settle();
    // Clamped to the published range, reason kept out of the override.
    expect(sent).toEqual([{ playerId: 1, override: { armyAttackSize: 16 } }]);
  });

  it('accumulates advice across consultations, newest knob over oldest', async () => {
    let call = 0;
    const replies = ['{"armyAttackSize": 12}', '{"homeGuard": 8, "armyAttackSize": 10}'];
    const { strategist, sent } = harness({ complete: async () => replies[call++]! });
    await strategist.start();
    strategist.onSummary(1, testSummary());
    await settle();
    strategist.onSummary(1, testSummary());
    await settle();
    expect(sent[1]).toEqual({ playerId: 1, override: { armyAttackSize: 10, homeGuard: 8 } });
  });

  it('sends nothing for garbage, and nothing for "change nothing"', async () => {
    let call = 0;
    const replies = ['the peasants are revolting', '{}'];
    const { strategist, sent, statuses } = harness({ complete: async () => replies[call++]! });
    await strategist.start();
    strategist.onSummary(1, testSummary());
    await settle();
    strategist.onSummary(1, testSummary());
    await settle();
    expect(sent).toEqual([]);
    // Garbage counted a strike, but one strike is not out.
    expect(statuses).toEqual([{ state: 'ready' }]);
  });

  it('drops a summary while the seat is still being thought about', async () => {
    let resolveFirst!: (v: string) => void;
    let calls = 0;
    const { strategist, sent } = harness({
      complete: () => {
        calls++;
        return new Promise((r) => {
          resolveFirst = r;
        });
      },
    });
    await strategist.start();
    strategist.onSummary(1, testSummary());
    strategist.onSummary(1, testSummary()); // engine still thinking: dropped
    expect(calls).toBe(1);
    resolveFirst('{"homeGuard": 4}');
    await settle();
    expect(sent).toHaveLength(1);
    // The seat is free again afterwards.
    strategist.onSummary(1, testSummary());
    expect(calls).toBe(2);
  });

  it('goes permanently inert after three straight failures', async () => {
    let calls = 0;
    const { strategist, sent, statuses } = harness({
      complete: () => {
        calls++;
        return Promise.reject(new Error('out of VRAM'));
      },
    });
    await strategist.start();
    for (let i = 0; i < 5; i++) {
      strategist.onSummary(1, testSummary());
      await settle();
    }
    expect(calls).toBe(3);
    expect(sent).toEqual([]);
    const last = statuses.at(-1)!;
    expect(last.state).toBe('failed');
    expect((last as { reason: string }).reason).toContain('out of VRAM');
  });

  it('counts a hung engine as a failure instead of waiting forever', async () => {
    const { strategist, statuses } = harness({ complete: () => new Promise(() => {}) }, 5);
    await strategist.start();
    for (let i = 0; i < 3; i++) {
      strategist.onSummary(1, testSummary());
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(statuses.at(-1)!.state).toBe('failed');
  });

  it('a hide aborts the consultation mid-thought, and it never counts as a strike', async () => {
    let calls = 0;
    const { strategist, sent, statuses } = harness({
      complete: (_messages, _schema, signal) =>
        new Promise((_resolve, reject) => {
          calls++;
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    await strategist.start();
    // Three hide-aborts in a row — the giving-up threshold, were they
    // counted. Unhiding again *before* each rejection lands is the trap:
    // the catch must remember the abort was a pause, not read the current
    // visibility.
    for (let i = 0; i < 3; i++) {
      strategist.onSummary(1, testSummary());
      expect(calls).toBe(i + 1);
      strategist.setHidden(true);
      strategist.setHidden(false);
      await settle();
    }
    expect(sent).toEqual([]);
    expect(statuses).toEqual([{ state: 'ready' }]); // never 'failed'
  });

  it('consults nobody while hidden, and picks up again on return', async () => {
    let calls = 0;
    const { strategist } = harness({
      complete: async () => {
        calls++;
        return '{}';
      },
    });
    await strategist.start();
    strategist.setHidden(true);
    strategist.onSummary(1, testSummary());
    await settle();
    expect(calls).toBe(0);
    strategist.setHidden(false);
    strategist.onSummary(1, testSummary());
    await settle();
    expect(calls).toBe(1);
  });

  it('a load that fails reports and stays inert', async () => {
    const sent: unknown[] = [];
    const statuses: LlmStatus[] = [];
    const strategist = new LlmStrategist({
      sendAdvice: (p, o) => sent.push([p, o]),
      onStatus: (s) => statuses.push(s),
      engineFactory: () => Promise.reject(new Error('no adapter')),
    });
    await strategist.start();
    expect(statuses.at(-1)).toMatchObject({ state: 'failed' });
    strategist.onSummary(1, testSummary());
    await settle();
    expect(sent).toEqual([]);
  });

  it('a permanent failure frees the model and its worker', async () => {
    wllamaMock.chat = () => Promise.reject(new Error('inference exploded'));
    const statuses: LlmStatus[] = [];
    // No engineFactory: this runs the real wllama adapter over the mocks.
    const strategist = new LlmStrategist({
      sendAdvice: () => {},
      onStatus: (s) => statuses.push(s),
    });
    await strategist.start();
    expect(wllamaMock.instances).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      strategist.onSummary(1, testSummary());
      await settle();
    }
    expect(statuses.at(-1)!.state).toBe('failed');
    // Inert must not keep the model — and its memory — alive.
    expect(wllamaMock.instances[0]!.exited).toBe(1);
  });

  it('one consultation at a time, across every seat', async () => {
    let resolveReply!: (v: string) => void;
    let calls = 0;
    const { strategist, sent } = harness({
      complete: () => {
        calls++;
        return new Promise((r) => {
          resolveReply = r;
        });
      },
    });
    await strategist.start();
    strategist.onSummary(1, testSummary());
    strategist.onSummary(2, testSummary()); // another SEAT: still dropped
    expect(calls).toBe(1);
    resolveReply('{"homeGuard": 4}');
    await settle();
    expect(sent).toHaveLength(1);
    strategist.onSummary(2, testSummary()); // free again afterwards
    expect(calls).toBe(2);
  });

  it('falls back to plain JSON mode when the schema breaks the engine', async () => {
    const formats: (string | undefined)[] = [];
    wllamaMock.chat = (opts) => {
      formats.push(opts.response_format?.type);
      if (opts.response_format?.type === 'json_schema') {
        return Promise.reject(new Error('grammar failed to compile'));
      }
      return Promise.resolve({ choices: [{ message: { content: '{"homeGuard": 6}' } }] });
    };
    const sent: unknown[] = [];
    const strategist = new LlmStrategist({
      sendAdvice: (p, o) => sent.push([p, o]),
      onStatus: () => {},
    });
    await strategist.start();
    strategist.onSummary(1, testSummary());
    await settle();
    // The constrained attempt failed, the plain retry answered — one piece
    // of advice, no strike toward inert.
    expect(sent).toEqual([[1, { homeGuard: 6 }]]);
    // A broken schema stays broken: the next consultation skips it.
    strategist.onSummary(1, testSummary());
    await settle();
    expect(formats).toEqual(['json_schema', 'json_object', 'json_object']);
  });

  it('a load that fails through the real adapter reports and frees the model', async () => {
    wllamaMock.loadFails = true;
    const statuses: LlmStatus[] = [];
    const strategist = new LlmStrategist({ sendAdvice: () => {}, onStatus: (s) => statuses.push(s) });
    await strategist.start();
    expect(statuses.at(-1)).toMatchObject({ state: 'failed' });
    expect((statuses.at(-1) as { reason: string }).reason).toContain('403');
    expect(wllamaMock.instances[0]!.exited).toBe(1);
  });

  it('disposed mid-flight, it stops speaking', async () => {
    let resolveReply!: (v: string) => void;
    const { strategist, sent } = harness({
      complete: () =>
        new Promise((r) => {
          resolveReply = r;
        }),
    });
    await strategist.start();
    strategist.onSummary(1, testSummary());
    strategist.dispose();
    resolveReply('{"homeGuard": 4}');
    await settle();
    expect(sent).toEqual([]);
  });
});

/**
 * warmModel: the start menu's prefetch. Pure download through wllama's
 * ModelManager — what matters is that the cache fast-path fetches nothing,
 * a cold download reports progress and lands ready without ever building
 * an engine, and dispose (toggle off, menu unmount) aborts the fetch and
 * silences the status stream.
 */
describe('warmModel', () => {
  it('an already-cached model reports ready without downloading', async () => {
    const { LLM_MODEL_URL } = await import('./strategist.ts');
    wllamaMock.cachedUrls.push(LLM_MODEL_URL);
    const statuses: LlmStatus[] = [];
    warmModel((s) => statuses.push(s));
    await settle();
    expect(statuses).toEqual([{ state: 'ready' }]);
    expect(wllamaMock.downloads).toHaveLength(0);
  });

  it('a cold cache downloads with progress, and never builds an engine', async () => {
    const statuses: LlmStatus[] = [];
    warmModel((s) => statuses.push(s));
    await settle();
    expect(statuses[0]).toMatchObject({ state: 'loading', pct: 25 });
    expect(statuses.at(-1)).toEqual({ state: 'ready' });
    expect(wllamaMock.downloads).toHaveLength(1);
    // Download only — the menu spends no CPU and holds no model memory.
    expect(wllamaMock.instances).toHaveLength(0);
  });

  it('a failed download reports why', async () => {
    wllamaMock.downloadGate = () => Promise.reject(new Error('403 from the weights CDN'));
    const statuses: LlmStatus[] = [];
    warmModel((s) => statuses.push(s));
    await settle();
    expect(statuses.at(-1)).toMatchObject({ state: 'failed' });
    expect((statuses.at(-1) as { reason: string }).reason).toContain('403');
  });

  it('disposed mid-download, it aborts the fetch and goes silent', async () => {
    let report: Progress | undefined;
    wllamaMock.downloadGate = (opts) =>
      new Promise((_resolve, reject) => {
        report = opts?.progressCallback;
        opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const statuses: LlmStatus[] = [];
    const handle = warmModel((s) => statuses.push(s));
    await settle();
    expect(wllamaMock.downloads).toHaveLength(1);
    handle.dispose();
    await settle();
    expect(wllamaMock.downloads[0]!.signal?.aborted).toBe(true);
    const seen = statuses.length;
    report?.({ loaded: 3, total: 4 });
    await settle();
    // The abort's rejection and the late progress both land after dispose:
    // neither reaches the menu.
    expect(statuses).toHaveLength(seen);
    expect(statuses.every((s) => s.state !== 'failed')).toBe(true);
  });
});
