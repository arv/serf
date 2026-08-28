import { describe, expect, it } from 'vitest';
import { tickWorld } from './tick.ts';
import { placeBuiltBuilding, type World } from './world.ts';
import { buildingDef, repairBill } from './defs/buildings.ts';
import { REPAIR_MEND_TICKS } from './defs/balance.ts';
import { checkInvariants, checkLedger, countGoods } from './debug/invariants.ts';
import {
  addBuiltHut,
  addResourceTile,
  addSerf,
  addSite,
  addStorehouse,
  bareWorld,
  cmds,
  staffBuilding,
} from './testUtils.ts';
import { GoodId } from './defs/goods.ts';
import { BuildingTypeId } from './defs/buildings.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

/**
 * Tick until the repair is finished — the bill settled AND the masons done
 * with what it bought — or give up.
 */
function runRepair(world: World, id: number, limit = 2000): number {
  let ticks = 0;
  while (ticks++ < limit) {
    const b = world.buildings.get(id);
    if (b?.repairNeeds === undefined && b?.repairPending === undefined) break;
    tickWorld(world, []);
  }
  return ticks;
}

/**
 * Repairing a damaged building: an order, a material bill scaled to the
 * damage, hauls that carry it over, and masons who work it in over the
 * seconds that follow. The alternative to watching a raided village decay —
 * and cheaper than tearing each ruin down and paying full price to raise it
 * again.
 */
describe('repairing a building', () => {
  it('hauls in materials and mends as they are worked in', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, { [GoodId.wood]: 20 });
    // No grove in reach: the woodcutter's own axe must not add planks to the
    // pile this test is counting.
    const hut = addBuiltHut(world, 36, 30);
    for (let i = 0; i < 3; i++) addSerf(world, 33, 33 + i);
    const max = buildingDef(BuildingTypeId.woodcutter).hp;
    hut.hp = max * 0.2;
    const initial = countGoods(world);

    tickWorld(world, cmds({ kind: 'setBuildingRepair', buildingId: hut.id, repair: true }));
    // Half the build price, scaled by the four fifths that is broken.
    expect(hut.repairNeeds).toEqual({ [GoodId.wood]: Math.ceil(6 * 0.8 * 0.5) });

    runRepair(world, hut.id);
    expect(hut.hp).toBe(max);
    expect(sh.stock[GoodId.wood]).toBe(20 - 3);
    expect(checkInvariants(world).violations).toEqual([]);
    expect(checkLedger(world, initial)).toEqual([]);
  });

  it('bills the castle against its notional price', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, { [GoodId.wood]: 40, [GoodId.stone]: 40 });
    const max = buildingDef(BuildingTypeId.storehouse).hp;
    sh.hp = max / 2;
    for (let i = 0; i < 4; i++) addSerf(world, 34, 34 + i);

    // The keep costs nothing to raise, so `cost` cannot price its repair.
    expect(buildingDef(BuildingTypeId.storehouse).cost).toEqual({});
    expect(repairBill(BuildingTypeId.storehouse, max / 2)).toEqual({ [GoodId.wood]: 5, [GoodId.stone]: 3 });

    // ...and it is repaired out of the pile inside it: nobody carries a plank
    // out of the castle door to hand it back in through the same door, and
    // no haul could, since a job's source is never its destination.
    tickWorld(world, cmds({ kind: 'setBuildingRepair', buildingId: sh.id, repair: true }));
    expect(sh.repairNeeds).toBeUndefined(); // the whole bill was settled at once
    expect(sh.stock[GoodId.wood]).toBe(35);
    expect(sh.stock[GoodId.stone]).toBe(37);
    expect(world.jobs.size).toBe(0);

    // The goods are spent, but the wall is not back yet: the masons have
    // 375 hp to put on at 750/REPAIR_MEND_TICKS a tick, less the one tick
    // of it they did on the tick the order landed.
    expect(sh.repairPending).toBeCloseTo(max / 2 - max / REPAIR_MEND_TICKS);
    expect(sh.hp).toBeLessThan(max);
    const ticks = runRepair(world, sh.id);
    expect(sh.hp).toBe(max);
    expect(ticks).toBeCloseTo(REPAIR_MEND_TICKS / 2, -1);
  });

  it('takes time even when every material is already on site', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, { [GoodId.wood]: 40, [GoodId.stone]: 40 });
    const max = buildingDef(BuildingTypeId.storehouse).hp;
    sh.hp = max - 40;

    tickWorld(world, cmds({ kind: 'setBuildingRepair', buildingId: sh.id, repair: true }));
    const rate = max / REPAIR_MEND_TICKS;
    // One tick of masonry per tick, and no more — a 40 hp scratch is half a
    // second of work, not a step change on the tick it is paid.
    expect(sh.hp).toBeCloseTo(max - 40 + rate);
    run(world, 5);
    expect(sh.hp).toBeCloseTo(max - 40 + rate * 6);
    expect(sh.hp).toBeLessThan(max);

    runRepair(world, sh.id);
    expect(sh.hp).toBe(max);
    expect(sh.repairPending).toBeUndefined();
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('re-ordering mid-mend bills only the damage nobody has paid for', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, { [GoodId.wood]: 40, [GoodId.stone]: 40 });
    const max = buildingDef(BuildingTypeId.storehouse).hp;
    sh.hp = max / 2;

    tickWorld(world, cmds({ kind: 'setBuildingRepair', buildingId: sh.id, repair: true }));
    const spent = { [GoodId.wood]: sh.stock[GoodId.wood], [GoodId.stone]: sh.stock[GoodId.stone] };

    // The masons are still at work and the building still reads as damaged,
    // but every point of that damage is bought: a second order takes nothing.
    run(world, 20);
    tickWorld(world, cmds({ kind: 'setBuildingRepair', buildingId: sh.id, repair: true }));
    expect(sh.repairNeeds).toBeUndefined();
    expect(sh.stock[GoodId.wood]).toBe(spent[GoodId.wood]);
    expect(sh.stock[GoodId.stone]).toBe(spent[GoodId.stone]);

    // Fresh damage on top of a running mend is a fresh bill, though.
    sh.hp -= 100;
    tickWorld(world, cmds({ kind: 'setBuildingRepair', buildingId: sh.id, repair: true }));
    expect(sh.stock[GoodId.wood]).toBeLessThan(spent[GoodId.wood]!);
    runRepair(world, sh.id);
    expect(sh.hp).toBe(max);
  });

  it('mends only the damage the order was given for', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { [GoodId.wood]: 20 });
    const hut = addBuiltHut(world, 36, 30);
    for (let i = 0; i < 3; i++) addSerf(world, 33, 33 + i);
    const max = buildingDef(BuildingTypeId.woodcutter).hp;
    hut.hp = max / 2;

    tickWorld(world, cmds({ kind: 'setBuildingRepair', buildingId: hut.id, repair: true }));
    hut.hp -= 30; // the raiders come back while the masons are walking over

    runRepair(world, hut.id);
    // The bill bought back the 75 hp it was struck for, and not a point more:
    // the fresh 30 wants a fresh order.
    expect(hut.hp).toBe(max - 30);

    tickWorld(world, cmds({ kind: 'setBuildingRepair', buildingId: hut.id, repair: true }));
    runRepair(world, hut.id);
    expect(hut.hp).toBe(max);
  });

  it('calling it off stands the hauls down without burning the goods', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, { [GoodId.wood]: 20 });
    const hut = addBuiltHut(world, 36, 30);
    addSerf(world, 33, 33);
    hut.hp = 20;
    const initial = countGoods(world);

    tickWorld(world, cmds({ kind: 'setBuildingRepair', buildingId: hut.id, repair: true }));
    run(world, 10); // a serf is on the road with a plank by now
    expect(world.jobs.size).toBeGreaterThan(0);

    tickWorld(world, cmds({ kind: 'setBuildingRepair', buildingId: hut.id, repair: false }));
    expect(hut.repairNeeds).toBeUndefined();
    expect(hut.inbound[GoodId.wood] ?? 0).toBe(0);

    // Whatever was in hand walks home rather than evaporating. Any plank
    // that had already been worked in stays worked in, so the hut is no
    // worse off than when the order was given.
    run(world, 300);
    expect(sh.stock[GoodId.wood]).toBe(20);
    expect(hut.hp).toBe(20);
    expect(hut.repairPending).toBeUndefined();
    expect(checkInvariants(world).violations).toEqual([]);
    expect(checkLedger(world, initial)).toEqual([]);
  });

  it('re-ordering re-strikes the bill instead of stacking one', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { [GoodId.wood]: 20 });
    const hut = addBuiltHut(world, 36, 30);
    hut.hp = 30;

    tickWorld(world, cmds({ kind: 'setBuildingRepair', buildingId: hut.id, repair: true }));
    const first = { ...hut.repairNeeds };
    run(world, 5); // the matcher books the hauls
    tickWorld(world, cmds({ kind: 'setBuildingRepair', buildingId: hut.id, repair: true }));

    expect(hut.repairNeeds).toEqual(first);
    // The old order's reservations went with it — no double booking.
    expect(hut.inbound[GoodId.wood] ?? 0).toBeLessThanOrEqual(hut.repairNeeds![GoodId.wood]!);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it("calling it off leaves the building's other deliveries walking", () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { [GoodId.wood]: 20, [GoodId.stone]: 10, [GoodId.iron]: 6 });
    const smith = placeBuiltBuilding(world, BuildingTypeId.weaponsmith, 0, 36, 30);
    smith.recipeIndex = 0; // pinned on spears (default is auto)
    staffBuilding(world, smith);
    smith.hp = 100;

    // The smith forges from wood and mends with wood, so both errands book
    // hauls of the same good to the same door.
    tickWorld(world, cmds({ kind: 'setBuildingRepair', buildingId: smith.id, repair: true }));
    run(world, 5); // the matcher books them
    const woodJobs = () => [...world.jobs.values()].filter((j) => j.to === smith.id && j.good === GoodId.wood);
    expect(woodJobs().filter((j) => j.repair).length).toBe(smith.repairNeeds![GoodId.wood]);
    const forging = woodJobs().filter((j) => !j.repair).length;
    expect(forging).toBeGreaterThan(0);

    tickWorld(world, cmds({ kind: 'setBuildingRepair', buildingId: smith.id, repair: false }));
    expect(woodJobs().filter((j) => j.repair)).toEqual([]);
    expect(woodJobs().length).toBe(forging); // the forge's wood is still coming
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('refuses what has nothing to mend: whole buildings, sites, rivals', () => {
    const world = bareWorld(1, 2);
    addStorehouse(world, 30, 30, { [GoodId.wood]: 20 });
    addResourceTile(world, 40, 30);
    const hut = addBuiltHut(world, 36, 30);
    const site = addSite(world, 44, 30);

    tickWorld(world, cmds({ kind: 'setBuildingRepair', buildingId: hut.id, repair: true }));
    expect(hut.repairNeeds).toBeUndefined(); // undamaged

    site.hp = 5;
    tickWorld(world, cmds({ kind: 'setBuildingRepair', buildingId: site.id, repair: true }));
    expect(site.repairNeeds).toBeUndefined(); // a site heals as it rises

    hut.hp = 30;
    tickWorld(world, [
      { playerId: 1, cmd: { kind: 'setBuildingRepair', buildingId: hut.id, repair: true } },
    ]);
    expect(hut.repairNeeds).toBeUndefined(); // not your building
  });

  it('a repaired workshop keeps working, and its inputs keep flowing', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, { [GoodId.wood]: 30, [GoodId.stone]: 10, [GoodId.iron]: 8 });
    const smith = placeBuiltBuilding(world, BuildingTypeId.weaponsmith, 0, 36, 30);
    smith.recipeIndex = 0; // pinned on spears (default is auto)
    staffBuilding(world, smith);
    for (let i = 0; i < 4; i++) addSerf(world, 33, 33 + i);
    smith.hp = 40;
    const initial = countGoods(world);

    // Wood is both what the smith forges with and what mends it; the two
    // demands share a building and a good without confusing each other.
    tickWorld(world, cmds({ kind: 'setBuildingRepair', buildingId: smith.id, repair: true }));
    runRepair(world, smith.id);
    expect(smith.hp).toBe(buildingDef(BuildingTypeId.weaponsmith).hp);

    let guard = 0;
    while ((smith.stock[GoodId.spear] ?? 0) === 0 && guard++ < 4000) tickWorld(world, []);
    expect(smith.stock[GoodId.spear] ?? 0).toBeGreaterThan(0);
    expect(sh.stock[GoodId.wood] ?? 0).toBeLessThan(30);
    expect(checkInvariants(world).violations).toEqual([]);
    expect(checkLedger(world, initial)).toEqual([]);
  });
});

describe('the repair bill', () => {
  it('scales with the damage and is never free', () => {
    const max = buildingDef(BuildingTypeId.barracks).hp;
    expect(repairBill(BuildingTypeId.barracks, max)).toEqual({ [GoodId.wood]: 6, [GoodId.stone]: 4 }); // half of 12/8
    expect(repairBill(BuildingTypeId.barracks, max / 2)).toEqual({ [GoodId.wood]: 3, [GoodId.stone]: 2 });
    // A scratch still costs a plank: the mason does not work for nothing.
    expect(repairBill(BuildingTypeId.barracks, 1)).toEqual({ [GoodId.wood]: 1, [GoodId.stone]: 1 });
    expect(repairBill(BuildingTypeId.barracks, 0)).toEqual({});
  });
});
