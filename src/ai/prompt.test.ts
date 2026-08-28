import { describe, expect, it } from 'vitest';
import { createWorld } from '../sim/world.ts';
import { AiBrain } from '../sim/systems/ai.ts';
import { strategyOf } from '../sim/defs/aiStrategies.ts';
import { buildMessages, extractSummary } from './prompt.ts';
import { POSTURES, POSTURE_ORDER, postureAdvice, PostureId, POSTURE_KEYS } from './posture.ts';
import { toOverride } from './advice.ts';
import { summarizeForSeat, type AiWorldSummary } from './summary.ts';
import { PlayerKind } from '../sim/player.ts';

/**
 * The prompt is judged on the two things that matter to a small model:
 * everything the strategist needs is in it, and there is not much else.
 * Wording is free to change; these tests pin the contract, not the prose.
 */

function summaries(): { first: AiWorldSummary; later: AiWorldSummary } {
  const world = createWorld({
    seed: 5,
    players: [{ kind: PlayerKind.human }, { kind: PlayerKind.ai }],
  });
  const brain = new AiBrain(1, strategyOf(world.players[1]!.strategy), world.map.size);
  brain.decide(world); // one beat, so vision exists
  const first = summarizeForSeat(world, brain);
  // Two minutes on, the scout has found the rival and taken a first look.
  const later: AiWorldSummary = {
    ...first,
    minutes: first.minutes + 2,
    tick: first.tick + 2400,
    rivals: [
      {
        ...first.rivals[0]!,
        found: true,
        distance: 30,
        intel: { ageTicks: 200, heavy: 2, light: 1, ranged: 0, total: 3, peak: 4 },
      },
    ],
  };
  return { first, later };
}

describe('buildMessages', () => {
  it('is one system briefing and one user report', () => {
    const { first } = summaries();
    const messages = buildMessages(first, null, null);
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    // The menu names every stance the parser will accept, and each one
    // comes with the situation to pick it under — the model is matching a
    // valley to a label, so a bare list of names would not be the ask.
    for (const id of POSTURE_ORDER) {
      expect(messages[0]!.content).toContain(POSTURE_KEYS[id]);
      expect(messages[0]!.content).toContain(POSTURES[id].when);
    }
    // Knob values are the table's business, not the model's: quoting them
    // is what turned a 350M model into an echo of its own prompt.
    expect(messages[0]!.content).not.toContain('serfTarget');
    expect(messages[0]!.content).not.toContain('barracksQueueDepth');
    // And it teaches the fog: found rivals, intel age, scouting handled.
    expect(messages[0]!.content).toContain('Fog of war');
    expect(messages[0]!.content).toContain('found=false');
    expect(messages[0]!.content).toContain('intel');
    // The report carries the whole summary, not a paraphrase of it.
    expect(messages[1]!.content).toContain(JSON.stringify(first));
    expect(messages[1]!.content).toContain('first consultation');
  });

  it('names the standing posture without quoting the numbers under it', () => {
    const { first, later } = summaries();
    const advice = {
      ...postureAdvice(PostureId.siege),
      posture: PostureId.siege,
      reason: 'castle found',
    };
    const withAdvice = buildMessages(later, advice, first);
    expect(withAdvice[1]!.content).toContain('standing posture is "siege"');
    // The stance's knob blob must not ride along: see the note in
    // buildMessages, and the sweep that motivated it. Asserted against the
    // serialized override rather than any single value, because the
    // summary legitimately reports the seat's own playbook knobs and those
    // numbers can coincide with a posture's.
    expect(withAdvice[1]!.content).not.toContain(JSON.stringify(toOverride(advice)));
    const without = buildMessages(later, null, first);
    expect(without[1]!.content).toContain('printed values');
  });

  it('hands the summary back to engines that reason over state', () => {
    const { first, later } = summaries();
    expect(extractSummary(buildMessages(later, null, first))).toEqual(later);
    expect(extractSummary([{ role: 'user', content: 'no json here' }])).toBeNull();
    expect(extractSummary([])).toBeNull();
  });

  it('calls out what scouting turned up since the previous consultation', () => {
    const { first, later } = summaries();
    const content = buildMessages(later, null, first)[1]!.content;
    expect(content).toContain('Since last consultation (2 min ago)');
    expect(content).toContain('FOUND, 30 tiles away');
    expect(content).toContain('first sighting');
    expect(content).toContain('3 soldiers (2 heavy, 1 light, 0 ranged)');
  });

  it('holds the token budget: the whole prompt stays small', () => {
    const { first, later } = summaries();
    const total = buildMessages(
      later,
      { ...postureAdvice(PostureId.siege), posture: PostureId.siege },
      first,
    )
      .map((m) => m.content)
      .join('').length;
    // ~4 chars per token: 4500 chars keeps the prompt near the 900-token
    // budget the module header promises.
    expect(total).toBeLessThan(4500);
  });
});
