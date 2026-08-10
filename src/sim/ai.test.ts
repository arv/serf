import { describe, expect, it } from 'vitest';
import { createWorld, type World, type WorldConfig } from './world.ts';
import { tickWorld, type PlayerCommand } from './tick.ts';
import { AiBrain } from './systems/ai.ts';
import { AiSeats } from './aiSeats.ts';
import { strategyOf, type AiStrategy } from './defs/aiStrategies.ts';
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

/**
 * The strategist override (src/ai/): a Partial<AiStrategy> the LLM lays
 * over a brain's playbook. What is covered is the two promises the seam
 * makes — laid and cleared it leaves no trace, and laid with real values
 * the brain actually plays differently.
 */
describe('strategist overrides', () => {
  /** Ticks until the brain first marches its army away from home — the
   * observable a changed muster size moves. Under fog a brain also emits
   * one-soldier scout errands and whole-army rallies to the spot south of
   * the castle; a march is the whole muster ordered anywhere else. */
  function firstMarchTick(override: Partial<AiStrategy> | null, maxTicks: number): number {
    const world = createWorld({ seed: 20260724, players: [{ kind: 'ai', strategy: 'steward' }] });
    const brain = new AiBrain(0, strategyOf(world.players[0]!.strategy));
    if (override) brain.setOverride(override);
    const castle = [...world.buildings.values()].find((b) => b.type === 'storehouse')!;
    const home = { x: castle.x + 1, y: castle.y + 1 + 4 };
    for (let t = 0; t < maxTicks && world.outcome.state === 'playing'; t++) {
      const commands = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
      for (const cmd of commands) {
        if (
          cmd.kind === 'moveUnits' &&
          cmd.unitIds.length >= 3 &&
          (cmd.x !== home.x || cmd.y !== home.y)
        ) {
          return world.tick;
        }
      }
      tickWorld(
        world,
        commands.map((cmd) => ({ playerId: 0, cmd })),
      );
    }
    return maxTicks;
  }

  it('laid empty and cleared again, the seam leaves the game untouched', () => {
    const config: WorldConfig = { seed: 7, players: [{ kind: 'human' }, { kind: 'ai' }] };
    const baseline = digest(runWithBrains(config, 3000));

    const world = createWorld(config);
    const brain = new AiBrain(1, strategyOf(world.players[1]!.strategy));
    for (let t = 0; t < 3000 && world.outcome.state === 'playing'; t++) {
      // An empty override spreads to the same values; clearing goes back to
      // the playbook object itself. Either way: the identical game.
      if (t === 1000) brain.setOverride({});
      if (t === 2000) brain.setOverride(null);
      const commands = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
      tickWorld(
        world,
        commands.map((cmd) => ({ playerId: 1, cmd })),
      );
    }
    expect(digest(world)).toEqual(baseline);
  });

  it('an eager override marches the army sooner', () => {
    const patient = firstMarchTick(null, 20_000);
    const eager = firstMarchTick({ armyAttackSize: 3, attackCooldown: 200 }, 20_000);
    expect(eager).toBeLessThan(patient);
  }, 120_000);

  it('AiSeats routes advice to the seat it names, and shrugs at one it cannot find', () => {
    const world = createWorld({
      seed: 7,
      players: [{ kind: 'human' }, { kind: 'ai' }, { kind: 'ai' }],
    });
    const seats = new AiSeats(world);
    expect(seats.seatIds()).toEqual([1, 2]);
    seats.applyAdvice(1, { armyAttackSize: 3 });
    // Advice can outlive the brain it was meant for; a seat that is not
    // there is a no-op, not a crash.
    seats.applyAdvice(9, { armyAttackSize: 3 });
  });
});
