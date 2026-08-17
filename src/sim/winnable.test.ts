import { describe, expect, it } from 'vitest';
import { createWorld } from './world.ts';
import { tickWorld } from './tick.ts';
import { AiBrain } from './systems/ai.ts';
import { strategyOf } from './defs/aiStrategies.ts';

/**
 * THE playtest: the AI brain (systems/ai.ts) wins the solo campaign on the
 * default map using only legitimate commands — build the economy, research,
 * arm a squad, defend against raids, raze the bandit camp. The test drives
 * the brain the same way its worker does (decide from the world at tick T,
 * commands land as inputs). If balance changes ever make the game
 * unwinnable, this fails. Campaign winnability and AI competence are one
 * regression on purpose.
 */
describe('the campaign is winnable', () => {
  it('the AI player beats the default map', () => {
    const world = createWorld({ seed: 20260724, players: [{ kind: 'ai' }] });
    // Whichever playbook this seed dealt the seat — every one of them can
    // take this map (aiStrategies.test.ts holds that line); what is tested
    // here is that the map stays takeable.
    const brain = new AiBrain(0, strategyOf(world.players[0]!.strategy), world.map.size);

    const MAX_TICKS = 45_000; // ~37 minutes of game time
    for (let t = 0; t < MAX_TICKS; t++) {
      const commands = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
      tickWorld(
        world,
        commands.map((cmd) => ({ playerId: 0, cmd })),
      );
      if (world.outcome.state !== 'playing') break;
    }

    // The one assertion that matters.
    expect(world.outcome, `ended at tick ${world.tick}`).toEqual({ state: 'over', winner: 0 });
    expect(world.tick).toBeLessThan(45_000);
  }, 120_000);
});
