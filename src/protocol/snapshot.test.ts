import { describe, expect, it } from 'vitest';
import { snapBuilding } from './snapshot.ts';
import { findResourceNear } from '../sim/map.ts';
import { addBuiltHut, addResourceTile, addStorehouse, bareWorld } from '../sim/testUtils.ts';
import * as TileResource from '../sim/tileResourceEnum.ts';

/**
 * The reach readout: what a gatherer's card says is left in the ground
 * around it. It has to mean exactly what the gather loop will hand its
 * worker — a number that counts a tree the worker may not touch is worse
 * than no number, because the hut then stands idle in front of it.
 */
describe('snapBuilding: resourceLeft', () => {
  it('sums the workable tiles inside the search square and nothing outside it', () => {
    const world = bareWorld();
    // A 2x2 hut at (30,30) searches from its center tile (31,31), 8 out.
    const hut = addBuiltHut(world, 30, 30, false);
    addResourceTile(world, 39, 31, TileResource.Wood, 6); // the far edge: in
    addResourceTile(world, 40, 31, TileResource.Wood, 6); // one past it: out
    addResourceTile(world, 33, 33, TileResource.Rock, 6); // in reach, wrong good
    addResourceTile(world, 33, 30, TileResource.Wood, 4);

    expect(snapBuilding(world, hut).resourceLeft).toBe(10);
  });

  it('falls to zero exactly when the gather search runs dry', () => {
    const world = bareWorld();
    const hut = addBuiltHut(world, 30, 30, false);
    addResourceTile(world, 33, 33, TileResource.Wood, 1);
    expect(snapBuilding(world, hut).resourceLeft).toBe(1);

    // Worked out: the same state a felled tile is left in mid-trip, before
    // depleteResourceTile clears the code.
    world.map.resourceAmt[33 + 33 * world.map.size] = 0;
    expect(snapBuilding(world, hut).resourceLeft).toBe(0);
    expect(findResourceNear(world.map, 31, 31, TileResource.Wood, 8)).toBe(-1);
  });

  it('is absent for buildings that work no land', () => {
    const world = bareWorld();
    const store = addStorehouse(world, 20, 20, {});
    expect(snapBuilding(world, store).resourceLeft).toBeUndefined();
  });
});
