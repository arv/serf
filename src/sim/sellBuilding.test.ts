import {describe, expect, it} from 'vitest';
import * as CommandKind from './commandKindEnum.ts';
import {checkInvariants, checkLedger, countGoods} from './debug/invariants.ts';
import {buildingDef} from './defs/buildings.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as GoodId from './defs/goodIdEnum.ts';
import * as UnitTypeId from './defs/unitTypeIdEnum.ts';
import type {Building} from './entities.ts';
import {
  addBuiltHut,
  addResourceTile,
  addSerf,
  addSite,
  addStorehouse,
  bareWorld,
  cmds,
} from './testUtils.ts';
import {tickWorld} from './tick.ts';
import {canPlace, placeBuiltBuilding, type World} from './world.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

function findSalvage(world: World): Building | undefined {
  for (const b of world.buildings.values()) {
    if (!b.dead && b.type === BuildingTypeId.salvage) return b;
  }
  return undefined;
}

/**
 * Selling a building: the resident walks out a serf, and NOTHING teleports
 * — half the construction cost (floored per good) plus everything the
 * building held is left as a salvage pile on the wreck's own footprint,
 * for serfs to cart home through the ordinary evacuation hauls. The ground
 * frees up when the last good leaves. The escape hatch when the village is
 * built into a corner.
 */
describe('selling a building', () => {
  it('leaves salvage on the field, and serfs cart it home', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, {[GoodId.wood]: 0});
    addResourceTile(world, 40, 30); // a grove in reach, or the hut is illegal ground
    const hut = addBuiltHut(world, 36, 30);
    hut.stock = {[GoodId.wood]: 4}; // the pile stacked in the yard
    const workerId = hut.workerId!;
    const initial = countGoods(world);

    tickWorld(
      world,
      cmds({kind: CommandKind.sellBuilding, buildingId: hut.id}),
    );

    // Nothing arrives by magic: the stores are untouched, and the salvage
    // — half the cost plus the stacked wood — lies where the hut stood.
    const cost = buildingDef(BuildingTypeId.woodcutter).cost[GoodId.wood]!;
    expect(sh.stock[GoodId.wood]).toBe(0);
    const pile = findSalvage(world)!;
    expect(pile).toBeDefined();
    expect(pile.stock[GoodId.wood]).toBe(Math.floor(cost / 2) + 4);
    expect(pile.x).toBe(hut.x);
    expect(pile.y).toBe(hut.y);
    expect(pile.w).toBe(hut.w);
    expect(pile.h).toBe(hut.h);
    // The ground stays claimed while goods lie on it...
    expect(canPlace(world.map, BuildingTypeId.woodcutter, 36, 30)).toBe(false);
    const worker = world.units.get(workerId)!;
    expect(worker.dead).toBe(false);
    expect(worker.kind).toBe(UnitTypeId.serf);
    expect(worker.homeId).toBeUndefined();
    expect(world.buildings.get(hut.id)).toBeUndefined();
    expect(checkInvariants(world).violations).toEqual([]);
    expect(checkLedger(world, initial)).toEqual([]);

    // A pile is not sellable in turn — there is no refund of a refund.
    tickWorld(
      world,
      cmds({kind: CommandKind.sellBuilding, buildingId: pile.id}),
    );
    expect(findSalvage(world)).toBeDefined();

    // ...until the freed hand has carted every last plank to the stores,
    // whereupon the pile clears itself and gives the ground back.
    run(world, 4000);
    expect(sh.stock[GoodId.wood]).toBe(Math.floor(cost / 2) + 4);
    expect(findSalvage(world)).toBeUndefined();
    expect(canPlace(world.map, BuildingTypeId.woodcutter, 36, 30)).toBe(true);
    expect(checkInvariants(world).violations).toEqual([]);
    expect(checkLedger(world, initial)).toEqual([]);
  });

  it('a site leaves half of what was delivered, not half the price', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, {[GoodId.wood]: 0});
    const site = addSite(world, 36, 30);
    // Two of six planks delivered so far.
    site.siteNeeds = {
      [GoodId.wood]:
        (buildingDef(BuildingTypeId.woodcutter).cost[GoodId.wood] ?? 0) - 2,
    };
    tickWorld(
      world,
      cmds({kind: CommandKind.sellBuilding, buildingId: site.id}),
    );
    expect(sh.stock[GoodId.wood]).toBe(0);
    expect(findSalvage(world)!.stock[GoodId.wood]).toBe(1); // floor(2 / 2)
    expect(world.buildings.get(site.id)).toBeUndefined();
  });

  it('a sale that leaves nothing frees the ground immediately', () => {
    // A fresh site with not a plank delivered yields no salvage at all —
    // an empty pile would claim ground for nothing.
    const world = bareWorld();
    addStorehouse(world, 30, 30, {[GoodId.wood]: 0});
    addResourceTile(world, 40, 30);
    const site = addSite(world, 36, 30);
    tickWorld(
      world,
      cmds({kind: CommandKind.sellBuilding, buildingId: site.id}),
    );
    expect(findSalvage(world)).toBeUndefined();
    expect(canPlace(world.map, BuildingTypeId.woodcutter, 36, 30)).toBe(true);
  });

  it("a sold Smith's shelf and larder ride the pile home", () => {
    // Forged stock, unspent inputs and the wreck's own materials alike:
    // everything the place held lies in the salvage, and a serf carries
    // it home good by good — a move, not a mint.
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, {
      [GoodId.wood]: 0,
      [GoodId.stone]: 0,
      [GoodId.hammer]: 0,
      [GoodId.axe]: 0,
      [GoodId.iron]: 0,
    });
    const smith = placeBuiltBuilding(
      world,
      BuildingTypeId.weaponsmith,
      0,
      36,
      30,
    );
    smith.stock = {[GoodId.hammer]: 3, [GoodId.axe]: 2};
    smith.inputs = {[GoodId.iron]: 2};
    const initial = countGoods(world);
    tickWorld(
      world,
      cmds({kind: CommandKind.sellBuilding, buildingId: smith.id}),
    );
    const pile = findSalvage(world)!;
    expect(pile.stock[GoodId.hammer]).toBe(3);
    expect(pile.stock[GoodId.axe]).toBe(2);
    expect(pile.stock[GoodId.iron]).toBe(2);
    expect(pile.stock[GoodId.wood]).toBe(5); // floor(10 / 2)
    expect(pile.stock[GoodId.stone]).toBe(3); // floor(6 / 2)
    expect(sh.stock[GoodId.hammer]).toBe(0);
    expect(checkLedger(world, initial)).toEqual([]);

    addSerf(world, 33, 30);
    run(world, 6000);
    expect(sh.stock[GoodId.hammer]).toBe(3);
    expect(sh.stock[GoodId.axe]).toBe(2);
    expect(sh.stock[GoodId.iron]).toBe(2);
    expect(sh.stock[GoodId.wood]).toBe(5);
    expect(sh.stock[GoodId.stone]).toBe(3);
    expect(findSalvage(world)).toBeUndefined();
    expect(checkLedger(world, initial)).toEqual([]);
  });

  it("a sold site's borrowed hammer rides the pile back to the stores", () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, {
      [GoodId.wood]: 0,
      [GoodId.hammer]: 0,
    });
    const site = addSite(world, 36, 30);
    site.siteNeeds = {
      [GoodId.wood]:
        buildingDef(BuildingTypeId.woodcutter).cost[GoodId.wood] ?? 0,
    };
    site.inputs = {[GoodId.hammer]: 1}; // the loan, delivered and waiting
    const initial = countGoods(world);
    tickWorld(
      world,
      cmds({kind: CommandKind.sellBuilding, buildingId: site.id}),
    );
    expect(findSalvage(world)!.stock[GoodId.hammer]).toBe(1);

    addSerf(world, 33, 30);
    run(world, 1500);
    expect(sh.stock[GoodId.hammer]).toBe(1); // a move, not a mint
    expect(findSalvage(world)).toBeUndefined();
    expect(checkLedger(world, initial)).toEqual([]);
  });

  it('a rival cannot sell your buildings, and nobody sells a storehouse', () => {
    const world = bareWorld(1, 2);
    const sh = addStorehouse(world, 30, 30, {[GoodId.wood]: 0});
    const hut = addBuiltHut(world, 36, 30);
    tickWorld(world, [
      {playerId: 1, cmd: {kind: CommandKind.sellBuilding, buildingId: hut.id}},
    ]);
    expect(world.buildings.get(hut.id)).toBeDefined();

    tickWorld(world, cmds({kind: CommandKind.sellBuilding, buildingId: sh.id}));
    expect(world.buildings.get(sh.id)).toBeDefined();
  });
});
