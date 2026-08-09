import { describe, expect, it } from 'vitest';
import { tileIdx } from '../shared/grid.ts';
import { tickWorld } from './tick.ts';
import { PathLevel, Terrain, TileResource } from './map.ts';
import {
  canPlace,
  depleteResourceTile,
  placeBuiltBuilding,
  spawnUnit,
  type World,
} from './world.ts';
import { HIRE_SERF_COST, HIRE_SERF_TICKS, PAVE_WEAR_THRESHOLD } from './defs/balance.ts';
import { checkInvariants, checkLedger, countGoods } from './debug/invariants.ts';
import { bindWorker } from './systems/production.ts';
import {
  addResourceTile,
  addSerf,
  addStorehouse,
  bareWorld,
  cmds,
  staffBuilding,
} from './testUtils.ts';

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

  it('mill and bakery turn wheat into the food a soldier costs', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, { wheat: 6, water: 6 });
    staffBuilding(world, placeBuiltBuilding(world, 'mill', 0, 26, 30));
    staffBuilding(world, placeBuiltBuilding(world, 'bakery', 0, 34, 30));
    addSerf(world, 29, 33);
    addSerf(world, 33, 33);
    run(world, 20 * 90);

    // Grain went up the chain and bread came back down it.
    expect(sh.stock.food ?? 0).toBeGreaterThan(0);
    expect(sh.stock.wheat ?? 0).toBeLessThan(6);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('the mill grinds without a resident (the wind does the work)', () => {
    const world = bareWorld();
    const mill = placeBuiltBuilding(world, 'mill', 0, 30, 30);
    mill.inputs.wheat = 2;
    expect(mill.workerId).toBeUndefined();
    run(world, 20 * 20);
    expect(mill.stock.flour ?? 0).toBeGreaterThan(0);
  });

  it('the fishery needs a shore, and turns to face it', () => {
    const world = bareWorld();
    // bareWorld is all grass: inland placement must be refused...
    expect(canPlace(world.map, 'fishery', 30, 30)).toBe(false);

    // ...and water two tiles off is still inland. The pier is part of the
    // building, so the rule is "touching", not "near".
    for (let tx = 29; tx < 35; tx++) {
      const i = tileIdx(tx, 27);
      world.map.terrain[i] = Terrain.Water;
      world.map.blocked[i] = 1;
    }
    expect(canPlace(world.map, 'fishery', 30, 30)).toBe(false);

    // The same two tiles off the *south* edge, which is the side the bounds
    // were once wrong on: the box ran a tile past the radius on the high
    // side only, so this placement was accepted and the pier then pointed
    // inland (waterFacing, searching the correct box, found nothing and
    // fell back to facing 0).
    for (let tx = 29; tx < 35; tx++) {
      const i = tileIdx(tx, 34); // footprint y = 30..32, so this is 2 off
      world.map.terrain[i] = Terrain.Water;
      world.map.blocked[i] = 1;
    }
    expect(canPlace(world.map, 'fishery', 30, 30)).toBe(false);
    // ...and two off the east edge (footprint x = 30..32).
    for (let ty = 29; ty < 35; ty++) {
      const i = tileIdx(34, ty);
      world.map.terrain[i] = Terrain.Water;
      world.map.blocked[i] = 1;
    }
    expect(canPlace(world.map, 'fishery', 30, 30)).toBe(false);

    // Water along the footprint's north edge (y = 29, footprint y = 30..32).
    for (let tx = 29; tx < 35; tx++) {
      const i = tileIdx(tx, 29);
      world.map.terrain[i] = Terrain.Water;
      world.map.blocked[i] = 1;
    }
    expect(canPlace(world.map, 'fishery', 30, 30)).toBe(true);

    const fishery = placeBuiltBuilding(world, 'fishery', 0, 30, 30);
    // Water lies at -z, so the pier turns half a circle to reach it.
    expect(fishery.facing).toBe(2);

    staffBuilding(world, fishery);
    run(world, 20 * 26);
    // No inputs at all — a coastline is the only thing it consumes.
    expect(fishery.stock.food ?? 0).toBeGreaterThan(0);
  });

  it('the fishery faces east when the water is east', () => {
    const world = bareWorld();
    for (let ty = 29; ty < 35; ty++) {
      const i = tileIdx(33, ty);
      world.map.terrain[i] = Terrain.Water;
      world.map.blocked[i] = 1;
    }
    expect(canPlace(world.map, 'fishery', 30, 30)).toBe(true);
    expect(placeBuiltBuilding(world, 'fishery', 0, 30, 30).facing).toBe(1);
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
    run(world, 20 * 21);
    expect(brewery.stock.ale).toBe(1);
    expect(brewery.inputs.wheat ?? 0).toBe(0);
    expect(brewery.inputs.water ?? 0).toBe(0);
  });

  it('weapon chain: the weaponsmith on swords turns iron+wood into sword', () => {
    const world = bareWorld();
    const smith = placeBuiltBuilding(world, 'weaponsmith', 0, 30, 30);
    smith.recipeIndex = 1; // recipeOptions: [spear, sword, bow]
    staffBuilding(world, smith);
    smith.inputs.iron = 2;
    smith.inputs.wood = 1;
    run(world, 20 * 15);
    expect(smith.stock.sword).toBe(1);
  });
});

/**
 * Every gatherer answers to one placement rule: something its worker can
 * work has to be inside the radius that worker will search. The hut is
 * refused while it is still a ghost, not discovered idle a minute later.
 */
describe('gatherer placement', () => {
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

  it('refuses a woodcutter with no trees in reach, and a quarry with no rock', () => {
    const world = bareWorld();
    expect(canPlace(world.map, 'woodcutter', 30, 30)).toBe(false);
    expect(canPlace(world.map, 'quarry', 30, 30)).toBe(false);

    // The hut's search runs from its floored footprint center — (31, 31)
    // for a 2x2 at (30, 30) — out to the recipe's radius of 8.
    addResourceTile(world, 39, 31);
    expect(canPlace(world.map, 'woodcutter', 30, 30)).toBe(true);
    expect(canPlace(world.map, 'quarry', 30, 30)).toBe(false); // trees aren't rock

    addResourceTile(world, 23, 31, TileResource.Rock);
    expect(canPlace(world.map, 'quarry', 30, 30)).toBe(true);
  });

  it('draws the line exactly where the worker stops walking', () => {
    const world = bareWorld();
    const radius = 8; // woodcutter's gather radius
    const center = 31; // floored center of a 2x2 at (30, 30)
    addResourceTile(world, center + radius + 1, center);
    expect(canPlace(world.map, 'woodcutter', 30, 30)).toBe(false);

    addResourceTile(world, center + radius, center);
    expect(canPlace(world.map, 'woodcutter', 30, 30)).toBe(true);
  });

  it('a stump is not a tree: a worked-out grove stops being placeable ground', () => {
    const world = bareWorld();
    addResourceTile(world, 36, 31, TileResource.Wood, 1);
    expect(canPlace(world.map, 'woodcutter', 30, 30)).toBe(true);

    depleteResourceTile(world, tileIdx(36, 31));
    expect(canPlace(world.map, 'woodcutter', 30, 30)).toBe(false);
  });

  it('the placed hut actually finds the wood the rule promised', () => {
    const world = bareWorld();
    addResourceTile(world, 39, 31); // the far edge of the radius
    expect(canPlace(world.map, 'woodcutter', 30, 30)).toBe(true);

    const hut = placeBuiltBuilding(world, 'woodcutter', 0, 30, 30);
    bindWorker(hut, spawnUnit(world, 'worker', 0, 30.5, 32.5));
    run(world, 20 * 60);
    expect(hut.stock.wood ?? 0).toBeGreaterThan(0);
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
