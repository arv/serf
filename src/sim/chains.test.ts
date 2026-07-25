import { describe, expect, it } from 'vitest';
import { tileIdx } from '../shared/grid';
import { tickWorld } from './tick';
import { PathLevel, TileResource } from './map';
import { canPlace, placeBuiltBuilding, spawnUnit, type World } from './world';
import { PAVE_WEAR_THRESHOLD } from './defs/balance';
import { checkInvariants, checkLedger, countGoods } from './debug/invariants';
import { bindWorker } from './systems/production';
import { addSerf, addStorehouse, bareWorld } from './testUtils';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

describe('convert chains', () => {
  it('well produces water on a pure timer', () => {
    const world = bareWorld();
    const well = placeBuiltBuilding(world, 'well', 'player', 30, 30);
    run(world, 20 * 13); // durationTicks = 120
    expect(well.stock.water ?? 0).toBeGreaterThan(0);
  });

  it('paddy consumes hauled water and yields rice (well -> paddy -> storehouse)', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, {});
    placeBuiltBuilding(world, 'well', 'player', 26, 30);
    placeBuiltBuilding(world, 'ricePaddy', 'player', 34, 29);
    addSerf(world, 29, 34);
    addSerf(world, 33, 34);
    const initial = countGoods(world);
    run(world, 20 * 120);

    expect(sh.stock.rice ?? 0).toBeGreaterThan(0);
    expect(checkInvariants(world).violations).toEqual([]);
    expect(checkLedger(world, initial)).toEqual([]);
  });

  it('two-input recipe waits for both ingredients (brewery)', () => {
    const world = bareWorld();
    const brewery = placeBuiltBuilding(world, 'sakeBrewery', 'player', 30, 30);
    brewery.inputs.rice = 1; // no water yet
    run(world, 100);
    expect(brewery.stock.sake ?? 0).toBe(0);
    expect(brewery.inputs.rice).toBe(1); // nothing consumed

    brewery.inputs.water = 1;
    run(world, 20 * 16);
    expect(brewery.stock.sake).toBe(1);
    expect(brewery.inputs.rice ?? 0).toBe(0);
    expect(brewery.inputs.water ?? 0).toBe(0);
  });

  it('weapon chain: swordsmith turns iron+bamboo into katana', () => {
    const world = bareWorld();
    const smith = placeBuiltBuilding(world, 'swordsmith', 'player', 30, 30);
    smith.inputs.iron = 2;
    smith.inputs.bamboo = 1;
    run(world, 20 * 15);
    expect(smith.stock.katana).toBe(1);
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
    const mine = placeBuiltBuilding(world, 'ironMine', 'player', 30, 30);
    const miner = spawnUnit(world, 'worker', 'player', 30.5, 33.5);
    bindWorker(mine, miner);
    run(world, 20 * 60);

    expect(mine.stock.iron ?? 0).toBeGreaterThan(0);
    expect(world.map.resourceAmt[dep]).toBeLessThan(10);
  });
});

describe('stone-road paving', () => {
  it('paves sustained high-wear trails via stone hauls', () => {
    const world = bareWorld();
    world.pavingUnlocked = true;
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
    world.pavingUnlocked = false;
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
