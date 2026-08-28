import { describe, expect, it } from 'vitest';
import { tickWorld } from './tick.ts';
import { killUnit, placeBuiltBuilding, type World } from './world.ts';
import { checkInvariants } from './debug/invariants.ts';
import {
  cmds,
  addSerf,
  addStorehouse,
  addBuiltHut,
  addResourceTile,
  bareWorld,
  staffBuilding,
} from './testUtils.ts';
import { tileIdx } from '../shared/grid.ts';
import { OUTPUT_CAP } from './defs/buildings.ts';
import { bindWorker } from './systems/production.ts';
import { GoodId } from './defs/goods.ts';
import { UnitTypeId } from './defs/units.ts';
import { BuildingTypeId } from './defs/buildings.ts';
import { TechId } from './defs/techs.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

// The farm, not the well, is the stand-in for "a building that wants a
// resident": the well keeps none any more (it is drawn by whoever came for
// the water — see the well's own test at the bottom of this file), so it
// cannot demonstrate staffing at all.
/**
 * A resident who leaves his post has to come back as a *usable* hand. The
 * task reset is what makes that true, and it lives in unbindWorker so no
 * caller can forget it — two of them already had.
 */
describe('releasing a worker', () => {
  it('puts the freed hand back in the haul pool, not in limbo', () => {
    // A gather task is driven by the BUILDING (gatherStep runs off
    // b.workerId), so a hand released mid-trip keeps a `gatherWork` nothing
    // will ever advance — and dispatch, staffing and wander all want a
    // genuinely idle unit. He would stand in the field forever, counted
    // against the population and eating, doing nothing.
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    addResourceTile(world, 40, 41);
    const hut = addBuiltHut(world, 40, 40);
    hut.stock = { [GoodId.wood]: OUTPUT_CAP };
    const worker = world.units.get(hut.workerId!)!;
    worker.task = { t: 'gatherWork', tile: tileIdx(40, 41, world.map.size), until: 999_999 };

    tickWorld(world, cmds({ kind: 'setBuildingPaused', buildingId: hut.id, paused: true }));

    expect(worker.kind).toBe(UnitTypeId.serf);
    // Idle, or already claimed for a haul — either is in the pool. What is
    // fatal is a leftover gather task.
    expect(['idle', 'haul']).toContain(worker.task.t);
  });

  it('does the same when the whole building is sold out from under him', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    addResourceTile(world, 40, 41);
    const hut = addBuiltHut(world, 40, 40);
    const worker = world.units.get(hut.workerId!)!;
    worker.task = { t: 'gatherWork', tile: tileIdx(40, 41, world.map.size), until: 999_999 };

    tickWorld(world, cmds({ kind: 'sellBuilding', buildingId: hut.id }));

    expect(worker.dead).toBe(false);
    expect(worker.kind).toBe(UnitTypeId.serf);
    expect(['idle', 'haul']).toContain(worker.task.t);
  });
});

describe('the population economy', () => {
  it('an idle serf walks over and becomes the worker', () => {
    const world = bareWorld();
    const farm = placeBuiltBuilding(world, BuildingTypeId.wheatFarm, 0, 30, 30);
    farm.inputs[GoodId.water] = 3;
    farm.inputs[GoodId.scythe] = 1; // the post's tool, already on the rack
    const serf = addSerf(world, 36, 34);
    run(world, 20 * 15);

    expect(serf.kind).toBe(UnitTypeId.worker);
    expect(farm.workerId).toBe(serf.id);
    expect(farm.stock[GoodId.wheat] ?? 0).toBeGreaterThan(0); // staffed => producing
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('unstaffed buildings produce nothing', () => {
    const world = bareWorld();
    const farm = placeBuiltBuilding(world, BuildingTypeId.wheatFarm, 0, 30, 30);
    farm.inputs[GoodId.water] = 3;
    run(world, 20 * 20); // no serfs anywhere
    expect(farm.stock[GoodId.wheat] ?? 0).toBe(0);
  });

  it('a dead worker is replaced from the serf pool', () => {
    const world = bareWorld();
    const farm = placeBuiltBuilding(world, BuildingTypeId.wheatFarm, 0, 30, 30);
    // The replacement's scythe: the first worker's died with him.
    farm.inputs[GoodId.scythe] = 1;
    const worker = staffBuilding(world, farm);
    const spare = addSerf(world, 35, 35);
    run(world, 5);
    killUnit(world, worker);
    run(world, 20 * 15);

    expect(spare.kind).toBe(UnitTypeId.worker);
    expect(farm.workerId).toBe(spare.id);
  });

  it('staffing competes with hauling: one serf cannot do both', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { [GoodId.wood]: 20 });
    placeBuiltBuilding(world, BuildingTypeId.wheatFarm, 0, 22, 30);
    addSerf(world, 28, 34); // exactly one person
    run(world, 20 * 15);

    // The lone serf took the farm post — nobody is left to haul.
    const kinds = [...world.units.values()].map((u) => u.kind);
    expect(kinds).toEqual([UnitTypeId.worker]);
  });

  it('training a soldier consumes a serf (people become the army)', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { [GoodId.food]: 6, [GoodId.spear]: 2 });
    world.players[0]!.techs.researched.push(TechId.soldiery);
    const barracks = placeBuiltBuilding(world, BuildingTypeId.barracks, 0, 36, 30);
    addSerf(world, 34, 34);
    addSerf(world, 33, 34); // one hauls, one enlists
    const peopleBefore = [...world.units.values()].filter((u) => !u.dead).length;
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: barracks.id, unit: UnitTypeId.spearman }));
    run(world, 20 * 90);

    const spearman = [...world.units.values()].filter((u) => u.kind === UnitTypeId.spearman);
    expect(spearman.length).toBe(1);
    // Net population unchanged: serf out, soldier in.
    const peopleAfter = [...world.units.values()].filter((u) => !u.dead).length;
    expect(peopleAfter).toBe(peopleBefore);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('a destroyed building frees its en-route recruit', () => {
    const world = bareWorld();
    const farm = placeBuiltBuilding(world, BuildingTypeId.wheatFarm, 0, 30, 30);
    farm.inputs[GoodId.scythe] = 1; // recruitment waits on the post's tool
    const serf = addSerf(world, 44, 44); // long walk
    run(world, 30); // recruitment fires, serf is en route
    expect(serf.task.t).toBe('staff');
    farm.dead = true;
    run(world, 20 * 10);

    expect(serf.dead).toBe(false);
    expect(serf.kind).toBe(UnitTypeId.serf);
    expect(serf.task.t === 'idle' || serf.task.t === 'move').toBe(true);
  });

  it('the well keeps no one, and still supplies the farm', () => {
    const world = bareWorld();
    const well = placeBuiltBuilding(world, BuildingTypeId.well, 0, 30, 30);
    const farm = placeBuiltBuilding(world, BuildingTypeId.wheatFarm, 0, 34, 29);
    const hauler = addSerf(world, 32, 32);
    staffBuilding(world, farm);
    run(world, 20 * 60);

    // Nobody was ever recruited to it, and it filled its bucket regardless.
    expect(well.workerId).toBeUndefined();
    expect(hauler.homeId).toBeUndefined();
    // The water reached the farm and came out the other side as grain.
    expect(farm.stock[GoodId.wheat] ?? 0).toBeGreaterThan(0);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('a save from before the well lost its keeper gives the hand back', () => {
    const world = bareWorld();
    const well = placeBuiltBuilding(world, BuildingTypeId.well, 0, 30, 30);
    // Exactly what an older save deserializes into: a standing well with a
    // resident bound to it, from the days when its def asked for one.
    const keeper = addSerf(world, 30, 31);
    keeper.kind = UnitTypeId.worker;
    bindWorker(well, keeper);
    expect(well.workerId).toBe(keeper.id);

    run(world, 30); // past one recruitment sweep

    expect(well.workerId).toBeUndefined();
    expect(keeper.kind).toBe(UnitTypeId.serf);
    expect(keeper.homeId).toBeUndefined();
    expect(keeper.task.t).toBe('idle');
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('drawing costs the hauler its six seconds at the windlass', () => {
    const world = bareWorld();
    const well = placeBuiltBuilding(world, BuildingTypeId.well, 0, 30, 30);
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
    expect(store.stock[GoodId.water] ?? 0).toBeGreaterThan(0);
  });
});
