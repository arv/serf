import { describe, expect, it } from 'vitest';
import { createWorld, type World, type WorldConfig } from './world.ts';
import { tickWorld, type PlayerCommand } from './tick.ts';
import { AiBrain } from './systems/ai.ts';
import { strategyOf } from './defs/aiStrategies.ts';
import { checkInvariants } from './debug/invariants.ts';

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

/** Drive every AI seat's brain the way its worker does. */
function runWithBrains(config: WorldConfig, maxTicks: number, onTick?: (w: World) => void): World {
  const world = createWorld(config);
  // Playbooks come off the world, which was dealt them from the seed —
  // the same lookup AiSeats does for the hosts.
  const brains = world.players
    .filter((p) => p.kind === 'ai')
    .map((p) => new AiBrain(p.id, strategyOf(p.strategy)));
  for (let t = 0; t < maxTicks && world.outcome.state === 'playing'; t++) {
    const commands: PlayerCommand[] = [];
    for (const brain of brains) {
      if (brain.shouldDecide(world.tick)) {
        for (const cmd of brain.decide(world)) commands.push({ playerId: brain.playerId, cmd });
      }
    }
    tickWorld(world, commands);
    onTick?.(world);
  }
  return world;
}

describe('the AI opponent', () => {
  it('AI vs AI produces a winner with a clean economy', () => {
    const world = runWithBrains(
      { seed: 99, players: [{ kind: 'ai' }, { kind: 'ai' }], banditsEnabled: false },
      90_000,
      (w) => {
        if (w.tick % 200 === 0) {
          expect(checkInvariants(w).violations, `at tick ${w.tick}`).toEqual([]);
        }
      },
    );
    expect(world.outcome.state, `still playing at tick ${world.tick}`).toBe('over');
    // A winner exists (either seat may take it; a draw would be null).
    expect((world.outcome as { winner: number | null }).winner).not.toBeNull();
  }, 240_000);

  it('is deterministic: two identical runs match at tick 3000', () => {
    const config: WorldConfig = { seed: 7, players: [{ kind: 'human' }, { kind: 'ai' }] };
    expect(digest(runWithBrains(config, 3000))).toEqual(digest(runWithBrains(config, 3000)));
  });

  it('4-player mixed world is deterministic at tick 3000', () => {
    const config: WorldConfig = {
      seed: 11,
      players: [{ kind: 'human' }, { kind: 'ai' }, { kind: 'ai' }, { kind: 'ai' }],
    };
    expect(digest(runWithBrains(config, 3000))).toEqual(digest(runWithBrains(config, 3000)));
  });
});
