import { describe, expect, it } from 'vitest';
import { cmds } from './testUtils.ts';
import { createWorld, type World } from './world.ts';
import { tickWorld } from './tick.ts';
import type { SimCommand } from './commands.ts';
import { CommandKind } from './commands.ts';

/** Deep-comparable digest of sim state (Maps flattened, floats exact). */
function digest(world: World) {
  return {
    tick: world.tick,
    rngState: world.rngState,
    nextId: world.nextId,
    units: [...world.units.values()].map((u) => ({ ...u, path: u.path ? [...u.path] : null })),
    buildings: [...world.buildings.values()],
    blocked: [...world.map.blocked],
    wear: [...world.map.wear],
  };
}

function commandScript(tick: number): SimCommand[] {
  // A deterministic, moderately adversarial command stream.
  if (tick === 100) return [{ kind: CommandKind.moveUnits, unitIds: [7, 8], x: 10, y: 10 }];
  if (tick === 300) return [{ kind: CommandKind.moveUnits, unitIds: [7, 8, 9], x: 50, y: 50 }];
  if (tick === 301) return [{ kind: CommandKind.moveUnits, unitIds: [7], x: 5, y: 60 }];
  if (tick === 900) return [{ kind: CommandKind.moveUnits, unitIds: [999], x: 1, y: 1 }]; // unknown id
  return [];
}

function run(seed: number, ticks: number): World {
  const world = createWorld(seed);
  for (let t = 0; t < ticks; t++) tickWorld(world, cmds(...commandScript(t)));
  return world;
}

describe('determinism', () => {
  it('same seed + same commands => identical world at tick 5000', () => {
    const a = run(1234, 5000);
    const b = run(1234, 5000);
    expect(digest(a)).toEqual(digest(b));
  });

  it('different seeds diverge', () => {
    const a = run(1, 500);
    const b = run(2, 500);
    expect(digest(a)).not.toEqual(digest(b));
  });

  it('units actually move (wander is alive)', () => {
    const world = createWorld(42);
    const before = [...world.units.values()].map((u) => [u.x, u.y]);
    for (let t = 0; t < 400; t++) tickWorld(world, []);
    const after = [...world.units.values()].map((u) => [u.x, u.y]);
    expect(after).not.toEqual(before);
  });
});
