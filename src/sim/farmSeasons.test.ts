import {describe, expect, it} from 'vitest';
import {checkInvariants} from './debug/invariants.ts';
import {
  FALLOW_FROM,
  GROW_FROM,
  SOW_FROM,
  YEAR_TICKS,
  farmSeasonAt,
  farmSeasonLeft,
} from './defs/balance.ts';
import {BUILDING_DEFS} from './defs/buildings.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as FarmSeason from './defs/farmSeasonEnum.ts';
import * as GoodId from './defs/goodIdEnum.ts';
import * as UnitTypeId from './defs/unitTypeIdEnum.ts';
import type {Building} from './entities.ts';
import {bareWorld, staffBuilding} from './testUtils.ts';
import {tickWorld} from './tick.ts';
import {placeBuiltBuilding, type World} from './world.ts';

const SOW = SOW_FROM * YEAR_TICKS;
const FALLOW = FALLOW_FROM * YEAR_TICKS;
const GROW = GROW_FROM * YEAR_TICKS;

/** A staffed farm that never runs dry and never fills up: what is left is
 * the season and the clock. Returns the wheat it cut in `ticks`. */
function farmFor(world: World, farm: Building, ticks: number): number {
  let cut = 0;
  for (let i = 0; i < ticks; i++) {
    farm.inputs[GoodId.water] = 5;
    tickWorld(world, []);
    cut += farm.stock[GoodId.wheat] ?? 0;
    farm.stock[GoodId.wheat] = 0;
  }
  return cut;
}

function staffedFarm(tick: number): {world: World; farm: Building} {
  const world = bareWorld();
  world.tick = tick;
  const farm = placeBuiltBuilding(world, BuildingTypeId.wheatFarm, 0, 30, 30);
  staffBuilding(world, farm);
  return {world, farm};
}

describe("the field's year", () => {
  it('walks harvest, sow, fallow and grow, and starts again', () => {
    expect(farmSeasonAt(0)).toBe(FarmSeason.harvest);
    expect(farmSeasonAt(SOW - 1)).toBe(FarmSeason.harvest);
    expect(farmSeasonAt(SOW)).toBe(FarmSeason.sow);
    expect(farmSeasonAt(FALLOW - 1)).toBe(FarmSeason.sow);
    expect(farmSeasonAt(FALLOW)).toBe(FarmSeason.fallow);
    expect(farmSeasonAt(GROW - 1)).toBe(FarmSeason.fallow);
    expect(farmSeasonAt(GROW)).toBe(FarmSeason.grow);
    expect(farmSeasonAt(YEAR_TICKS - 1)).toBe(FarmSeason.grow);
    expect(farmSeasonAt(YEAR_TICKS)).toBe(FarmSeason.harvest);
  });

  it('says how long the season has left', () => {
    expect(farmSeasonLeft(0)).toBe(SOW);
    expect(farmSeasonLeft(SOW - 1)).toBe(1);
    expect(farmSeasonLeft(SOW)).toBe(FALLOW - SOW);
    expect(farmSeasonLeft(YEAR_TICKS - 1)).toBe(1);
    expect(farmSeasonLeft(YEAR_TICKS + 5)).toBe(SOW - 5);
  });
});

describe('the farm follows the seasons', () => {
  it('cuts a whole year of wheat inside the harvest', () => {
    // Before the seasons a farm cut a sheaf every ten seconds, all year:
    // 48 a year. Only the harvest cuts now, so it has to cut those 48 in
    // it — the last may land a few seconds into the sowing.
    const {world, farm} = staffedFarm(0);
    const before = YEAR_TICKS / (10 * 20);
    expect(farmFor(world, farm, YEAR_TICKS)).toBe(before);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('cuts nothing from the sowing to the end of the spring', () => {
    const {world, farm} = staffedFarm(SOW);
    expect(farmFor(world, farm, YEAR_TICKS - SOW)).toBe(0);
    expect(farm.prodTicksLeft).toBeUndefined();
  });

  it('finishes the sheaf it was cutting when the harvest ends', () => {
    const {world, farm} = staffedFarm(SOW - 1);
    farm.inputs[GoodId.water] = 1;
    tickWorld(world, []); // the last tick of the harvest starts one
    expect(farm.prodTicksLeft).toBeDefined();
    expect(farmFor(world, farm, 20 * 20)).toBe(1);
  });

  it('has the last sheaf in long before the farmer is sent off', () => {
    // The winter release (systems/staffing.ts) leaves no batch behind it
    // because none can still be running: the last one starts before the
    // sowing, the sowing outlasts it many times over, and every modifier
    // on a farm's clock (Irrigation, a festival) only shortens it.
    const recipe = BUILDING_DEFS[BuildingTypeId.wheatFarm].recipe!;
    if (!('durationTicks' in recipe)) throw new Error('the farm converts');
    expect(recipe.durationTicks * 4).toBeLessThan(FALLOW - SOW);
    const {world, farm} = staffedFarm(SOW - 1);
    farm.inputs[GoodId.water] = 1;
    farmFor(world, farm, FALLOW - SOW + 30); // across the first winter sweep
    expect(farm.prodTicksLeft).toBeUndefined();
    expect(farm.workerId).toBeUndefined();
  });

  it('sends the farmer off for the winter and calls him back at the thaw', () => {
    const {world, farm} = staffedFarm(FALLOW - 1);
    const farmer = world.units.get(farm.workerId!)!;
    farmFor(world, farm, 30); // across a staffing sweep
    // Back in the serf pool, and the scythe waits on the farm's own rack
    // rather than going home to the castle.
    expect(farm.workerId).toBeUndefined();
    expect(farmer.kind).toBe(UnitTypeId.serf);
    expect(farmer.homeId).toBeUndefined();
    expect(farm.inputs[GoodId.scythe]).toBe(1);
    expect(farm.stock[GoodId.scythe] ?? 0).toBe(0);
    // Nobody is called for while the field sleeps...
    farmFor(world, farm, GROW - FALLOW - 30);
    expect(farm.workerId).toBeUndefined();
    expect(farm.recruitId).toBeUndefined();
    // ...and with the thaw a hand walks over and takes the scythe down, in
    // time for the harvest.
    farmFor(world, farm, YEAR_TICKS - GROW);
    expect(farm.workerId).toBe(farmer.id);
    expect(farmer.kind).toBe(UnitTypeId.worker);
    expect(farm.inputs[GoodId.scythe] ?? 0).toBe(0);
    expect(checkInvariants(world).violations).toEqual([]);
  });
});
