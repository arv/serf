import { describe, expect, it } from 'vitest';
import { createWorld } from './world';
import { tickWorld } from './tick';

/**
 * THE playtest: the AI opponent (systems/ai.ts) wins the solo campaign on
 * the default map using only legitimate commands — build the economy,
 * research, arm a squad, defend against raids, raze the bandit camp. If
 * balance changes ever make the game unwinnable, this fails. Campaign
 * winnability and AI competence are one regression on purpose.
 */
describe('the campaign is winnable', () => {
  it('the AI player beats the default map', () => {
    const world = createWorld({ seed: 20260724, players: [{ kind: 'ai' }] });

    const MAX_TICKS = 45_000; // ~37 minutes of game time
    for (let t = 0; t < MAX_TICKS; t++) {
      tickWorld(world, []);
      if (world.outcome.state !== 'playing') break;
    }

    // The one assertion that matters.
    expect(world.outcome, `ended at tick ${world.tick}`).toEqual({ state: 'over', winner: 0 });
    expect(world.tick).toBeLessThan(45_000);
  }, 120_000);
});
