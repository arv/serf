import { describe, expect, it } from 'vitest';
import { tickWorld } from './tick.ts';
import { TileResource } from './map.ts';
import { placeBuiltBuilding, type World } from './world.ts';
import { addBuiltHut, addResourceTile, addSerf, addSite, addStorehouse, bareWorld } from './testUtils.ts';
import type { Unit } from './units.ts';
import { GoodId } from './defs/goods.ts';
import { UnitTypeId } from './defs/units.ts';
import { BuildingTypeId } from './defs/buildings.ts';
import { UnitTaskKind } from './units.ts';
import { HaulPhase } from './world.ts';

/** Put a unit where its walk would have left it had the route died: far from
 * where it was going, with nothing left to walk. */
function strandFarAway(unit: Unit): void {
  unit.x = 55.5;
  unit.y = 55.5;
  unit.path = null;
}

function runUntil(world: World, ready: () => boolean, ticks = 600): void {
  for (let i = 0; i < ticks && !ready(); i++) tickWorld(world, []);
}

/**
 * Arrival is asked, not assumed.
 *
 * Every errand ends the same way in the data — `path` goes null — and a route
 * lost to new construction ends it that way too. Owner systems could not tell
 * the two apart, so work got done at a distance: goods drawn out of buildings
 * across the map, trees felled from the next valley, recruits swallowed by a
 * barracks they never reached. Each system now checks the unit is standing
 * where it sent it.
 */
describe('work only happens where the worker is standing', () => {
  it('a hauler cut off from the source draws nothing out of it', () => {
    const world = bareWorld();
    const from = addStorehouse(world, 30, 30, { [GoodId.wood]: 5 });
    addSite(world, 40, 40); // a site wanting wood puts a job on the board
    const serf = addSerf(world, 31, 33);
    runUntil(world, () => serf.task.t === UnitTaskKind.haul && serf.jobId !== undefined);
    expect(world.jobs.get(serf.jobId!)?.phase).toBe(HaulPhase.toPickup);

    const stock = from.stock[GoodId.wood];
    strandFarAway(serf);
    tickWorld(world, []);

    expect(from.stock[GoodId.wood]).toBe(stock); // the wood stayed in the storehouse
    expect(serf.carrying).toBeUndefined(); // and never appeared on his back
    expect(serf.path).not.toBeNull(); // he is walking there instead
  });

  it('a hauler cut off from the destination delivers nothing into it', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { [GoodId.wood]: 5 });
    const site = addSite(world, 40, 40);
    const serf = addSerf(world, 31, 33);
    runUntil(world, () => serf.carrying !== undefined);
    expect(world.jobs.get(serf.jobId!)?.phase).toBe(HaulPhase.toDropoff);

    const needed = site.siteNeeds![GoodId.wood];
    strandFarAway(serf);
    tickWorld(world, []);

    expect(site.siteNeeds![GoodId.wood]).toBe(needed); // nothing landed on the site
    expect(serf.carrying).toBe(GoodId.wood); // still on his shoulders
    expect(serf.path).not.toBeNull();
  });

  it('a woodcutter cut off from his tree fells nothing', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    addResourceTile(world, 36, 30, TileResource.Wood, 6);
    const hut = addBuiltHut(world, 33, 30);
    const worker = world.units.get(hut.workerId!)!;
    runUntil(world, () => worker.task.t === UnitTaskKind.gatherOut);

    const tile = (worker.task as { tile: number }).tile;
    const standing = world.map.resourceAmt[tile];
    strandFarAway(worker);
    tickWorld(world, []);

    expect(world.map.resourceAmt[tile]).toBe(standing); // the tree still stands
    expect(worker.carrying).toBeUndefined();
    expect(worker.path).not.toBeNull();
  });

  it('a woodcutter cut off from his hut deposits nothing into it, and keeps the log', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    addResourceTile(world, 36, 30, TileResource.Wood, 6);
    const hut = addBuiltHut(world, 33, 30);
    const worker = world.units.get(hut.workerId!)!;
    runUntil(world, () => worker.task.t === UnitTaskKind.gatherHome && worker.carrying !== undefined);

    const held = hut.stock[GoodId.wood] ?? 0;
    strandFarAway(worker);
    tickWorld(world, []);

    expect(hut.stock[GoodId.wood] ?? 0).toBe(held); // nothing went through the wall
    expect(worker.carrying).toBe(GoodId.wood); // the log is not lost either
  });

  it('a recruit cut off from his post is not bound to it', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const hut = placeBuiltBuilding(world, BuildingTypeId.woodcutter, 0, 36, 30);
    const serf = addSerf(world, 34, 30);
    serf.task = { t: UnitTaskKind.staff, buildingId: hut.id };
    strandFarAway(serf);
    tickWorld(world, []);

    expect(hut.workerId).toBeUndefined(); // not staffed from across the map
    expect(serf.kind).toBe(UnitTypeId.serf); // and not turned into its worker
    expect(serf.task.t).toBe(UnitTaskKind.staff); // the post is still his to walk to
    expect(serf.path).not.toBeNull();
  });

  it('a recruit cut off from a barracks is not enlisted by it', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { [GoodId.food]: 10, [GoodId.sword]: 2 });
    const barracks = placeBuiltBuilding(world, BuildingTypeId.barracks, 0, 36, 30);
    barracks.trainQueue = [{ unit: UnitTypeId.knight, started: false, ticksLeft: 0 }];
    barracks.inputs = { [GoodId.food]: 3, [GoodId.sword]: 1 };
    const serf = addSerf(world, 34, 30);
    serf.task = { t: UnitTaskKind.staff, buildingId: barracks.id };
    strandFarAway(serf);
    tickWorld(world, []);

    // Being consumed into the queue kills the unit — from the far side of the
    // map that is a serf who walked into a building he never reached.
    expect(serf.dead).toBe(false);
    expect(barracks.trainQueue![0]!.started).toBe(false);
    expect(barracks.inputs[GoodId.sword]).toBe(1); // no ingredients spent either
  });
});
