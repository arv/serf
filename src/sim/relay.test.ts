import {describe, expect, it} from 'vitest';
import {checkInvariants, checkLedger, countGoods} from './debug/invariants.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as GoodId from './defs/goodIdEnum.ts';
import * as HaulPhase from './haulPhaseEnum.ts';
import {addBuiltHut, addSerf, addStorehouse, bareWorld} from './testUtils.ts';
import {tickWorld} from './tick.ts';
import {placeBuiltBuilding} from './world.ts';

/** A woodcutter's hut 24 tiles from the castle, with planks on its shelf,
 * a relay post halfway, and a serf at each end. */
function longHaul(relay = true) {
  const world = bareWorld();
  const castle = addStorehouse(world, 40, 30, {});
  const hut = addBuiltHut(world, 16, 30, false);
  hut.stock[GoodId.wood] = 3;
  const post = relay
    ? placeBuiltBuilding(world, BuildingTypeId.relayPost, 0, 28, 31)
    : undefined;
  const out = addSerf(world, 18, 31);
  const home = addSerf(world, 37, 33);
  return {world, castle, hut, post, out, home, start: countGoods(world)};
}

describe('relay posts', () => {
  it('split a long haul in two and hand the second leg on', () => {
    const {world, castle, post, out, home, start} = longHaul();
    let handed = false;
    const carriers = new Set<number>();
    for (let i = 0; i < 3000 && (castle.stock[GoodId.wood] ?? 0) < 3; i++) {
      tickWorld(world, []);
      for (const job of world.jobs.values()) {
        if (job.from === post!.id) handed = true;
        if (job.phase === HaulPhase.toDropoff && job.serfId !== undefined)
          carriers.add(job.serfId);
      }
      expect(checkInvariants(world).violations).toEqual([]);
    }
    expect(handed).toBe(true);
    expect(castle.stock[GoodId.wood]).toBe(3);
    // Both men carried: the one out by the woods to the post, and the one
    // at home from it.
    expect(carriers).toEqual(new Set([out.id, home.id]));
    expect(post!.stock[GoodId.wood] ?? 0).toBe(0);
    expect(checkLedger(world, start)).toEqual([]);
  });

  it('are passed by when there is none on the way', () => {
    const {world, castle} = longHaul(false);
    for (let i = 0; i < 3000 && (castle.stock[GoodId.wood] ?? 0) < 3; i++)
      tickWorld(world, []);
    expect(castle.stock[GoodId.wood]).toBe(3);
  });

  it('send home whatever is left on one that nobody is coming for', () => {
    const {world, castle, post, start} = longHaul();
    post!.stock[GoodId.stone] = 2;
    const before = {...start, [GoodId.stone]: 2};
    for (let i = 0; i < 3000 && (castle.stock[GoodId.stone] ?? 0) < 2; i++)
      tickWorld(world, []);
    expect(castle.stock[GoodId.stone]).toBe(2);
    expect(checkLedger(world, before)).toEqual([]);
  });
});
