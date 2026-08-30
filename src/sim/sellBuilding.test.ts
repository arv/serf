import {describe, expect, it} from 'vitest';
import * as CommandKind from './commandKindEnum.ts';
import {checkInvariants, checkLedger, countGoods} from './debug/invariants.ts';
import {buildingDef} from './defs/buildings.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as GoodId from './defs/goodIdEnum.ts';
import * as UnitTypeId from './defs/unitTypeIdEnum.ts';
import {
  addBuiltHut,
  addResourceTile,
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

/**
 * Selling a building: half the construction cost back (floored per good),
 * the resident walks out a serf, the goods piled outside the door walk
 * back to the stores, the footprint frees up. The escape hatch when the
 * village is built into a corner.
 */
describe('selling a building', () => {
  it('refunds half the cost, frees the worker and the ground', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, {[GoodId.wood]: 0});
    addResourceTile(world, 40, 30); // a grove in reach, or the hut is illegal ground
    const hut = addBuiltHut(world, 36, 30);
    hut.stock = {[GoodId.wood]: 4}; // the pile stacked outside the door
    const workerId = hut.workerId!;
    const initial = countGoods(world);

    tickWorld(
      world,
      cmds({kind: CommandKind.sellBuilding, buildingId: hut.id}),
    );
    run(world, 2);

    // Half the cost back, plus the gathered wood that stood stacked
    // outside — a sale wrecks the walls, not the yard.
    const cost = buildingDef(BuildingTypeId.woodcutter).cost[GoodId.wood]!;
    expect(sh.stock[GoodId.wood]).toBe(Math.floor(cost / 2) + 4);
    const worker = world.units.get(workerId)!;
    expect(worker.dead).toBe(false);
    expect(worker.kind).toBe(UnitTypeId.serf);
    expect(worker.homeId).toBeUndefined();
    expect(world.buildings.get(hut.id)).toBeUndefined();
    expect(canPlace(world.map, BuildingTypeId.woodcutter, 36, 30)).toBe(true);
    expect(checkInvariants(world).violations).toEqual([]);
    expect(checkLedger(world, initial)).toEqual([]);
  });

  it('a site refunds half of what was delivered, not half the price', () => {
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
    expect(sh.stock[GoodId.wood]).toBe(1); // floor(2 / 2)
    expect(world.buildings.get(site.id)).toBeUndefined();
  });

  it("a sold Smith's shelf and larder walk back to the stores", () => {
    // Everything the place holds is piled outside the door (the render
    // draws stock and inputs against the front wall), and a sale wrecks
    // the walls, not the yard: forged goods and unspent inputs alike are
    // moved to the storehouse, not destroyed with the building.
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, {
      [GoodId.wood]: 0,
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
    expect(sh.stock[GoodId.hammer]).toBe(3);
    expect(sh.stock[GoodId.axe]).toBe(2);
    expect(sh.stock[GoodId.iron]).toBe(2);
    expect(checkLedger(world, initial)).toEqual([]);
  });

  it("a sold site's borrowed hammer walks back to the stores", () => {
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
    tickWorld(
      world,
      cmds({kind: CommandKind.sellBuilding, buildingId: site.id}),
    );
    expect(sh.stock[GoodId.hammer]).toBe(1); // a move, not a refund
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
