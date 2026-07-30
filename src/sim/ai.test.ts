import { describe, expect, it } from 'vitest';
import { createWorld, type World } from './world';
import { tickWorld } from './tick';
import { checkInvariants } from './debug/invariants';

function digest(world: World): unknown {
  return {
    tick: world.tick,
    rngState: world.rngState,
    nextId: world.nextId,
    units: [...world.units.values()].map((u) => ({ ...u, path: u.path ? [...u.path] : null })),
    buildings: [...world.buildings.values()],
    players: world.players,
    outcome: world.outcome,
  };
}

describe('the AI opponent', () => {
  it('AI vs AI produces a winner with a clean economy', () => {
    const world = createWorld({
      seed: 99,
      players: [{ kind: 'ai' }, { kind: 'ai' }],
      banditsEnabled: false,
    });
    const MAX = 90_000;
    for (let t = 0; t < MAX && world.outcome.state === 'playing'; t++) {
      tickWorld(world, []);
      if (world.tick % 200 === 0) {
        expect(checkInvariants(world).violations, `at tick ${world.tick}`).toEqual([]);
      }
    }
    expect(world.outcome.state, `still playing at tick ${world.tick}`).toBe('over');
    // A winner exists (either seat may take it; a draw would be null).
    expect((world.outcome as { winner: number | null }).winner).not.toBeNull();
  }, 240_000);

  it('is deterministic: two identical runs match at tick 3000', () => {
    const run = (): World => {
      const world = createWorld({ seed: 7, players: [{ kind: 'human' }, { kind: 'ai' }] });
      for (let t = 0; t < 3000; t++) tickWorld(world, []);
      return world;
    };
    expect(digest(run())).toEqual(digest(run()));
  });

  it('4-player mixed world is deterministic at tick 3000', () => {
    const run = (): World => {
      const world = createWorld({
        seed: 11,
        players: [{ kind: 'human' }, { kind: 'ai' }, { kind: 'ai' }, { kind: 'ai' }],
      });
      for (let t = 0; t < 3000; t++) tickWorld(world, []);
      return world;
    };
    expect(digest(run())).toEqual(digest(run()));
  });
});
