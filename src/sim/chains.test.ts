import { describe, expect, it } from 'vitest';
import { tileIdx } from '../shared/grid.ts';
import { tickWorld } from './tick.ts';
import { PathLevel, TileResource } from './map.ts';
import { canPlace, placeBuiltBuilding, spawnUnit, type World } from './world.ts';
import { HIRE_SERF_COST, HIRE_SERF_TICKS, PAVE_WEAR_THRESHOLD } from './defs/balance.ts';
import { checkInvariants, checkLedger, countGoods } from './debug/invariants.ts';
import { bindWorker } from './systems/production.ts';
import { addSerf, addStorehouse, bareWorld, cmds, staffBuilding } from './testUtils.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

describe('convert chains', () => {
  it('well produces water on a pure timer', () => {
    const world = bareWorld();
    const well = placeBuiltBuilding(world, 'well', 0, 30, 30);
    staffBuilding(world, well);
    run(world, 20 * 13); // durationTicks = 120
    expect(well.stock.water ?? 0).toBeGreaterThan(0);
  });

  it('farm consumes hauled water and yields wheat (well -> farm -> storehouse)', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, {});
    staffBuilding(world, placeBuiltBuilding(world, 'well', 0, 26, 30));
    staffBuilding(world, placeBuiltBuilding(world, 'wheatFarm', 0, 34, 29));
    addSerf(world, 29, 34);
    addSerf(world, 33, 34);
    const initial = countGoods(world);
    run(world, 20 * 120);

    expect(sh.stock.wheat ?? 0).toBeGreaterThan(0);
    expect(checkInvariants(world).violations).toEqual([]);
    expect(checkLedger(world, initial)).toEqual([]);
  });

  it('two-input recipe waits for both ingredients (brewery)', () => {
    const world = bareWorld();
    const brewery = placeBuiltBuilding(world, 'brewery', 0, 30, 30);
    staffBuilding(world, brewery);
    brewery.inputs.wheat = 1; // no water yet
    run(world, 100);
    expect(brewery.stock.ale ?? 0).toBe(0);
    expect(brewery.inputs.wheat).toBe(1); // nothing consumed

    brewery.inputs.water = 1;
    run(world, 20 * 16);
    expect(brewery.stock.ale).toBe(1);
    expect(brewery.inputs.wheat ?? 0).toBe(0);
    expect(brewery.inputs.water ?? 0).toBe(0);
  });

  it('weapon chain: swordsmith turns iron+wood into sword', () => {
    const world = bareWorld();
    const smith = placeBuiltBuilding(world, 'swordsmith', 0, 30, 30);
    staffBuilding(world, smith);
    smith.inputs.iron = 2;
    smith.inputs.wood = 1;
    run(world, 20 * 15);
    expect(smith.stock.sword).toBe(1);
  });
});

describe('mine placement', () => {
  it('requires a matching deposit nearby', () => {
    const world = bareWorld();
    expect(canPlace(world.map, 'ironMine', 30, 30)).toBe(false);

    const dep = tileIdx(33, 31);
    world.map.resource[dep] = TileResource.IronDep;
    world.map.resourceAmt[dep] = 10;
    expect(canPlace(world.map, 'ironMine', 30, 30)).toBe(true);
    // A silver mine still can't go there.
    expect(canPlace(world.map, 'silverMine', 30, 30)).toBe(false);
  });

  it('miner works the seam like any gather building', () => {
    const world = bareWorld();
    const dep = tileIdx(33, 31);
    world.map.resource[dep] = TileResource.IronDep;
    world.map.resourceAmt[dep] = 10;
    const mine = placeBuiltBuilding(world, 'ironMine', 0, 30, 30);
    const miner = spawnUnit(world, 'worker', 0, 30.5, 33.5);
    bindWorker(mine, miner);
    run(world, 20 * 60);

    expect(mine.stock.iron ?? 0).toBeGreaterThan(0);
    expect(world.map.resourceAmt[dep]).toBeLessThan(10);
  });
});

describe('stone-road paving', () => {
  it('paves sustained high-wear trails via stone hauls', () => {
    const world = bareWorld();
    world.players[0]!.pavingUnlocked = true;
    addStorehouse(world, 30, 30, { stone: 10 });
    addSerf(world, 29, 34);

    // A hot trail tile: keep wear topped up like real traffic would.
    const idx = tileIdx(30, 36);
    world.map.pathLevel[idx] = PathLevel.Trail;
    for (let t = 0; t < 20 * 60; t++) {
      world.map.wear[idx] = PAVE_WEAR_THRESHOLD + 10;
      tickWorld(world, []);
      if (world.map.pathLevel[idx] === PathLevel.Road) break;
    }

    expect(world.map.pathLevel[idx]).toBe(PathLevel.Road);
    // The road site consumed a stone and removed itself.
    expect([...world.buildings.values()].filter((b) => b.type === 'roadSite')).toEqual([]);
    expect(world.map.buildingAt[idx]).toBe(-1);
    expect(world.map.blocked[idx]).toBe(0);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('does nothing while locked', () => {
    const world = bareWorld();
    world.players[0]!.pavingUnlocked = false;
    addStorehouse(world, 30, 30, { stone: 10 });
    const idx = tileIdx(30, 36);
    world.map.pathLevel[idx] = PathLevel.Trail;
    for (let t = 0; t < 300; t++) {
      world.map.wear[idx] = PAVE_WEAR_THRESHOLD + 10;
      tickWorld(world, []);
    }
    expect(world.map.pathLevel[idx]).toBe(PathLevel.Trail);
  });
});

describe('hiring a serf', () => {
  const serfCount = (world: World): number =>
    [...world.units.values()].filter((u) => !u.dead && u.kind === 'serf').length;

  it('charges up front and delivers the recruit after the wait', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, { silver: 10 });
    tickWorld(world, cmds({ kind: 'hireSerf' }));

    // Paid immediately, but nobody has walked in yet.
    expect(sh.stock.silver).toBe(10 - HIRE_SERF_COST);
    expect(sh.hireQueue).toBe(1);
    expect(serfCount(world)).toBe(0);

    for (let t = 0; t < HIRE_SERF_TICKS - 2; t++) tickWorld(world, []);
    expect(serfCount(world)).toBe(0);

    for (let t = 0; t < 3; t++) tickWorld(world, []);
    expect(serfCount(world)).toBe(1);
    expect(sh.hireQueue).toBe(0);
  });

  it('queues repeat orders and staggers their arrivals', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, { silver: 20 });
    tickWorld(world, cmds({ kind: 'hireSerf' }, { kind: 'hireSerf' }));
    expect(sh.hireQueue).toBe(2);
    expect(sh.stock.silver).toBe(20 - HIRE_SERF_COST * 2);

    for (let t = 0; t < HIRE_SERF_TICKS + 1; t++) tickWorld(world, []);
    expect(serfCount(world)).toBe(1); // the second is still on the road

    for (let t = 0; t < HIRE_SERF_TICKS + 1; t++) tickWorld(world, []);
    expect(serfCount(world)).toBe(2);
    expect(sh.hireQueue).toBe(0);
  });

  it('refuses orders it cannot afford, and never charges for them', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, { silver: HIRE_SERF_COST - 1 });
    tickWorld(world, cmds({ kind: 'hireSerf' }));
    expect(sh.hireQueue).toBeUndefined();
    expect(sh.stock.silver).toBe(HIRE_SERF_COST - 1);
  });
});
