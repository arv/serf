import {describe, expect, it} from 'vitest';
import {checkInvariants, checkLedger, countGoods} from './debug/invariants.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as GoodId from './defs/goodIdEnum.ts';
import type {Building} from './entities.ts';
import {
  addBuiltHut,
  addResourceTile,
  addSerf,
  addStorehouse,
  bareWorld,
} from './testUtils.ts';
import {tickWorld} from './tick.ts';
import {destroyBuilding, killUnit, type World} from './world.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

function salvagePiles(world: World): Building[] {
  return [...world.buildings.values()].filter(
    b => !b.dead && b.type === BuildingTypeId.salvage,
  );
}

/**
 * What the fallen held does not die with them: a killed serf drops the
 * good on his shoulders, a killed resident worker drops the tool he took
 * up — each as a salvage pile where he fell, for whoever is left to cart
 * home. The razed building itself still burns its stores (a sacking is
 * not a sale); the drops are the men's, not the walls'.
 */
describe('death drops', () => {
  it("a razed hut burns its stores, but its worker's axe falls with him", () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, {
      [GoodId.wood]: 0,
      [GoodId.axe]: 0,
    });
    addResourceTile(world, 40, 30);
    const hut = addBuiltHut(world, 36, 30);
    hut.stock = {[GoodId.wood]: 3};
    const worker = world.units.get(hut.workerId!)!;
    const initial = countGoods(world);

    destroyBuilding(world, hut); // the raid, not the wreckers

    // The hut's pile burns with the walls...
    expect(world.ledger.consumed[GoodId.wood]).toBe(3);
    // ...but the axe the worker held falls where he stood.
    const piles = salvagePiles(world);
    expect(piles).toHaveLength(1);
    expect(piles[0]!.stock[GoodId.axe]).toBe(1);
    expect(piles[0]!.x).toBe(Math.floor(worker.x));
    expect(piles[0]!.y).toBe(Math.floor(worker.y));
    expect(worker.dead).toBe(true);
    expect(checkLedger(world, initial)).toEqual([]);

    // A surviving hand carts it home, and the pile clears itself.
    addSerf(world, 33, 30);
    run(world, 1500);
    expect(sh.stock[GoodId.axe]).toBe(1);
    expect(salvagePiles(world)).toHaveLength(0);
    expect(checkInvariants(world).violations).toEqual([]);
    expect(checkLedger(world, initial)).toEqual([]);
  });

  it('two carriers falling on the same tile share one pile', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {[GoodId.wood]: 0});
    const a = addSerf(world, 40, 40);
    const b = addSerf(world, 40, 40);
    a.carrying = GoodId.wood;
    b.carrying = GoodId.wood;
    const initial = countGoods(world);

    killUnit(world, a);
    killUnit(world, b);

    const piles = salvagePiles(world);
    expect(piles).toHaveLength(1);
    expect(piles[0]!.stock[GoodId.wood]).toBe(2);
    // A move to the ground, not a loss: nothing ledgered.
    expect(world.ledger.consumed[GoodId.wood] ?? 0).toBe(0);
    expect(checkLedger(world, initial)).toEqual([]);
  });
});
