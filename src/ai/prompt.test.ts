import { describe, expect, it } from 'vitest';
import { createWorld } from '../sim/world.ts';
import { buildMessages } from './prompt.ts';
import { summarizeForSeat, type AiWorldSummary } from './summary.ts';

/**
 * The prompt is judged on the two things that matter to a small model:
 * everything the strategist needs is in it, and there is not much else.
 * Wording is free to change; these tests pin the contract, not the prose.
 */

function summaries(): { first: AiWorldSummary; later: AiWorldSummary } {
  const world = createWorld({ seed: 5, players: [{ kind: 'human' }, { kind: 'ai' }] });
  const first = summarizeForSeat(world, 1);
  const later = { ...first, minutes: first.minutes + 2, tick: first.tick + 2400 };
  return { first, later };
}

describe('buildMessages', () => {
  it('is one system briefing and one user report', () => {
    const { first } = summaries();
    const messages = buildMessages(first, null, null);
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    // The glossary names every knob the parser accepts.
    for (const knob of [
      'serfTarget',
      'armyAttackSize',
      'attackCooldown',
      'homeGuard',
      'prefersRivals',
      'trainPreference',
      'weaponMix',
      'barracksQueueDepth',
      'houseLimit',
      'housingHeadroom',
      'researchReserve',
    ]) {
      expect(messages[0]!.content).toContain(knob);
    }
    // And the report carries the whole summary, not a paraphrase of it.
    expect(messages[1]!.content).toContain(JSON.stringify(first));
    expect(messages[1]!.content).toContain('first consultation');
  });

  it('tells the model what it already changed, so it does not re-change it', () => {
    const { first, later } = summaries();
    const advice = { armyAttackSize: 12, reason: 'they mass knights' };
    const withAdvice = buildMessages(later, advice, first);
    expect(withAdvice[1]!.content).toContain('"armyAttackSize":12');
    const without = buildMessages(later, null, first);
    expect(without[1]!.content).toContain('printed values');
  });

  it('carries the deltas since the previous consultation', () => {
    const { first, later } = summaries();
    const content = buildMessages(later, null, first)[1]!.content;
    expect(content).toContain('Since last consultation (2 min ago)');
    expect(content).toContain('rival');
  });

  it('holds the token budget: the whole prompt stays small', () => {
    const { first, later } = summaries();
    const total = buildMessages(later, { armyAttackSize: 12 }, first)
      .map((m) => m.content)
      .join('').length;
    // ~4 chars per token: 4000 chars keeps the prompt near the 800-token
    // budget the module header promises.
    expect(total).toBeLessThan(4000);
  });
});
