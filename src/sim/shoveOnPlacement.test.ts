import {describe, expect, it} from 'vitest';
import {tileIdx} from '../shared/grid.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import {findPathToAdjacent} from './path.ts';
import {addSerf, addStorehouse, bareWorld} from './testUtils.ts';
import {placeSite} from './world.ts';

/**
 * Placement does not refuse ground with people standing on it — the ground
 * is the player's to build on. So the walls have to move the people.
 *
 * Left where they were, they are sealed in: every tile around them is the
 * new building, so they can reach nothing and nothing can reach them. The
 * cost of that is not one idle serf. `dispatch` offers each haul to the
 * nearest idle serf and blames the *job* when he cannot path to the pickup,
 * so a serf walled in halfway across a village is the nearest candidate for
 * haul after haul and blocks every one of them.
 */
describe('a building raised on top of somebody', () => {
  it('moves him outside its walls', () => {
    const world = bareWorld();
    // The centre tile of a 3x3 — the barracks, not the 2x2 woodcutter,
    // because only a 3x3 truly seals somebody in. On a 2x2 he stands at a
    // corner and walks out diagonally, which is why this has to be the
    // shape the real case was: two serfs on the middle tile of a wheat
    // farm's 3x3.
    const serf = addSerf(world, 31, 31);
    const b = placeSite(world, BuildingTypeId.barracks, 0, 30, 30);

    const inside =
      serf.x >= b.x &&
      serf.x < b.x + b.w &&
      serf.y >= b.y &&
      serf.y < b.y + b.h;
    expect(inside).toBe(false);
    // And onto ground he can actually stand on.
    const idx = tileIdx(Math.floor(serf.x), Math.floor(serf.y), world.map.size);
    expect(world.map.blocked[idx]).toBeFalsy();
  });

  it('leaves him able to reach the rest of the village', () => {
    const world = bareWorld();
    const store = addStorehouse(world, 20, 20, {});
    const serf = addSerf(world, 31, 31);
    placeSite(world, BuildingTypeId.barracks, 0, 30, 30);

    // The failure this guards is not "he is stuck" but "logistics stops":
    // an unreachable serf is picked as nearest and the job is penalised.
    const path = findPathToAdjacent(
      world.map,
      Math.floor(serf.x),
      Math.floor(serf.y),
      store.x,
      store.y,
      store.w,
      store.h,
    );
    expect(path).not.toBeNull();
  });

  it('leaves alone anyone outside the footprint', () => {
    const world = bareWorld();
    const bystander = addSerf(world, 34, 34);
    const {x, y} = {x: bystander.x, y: bystander.y};
    placeSite(world, BuildingTypeId.barracks, 0, 30, 30);
    expect(bystander.x).toBe(x);
    expect(bystander.y).toBe(y);
  });
});
