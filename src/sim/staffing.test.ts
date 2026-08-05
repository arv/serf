import { describe, expect, it } from 'vitest';
import { tickWorld } from './tick.ts';
import { killUnit, placeBuiltBuilding, type World } from './world.ts';
import { checkInvariants } from './debug/invariants.ts';
import { cmds, addSerf, addStorehouse, bareWorld, staffBuilding } from './testUtils.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

// The farm, not the well, is the stand-in for "a building that wants a
// resident": the well keeps none any more (it is drawn by whoever came for
// the water — see the well's own test at the bottom of this file), so it
// cannot demonstrate staffing at all.
describe('the population economy', () => {
  it('an idle serf walks over and becomes the worker', () => {
    const world = bareWorld();
    const farm = placeBuiltBuilding(world, 'wheatFarm', 0, 30, 30);
    farm.inputs.water = 3;
    const serf = addSerf(world, 36, 34);
    run(world, 20 * 15);

    expect(serf.kind).toBe('worker');
    expect(farm.workerId).toBe(serf.id);
    expect(farm.stock.wheat ?? 0).toBeGreaterThan(0); // staffed => producing
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('unstaffed buildings produce nothing', () => {
    const world = bareWorld();
    const farm = placeBuiltBuilding(world, 'wheatFarm', 0, 30, 30);
    farm.inputs.water = 3;
    run(world, 20 * 20); // no serfs anywhere
    expect(farm.stock.wheat ?? 0).toBe(0);
  });

  it('a dead worker is replaced from the serf pool', () => {
    const world = bareWorld();
    const farm = placeBuiltBuilding(world, 'wheatFarm', 0, 30, 30);
    const worker = staffBuilding(world, farm);
    const spare = addSerf(world, 35, 35);
    run(world, 5);
    killUnit(world, worker);
    run(world, 20 * 15);

    expect(spare.kind).toBe('worker');
    expect(farm.workerId).toBe(spare.id);
  });

  it('staffing competes with hauling: one serf cannot do both', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { wood: 20 });
    placeBuiltBuilding(world, 'wheatFarm', 0, 22, 30);
    addSerf(world, 28, 34); // exactly one person
    run(world, 20 * 15);

    // The lone serf took the farm post — nobody is left to haul.
    const kinds = [...world.units.values()].map((u) => u.kind);
    expect(kinds).toEqual(['worker']);
  });

  it('training a soldier consumes a serf (people become the army)', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { food: 6, spear: 2 });
    world.players[0]!.techs.researched.push('soldiery');
    const barracks = placeBuiltBuilding(world, 'barracks', 0, 36, 30);
    addSerf(world, 34, 34);
    addSerf(world, 33, 34); // one hauls, one enlists
    const peopleBefore = [...world.units.values()].filter((u) => !u.dead).length;
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: barracks.id, unit: 'spearman' }));
    run(world, 20 * 90);

    const spearman = [...world.units.values()].filter((u) => u.kind === 'spearman');
    expect(spearman.length).toBe(1);
    // Net population unchanged: serf out, soldier in.
    const peopleAfter = [...world.units.values()].filter((u) => !u.dead).length;
    expect(peopleAfter).toBe(peopleBefore);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('a destroyed building frees its en-route recruit', () => {
    const world = bareWorld();
    const farm = placeBuiltBuilding(world, 'wheatFarm', 0, 30, 30);
    const serf = addSerf(world, 44, 44); // long walk
    run(world, 30); // recruitment fires, serf is en route
    expect(serf.task.t).toBe('staff');
    farm.dead = true;
    run(world, 20 * 10);

    expect(serf.dead).toBe(false);
    expect(serf.kind).toBe('serf');
    expect(serf.task.t === 'idle' || serf.task.t === 'move').toBe(true);
  });

  it('the well keeps no one, and still supplies the farm', () => {
    const world = bareWorld();
    const well = placeBuiltBuilding(world, 'well', 0, 30, 30);
    const farm = placeBuiltBuilding(world, 'wheatFarm', 0, 34, 29);
    const hauler = addSerf(world, 32, 32);
    staffBuilding(world, farm);
    run(world, 20 * 60);

    // Nobody was ever recruited to it, and it filled its bucket regardless.
    expect(well.workerId).toBeUndefined();
    expect(hauler.homeId).toBeUndefined();
    // The water reached the farm and came out the other side as grain.
    expect(farm.stock.wheat ?? 0).toBeGreaterThan(0);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('drawing costs the hauler its six seconds at the windlass', () => {
    const world = bareWorld();
    const well = placeBuiltBuilding(world, 'well', 0, 30, 30);
    const store = addStorehouse(world, 34, 30, {});
    const serf = addSerf(world, 31, 31);

    // Watched tick by tick rather than sampled at a guessed moment: when the
    // draw starts depends on the matcher's beat and the walk over.
    let started = -1;
    let ends = -1;
    let carriedWhileDrawing = false;
    for (let t = 0; t < 20 * 60; t++) {
      tickWorld(world, []);
      const job = [...world.jobs.values()].find((j) => j.from === well.id);
      if (job?.drawUntil === undefined) continue;
      if (started < 0) {
        started = world.tick;
        ends = job.drawUntil;
      }
      if (world.tick < job.drawUntil && serf.carrying !== undefined) carriedWhileDrawing = true;
    }

    expect(started).toBeGreaterThan(0);
    // Six seconds at twenty ticks a second, less the tick the draw began on.
    expect(ends - started).toBe(20 * 6 - 1);
    // Nothing in its hands until the windlass is done.
    expect(carriedWhileDrawing).toBe(false);
    // And then the water arrives.
    expect(store.stock.water ?? 0).toBeGreaterThan(0);
  });
});
