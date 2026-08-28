import { describe, expect, it } from 'vitest';
import { createWorld, MatchState } from './world.ts';
import { tickWorld } from './tick.ts';
import { AiBrain } from './systems/ai.ts';
import { strategyOf } from './defs/aiStrategies.ts';
import { PlayerKind } from './player.ts';

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
    // Seed 37: the pinned default valley, re-picked after the pan clamp
    // and the zoom-out cap each took a share of the scenery ring and
    // re-rolled every world with it. Chosen by sweep, on the same two
    // counts as the seeds before it — it satisfies the fairness contract
    // at 2/3/4 seats (mapFairness's own suite, run against it), and every
    // playbook takes it with room to spare: 13.5k, 14.7k, 16.3k and 18.9k
    // of the 45k budget.
    const world = createWorld({ seed: 37, players: [{ kind: PlayerKind.ai }] });
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
      if (world.outcome.state !== MatchState.playing) break;
    }

    // The one assertion that matters.
    expect(world.outcome, `ended at tick ${world.tick}`).toEqual({
      state: MatchState.over,
      winner: 0,
    });
    expect(world.tick).toBeLessThan(45_000);
  }, 120_000);
});
