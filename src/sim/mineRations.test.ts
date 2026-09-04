import {describe, expect, it} from 'vitest';
import {tileIdx} from '../shared/grid.ts';
import {checkLedger, countGoods} from './debug/invariants.ts';
import {MINE_RATION_PER, RATION_STOCK} from './defs/balance.ts';
import {BUILDING_DEFS, rationOf} from './defs/buildings.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as GoodId from './defs/goodIdEnum.ts';
import {addSerf, addStorehouse, bareWorld, staffBuilding} from './testUtils.ts';
import {tickWorld} from './tick.ts';
import * as TileResource from './tileResourceEnum.ts';
import {placeBuiltBuilding, type World} from './world.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

/** A seam of `amt` at every tile of a 3x3 block, well inside a mine's
 * radius of 4 — enough ore that no test here ever runs the rock out and
 * mistakes an exhausted seam for a hungry miner. */
function plantSeam(
  world: World,
  x: number,
  y: number,
  res = TileResource.SilverDep,
  amt = 6,
): void {
  for (let dy = 0; dy < 3; dy++) {
    for (let dx = 0; dx < 3; dx++) {
      const i = tileIdx(x + dx, y + dy, world.map.size);
      world.map.resource[i] = res;
      world.map.resourceAmt[i] = amt;
    }
  }
}

/** A staffed silver mine on its seam, with `food` loaves already in the
 * pantry and nothing else in the world to haul more in. */
function loneMine(food: number): {
  world: World;
  mine: ReturnType<typeof placeBuiltBuilding>;
} {
  const world = bareWorld();
  plantSeam(world, 34, 30);
  const mine = placeBuiltBuilding(world, BuildingTypeId.silverMine, 0, 30, 30);
  staffBuilding(world, mine);
  if (food > 0) mine.inputs[GoodId.food] = food;
  return {world, mine};
}

describe('the miners’ ration', () => {
  it('every mine eats and no surface gatherer does', () => {
    for (const type of [
      BuildingTypeId.ironMine,
      BuildingTypeId.silverMine,
      BuildingTypeId.goldMine,
    ]) {
      expect(rationOf(BUILDING_DEFS[type])).toEqual({
        good: GoodId.food,
        per: MINE_RATION_PER,
      });
    }
    // The way back out of a famine: wood and stone are what a starved
    // village rebuilds its food from (a rod is the Smith's one wood-only
    // tool, and the fishery takes no input at all), so neither may be
    // gated behind eating.
    for (const type of [BuildingTypeId.woodcutter, BuildingTypeId.quarry]) {
      expect(rationOf(BUILDING_DEFS[type])).toBeUndefined();
    }
  });

  it('one loaf buys exactly MINE_RATION_PER loads, then the shaft stops', () => {
    const {world, mine} = loneMine(1);
    run(world, 4000);

    expect(mine.inputs[GoodId.food] ?? 0).toBe(0);
    // The loads the one loaf bought are on the mine's shelf (nothing else
    // stands in this world to cart them home).
    expect(mine.stock[GoodId.silver] ?? 0).toBe(MINE_RATION_PER);
    expect(mine.rationLeft ?? 0).toBe(0);
    expect(world.ledger.consumed[GoodId.food] ?? 0).toBe(1);
  });

  it('a mine with an empty pantry produces nothing at all', () => {
    const {world, mine} = loneMine(0);
    run(world, 4000);

    expect(mine.stock[GoodId.silver] ?? 0).toBe(0);
    expect(world.ledger.produced[GoodId.silver] ?? 0).toBe(0);
    // Idle, not dismissed: the post keeps its man, so the bread that
    // arrives later is worked the same beat rather than after a re-hire.
    const worker = world.units.get(mine.workerId!);
    expect(worker?.dead).toBe(false);
  });

  it('bread delivered later starts the stalled shaft again', () => {
    const {world, mine} = loneMine(0);
    run(world, 600);
    expect(mine.stock[GoodId.silver] ?? 0).toBe(0);

    mine.inputs[GoodId.food] = 2;
    run(world, 4000);
    expect(mine.stock[GoodId.silver] ?? 0).toBeGreaterThan(0);
  });

  it('the castle hauls bread out to the mine, into its pantry not its shelf', () => {
    const world = bareWorld();
    plantSeam(world, 40, 30);
    addStorehouse(world, 30, 30, {[GoodId.food]: 20});
    const mine = placeBuiltBuilding(
      world,
      BuildingTypeId.silverMine,
      0,
      36,
      30,
    );
    staffBuilding(world, mine);
    // Hands to carry it: the mine raises the demand, the board serves it.
    for (let i = 0; i < 3; i++) addSerf(world, 31 + i, 33);
    run(world, 2000);

    // The loaves wait in the input buffer. On the output shelf they would
    // be evacuated straight back to the castle and the miner would starve
    // beside a full larder.
    expect(mine.inputs[GoodId.food] ?? 0).toBeGreaterThan(0);
    expect(mine.inputs[GoodId.food] ?? 0).toBeLessThanOrEqual(RATION_STOCK);
    expect(mine.stock[GoodId.food] ?? 0).toBe(0);
  });

  it('keeps the goods ledger: every loaf eaten is a loaf accounted for', () => {
    const world = bareWorld();
    plantSeam(world, 40, 30);
    addStorehouse(world, 30, 30, {[GoodId.food]: 20});
    const mine = placeBuiltBuilding(
      world,
      BuildingTypeId.silverMine,
      0,
      36,
      30,
    );
    staffBuilding(world, mine);
    for (let i = 0; i < 3; i++) addSerf(world, 31 + i, 33);
    const initial = countGoods(world);
    run(world, 6000);

    expect(checkLedger(world, initial)).toEqual([]);
    expect(world.ledger.consumed[GoodId.food] ?? 0).toBeGreaterThan(0);
  });
});
