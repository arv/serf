import { describe, expect, it } from 'vitest';
import { createWorld } from '../sim/world.ts';
import { LlmStrategist, type ChatEngine, type LlmStatus } from './strategist.ts';
import { summarizeForSeat, type AiWorldSummary } from './summary.ts';

/**
 * The strategist run against fake engines — the failure half is the point.
 * A model that answers well is the easy case; what these pin down is that
 * garbage never reaches sendAdvice, a busy seat drops summaries instead of
 * queueing them, and a failing engine takes the strategist down politely
 * after three strikes rather than erroring forever.
 */

function testSummary(): AiWorldSummary {
  const world = createWorld({ seed: 5, players: [{ kind: 'human' }, { kind: 'ai' }] });
  return summarizeForSeat(world, 1);
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
