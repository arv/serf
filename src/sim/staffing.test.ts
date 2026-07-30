import { describe, expect, it } from 'vitest';
import { tickWorld } from './tick';
import { killUnit, placeBuiltBuilding, type World } from './world';
import { checkInvariants } from './debug/invariants';
import { cmds, addSerf, addStorehouse, bareWorld, staffBuilding } from './testUtils';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

describe('the population economy', () => {
  it('an idle serf walks over and becomes the worker', () => {
    const world = bareWorld();
    const well = placeBuiltBuilding(world, 'well', 0, 30, 30);
    const serf = addSerf(world, 36, 34);
    run(world, 20 * 15);

    expect(serf.kind).toBe('worker');
    expect(well.workerId).toBe(serf.id);
    expect(well.stock.water ?? 0).toBeGreaterThan(0); // staffed => producing
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('unstaffed buildings produce nothing', () => {
    const world = bareWorld();
    const well = placeBuiltBuilding(world, 'well', 0, 30, 30);
    run(world, 20 * 20); // no serfs anywhere
    expect(well.stock.water ?? 0).toBe(0);
  });

  it('a dead worker is replaced from the serf pool', () => {
    const world = bareWorld();
    const well = placeBuiltBuilding(world, 'well', 0, 30, 30);
    const worker = staffBuilding(world, well);
    const spare = addSerf(world, 35, 35);
    run(world, 5);
    killUnit(world, worker);
    run(world, 20 * 15);

    expect(spare.kind).toBe('worker');
    expect(well.workerId).toBe(spare.id);
  });

  it('staffing competes with hauling: one serf cannot do both', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { bamboo: 20 });
    placeBuiltBuilding(world, 'well', 0, 24, 30);
    addSerf(world, 28, 34); // exactly one person
    run(world, 20 * 15);

    // The lone serf took the well post — nobody is left to haul.
    const kinds = [...world.units.values()].map((u) => u.kind);
    expect(kinds).toEqual(['worker']);
  });

  it('training a soldier consumes a serf (people become the army)', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { rice: 6, yari: 2 });
    world.players[0]!.techs.researched.push('bushido');
    const dojo = placeBuiltBuilding(world, 'dojo', 0, 36, 30);
    addSerf(world, 34, 34);
    addSerf(world, 33, 34); // one hauls, one enlists
    const peopleBefore = [...world.units.values()].filter((u) => !u.dead).length;
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: dojo.id, unit: 'ashigaru' }));
    run(world, 20 * 90);

    const ashigaru = [...world.units.values()].filter((u) => u.kind === 'ashigaru');
    expect(ashigaru.length).toBe(1);
    // Net population unchanged: serf out, soldier in.
    const peopleAfter = [...world.units.values()].filter((u) => !u.dead).length;
    expect(peopleAfter).toBe(peopleBefore);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('a destroyed building frees its en-route recruit', () => {
    const world = bareWorld();
    const well = placeBuiltBuilding(world, 'well', 0, 30, 30);
    const serf = addSerf(world, 44, 44); // long walk
    run(world, 30); // recruitment fires, serf is en route
    expect(serf.task.t).toBe('staff');
    well.dead = true;
    run(world, 20 * 10);

    expect(serf.dead).toBe(false);
    expect(serf.kind).toBe('serf');
    expect(serf.task.t === 'idle' || serf.task.t === 'move').toBe(true);
  });
});
