import { describe, expect, it } from 'vitest';
import { tickWorld } from './tick.ts';
import { placeBuiltBuilding, type World } from './world.ts';
import { cloneWorld } from './clone.ts';
import { hashWorld } from './hash.ts';
import { deserializeWorld, serializeWorld } from './save.ts';
import { tileX, tileY } from '../shared/grid.ts';
import { checkInvariants } from './debug/invariants.ts';
import { cmds, addSerf, addStorehouse, bareWorld } from './testUtils.ts';
import type { Unit } from './units.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

/** Tick until the first unit of this kind exists, or the guard runs out. */
function trainOut(world: World, kind: string, guard = 20 * 120): Unit | undefined {
  let unit: Unit | undefined;
  while (
    !(unit = [...world.units.values()].find((u) => u.kind === kind && !u.dead)) &&
    guard-- > 0
  ) {
    tickWorld(world, []);
  }
  return unit;
}

describe('the barracks rally flag', () => {
  it('plants, moves and strikes the flag — on a building that trains only', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const barracks = placeBuiltBuilding(world, 'barracks', 0, 36, 30);

    tickWorld(world, cmds({ kind: 'setRallyPoint', buildingId: barracks.id, x: 45, y: 40 }));
    expect(barracks.rally).toEqual({ x: 45, y: 40 });

    // A second order re-aims the same flag rather than planting a second one.
    tickWorld(world, cmds({ kind: 'setRallyPoint', buildingId: barracks.id, x: 20, y: 21 }));
    expect(barracks.rally).toEqual({ x: 20, y: 21 });

    // A half-given pair changes nothing — the sim reads it the way the
    // sanitizer does, so a caller that skipped screening cannot strike a
    // standing flag with a malformed plant.
    tickWorld(world, cmds({ kind: 'setRallyPoint', buildingId: barracks.id, x: 30 }));
    expect(barracks.rally).toEqual({ x: 20, y: 21 });
    tickWorld(world, cmds({ kind: 'setRallyPoint', buildingId: barracks.id, y: 30 }));
    expect(barracks.rally).toEqual({ x: 20, y: 21 });

    // No coordinates is the take-it-down order.
    tickWorld(world, cmds({ kind: 'setRallyPoint', buildingId: barracks.id }));
    expect(barracks.rally).toBeUndefined();

    // A flag aimed off the map is refused, not clamped.
    tickWorld(world, cmds({ kind: 'setRallyPoint', buildingId: barracks.id, x: 10_000, y: 3 }));
    expect(barracks.rally).toBeUndefined();

    // A storehouse trains nobody, so a flag on it would be an order nothing
    // ever reads — refused at the door.
    const sh = [...world.buildings.values()].find((b) => b.type === 'storehouse')!;
    tickWorld(world, cmds({ kind: 'setRallyPoint', buildingId: sh.id, x: 45, y: 40 }));
    expect(sh.rally).toBeUndefined();
  });

  it("refuses a flag on someone else's barracks", () => {
    const world = bareWorld(1, 2);
    addStorehouse(world, 30, 30, {});
    const barracks = placeBuiltBuilding(world, 'barracks', 0, 36, 30);
    tickWorld(world, [
      { playerId: 1, cmd: { kind: 'setRallyPoint', buildingId: barracks.id, x: 45, y: 40 } },
    ]);
    expect(barracks.rally).toBeUndefined();
  });

  it('marches a fresh soldier from the door to the flag', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { food: 10, sword: 2 });
    const barracks = placeBuiltBuilding(world, 'barracks', 0, 36, 30);
    addSerf(world, 34, 34);
    tickWorld(world, cmds({ kind: 'setRallyPoint', buildingId: barracks.id, x: 45, y: 40 }));
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: barracks.id, unit: 'knight' }));

    const knight = trainOut(world, 'knight');
    expect(knight).toBeDefined();
    // He steps out already under way: a plain move — not an attack-move, so
    // a flag near a fight cannot trickle recruits into it one at a time —
    // whose path ends on the flag's tile.
    expect(knight!.task.t).toBe('move');
    const last = knight!.path![knight!.path!.length - 1]!;
    expect(tileX(last, world.map.size)).toBe(45);
    expect(tileY(last, world.map.size)).toBe(40);

    // And he actually gets there and stands down.
    run(world, 20 * 30);
    expect(Math.abs(knight!.x - 45.5)).toBeLessThan(0.01);
    expect(Math.abs(knight!.y - 40.5)).toBeLessThan(0.01);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('without a flag the recruit stands at the door, as ever', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { food: 10, sword: 2 });
    const barracks = placeBuiltBuilding(world, 'barracks', 0, 36, 30);
    addSerf(world, 34, 34);
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: barracks.id, unit: 'knight' }));

    const knight = trainOut(world, 'knight');
    expect(knight).toBeDefined();
    expect(knight!.path).toBeNull();
  });

  it('a cancelled order still returns its serf to the door, not the flag', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { food: 10, sword: 1 });
    const barracks = placeBuiltBuilding(world, 'barracks', 0, 36, 30);
    addSerf(world, 34, 34);
    tickWorld(world, cmds({ kind: 'setRallyPoint', buildingId: barracks.id, x: 45, y: 40 }));
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: barracks.id, unit: 'knight' }));

    let guard = 20 * 120;
    while (!barracks.trainQueue?.[0]?.started && guard-- > 0) tickWorld(world, []);
    expect(barracks.trainQueue?.[0]?.started).toBe(true);
    tickWorld(
      world,
      cmds({ kind: 'cancelTraining', buildingId: barracks.id, index: 0, unit: 'knight' }),
    );
    // The person walks back out a serf, and the flag — a soldiers' muster —
    // is no order of his.
    const serf = [...world.units.values()].find((u) => u.kind === 'serf' && !u.dead);
    expect(serf).toBeDefined();
    expect(serf!.path).toBeNull();
  });

  it('survives clone and save round-trips, and the hash sees it', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const barracks = placeBuiltBuilding(world, 'barracks', 0, 36, 30);
    tickWorld(world, cmds({ kind: 'setRallyPoint', buildingId: barracks.id, x: 45, y: 40 }));

    const viaClone = cloneWorld(world);
    const viaSave = deserializeWorld(serializeWorld(world));
    expect(hashWorld(viaClone)).toBe(hashWorld(world));
    expect(hashWorld(viaSave)).toBe(hashWorld(world));

    // The flag steers every recruit that steps out of the door — a copy
    // that lost or moved it must not hash as "the same world".
    const moved = cloneWorld(world);
    moved.buildings.get(barracks.id)!.rally = { x: 45, y: 41 };
    expect(hashWorld(moved)).not.toBe(hashWorld(world));
    const struck = cloneWorld(world);
    struck.buildings.get(barracks.id)!.rally = undefined;
    expect(hashWorld(struck)).not.toBe(hashWorld(world));
  });
});
