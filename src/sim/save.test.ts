import { describe, expect, it } from 'vitest';
import { cmds } from './testUtils.ts';
import { createWorld, type World } from './world.ts';
import { deserializeWorld, serializeWorld } from './save.ts';
import { tickWorld } from './tick.ts';
import { checkInvariants } from './debug/invariants.ts';
import type { SimCommand } from './commands.ts';

function commandScript(tick: number): SimCommand[] {
  if (tick === 50) return [{ kind: 'placeBuilding', building: 'woodcutter', x: 26, y: 36 }];
  if (tick === 60) return [{ kind: 'placeBuilding', building: 'well', x: 38, y: 36 }];
  if (tick === 800) return [{ kind: 'placeBuilding', building: 'wheatFarm', x: 40, y: 30 }];
  return [];
}

function digest(world: World) {
  return {
    tick: world.tick,
    rngState: world.rngState,
    nextId: world.nextId,
    units: [...world.units.values()],
    buildings: [...world.buildings.values()],
    jobs: [...world.jobs.values()],
    blocked: [...world.map.blocked],
    wear: [...world.map.wear],
    pathLevel: [...world.map.pathLevel],
    ledger: world.ledger,
    techs: world.players[0]!.techs,
  };
}

describe('save/load', () => {
  it('round-trip at tick N + resume == uninterrupted run', () => {
    const a = createWorld(777);
    for (let t = 0; t < 1500; t++) tickWorld(a, cmds(...commandScript(t)));

    // Snapshot mid-flight (serfs mid-haul, workers mid-chop).
    const saved = serializeWorld(a);
    const b = deserializeWorld(saved);

    for (let t = 1500; t < 3000; t++) {
      tickWorld(a, cmds(...commandScript(t)));
      tickWorld(b, cmds(...commandScript(t)));
    }

    expect(digest(b)).toEqual(digest(a));
    expect(checkInvariants(b).violations).toEqual([]);
  });

  it('rejects unknown versions', () => {
    expect(() => deserializeWorld('{"version":99,"world":{}}')).toThrow();
  });

  it('refuses saves from before the medieval id rename', () => {
    expect(() => deserializeWorld('{"version":1,"world":{}}')).toThrow(/older version/);
    expect(() => deserializeWorld('{"version":2,"world":{}}')).toThrow(/older version/);
  });

  it('save size stays localStorage-friendly', () => {
    const world = createWorld(1);
    for (let t = 0; t < 500; t++) tickWorld(world, cmds(...commandScript(t)));
    const size = serializeWorld(world).length;
    expect(size).toBeLessThan(1_500_000); // well under the ~5MB quota
  });
});
