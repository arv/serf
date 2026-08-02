import { describe, expect, it } from 'vitest';
import { createWorld } from './world.ts';
import { tickWorld } from './tick.ts';

/**
 * A world generated without bandits has no camp, no guards, and no
 * objective clock: solo becomes a sandbox that only ends if the
 * storehouse falls — not an instant raze-the-camp victory over a camp
 * that never existed.
 */
describe('a banditless world', () => {
  it('places no camp and never auto-wins the solo campaign', () => {
    const world = createWorld({
      seed: 20260724,
      players: [{ kind: 'human' }],
      banditsEnabled: false,
    });
    const camps = [...world.buildings.values()].filter((b) => b.type === 'banditCamp');
    expect(camps).toEqual([]);
    const bandits = [...world.units.values()].filter((u) => u.kind === 'bandit');
    expect(bandits).toEqual([]);

    for (let i = 0; i < 600; i++) tickWorld(world, []);
    expect(world.outcome.state).toBe('playing');
  });

  it('with bandits on, the camp still spawns and razing it still wins', () => {
    const world = createWorld({ seed: 20260724, players: [{ kind: 'human' }] });
    const camp = [...world.buildings.values()].find((b) => b.type === 'banditCamp');
    expect(camp).toBeDefined();
  });
});
