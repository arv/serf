import {describe, expect, it} from 'vitest';
import {tileIdx} from '../shared/grid.ts';
import {checkInvariants, checkLedger, countGoods} from './debug/invariants.ts';
import {
  ICE_FROM,
  SLED_LOAD,
  SNOW_SPEED,
  WINTER_UNTIL,
  YEAR_TICKS,
  isWinter,
} from './defs/balance.ts';
import {buildingDef} from './defs/buildings.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as GoodId from './defs/goodIdEnum.ts';
import * as HaulPhase from './haulPhaseEnum.ts';
import {tileSpeedMult, tileStepCost} from './path.ts';
import * as PathLevel from './pathLevelEnum.ts';
import {sparesSleds} from './systems/logistics.ts';
import {autoForgeIndex} from './systems/production.ts';
import {
  addBuiltHut,
  addSerf,
  addSite,
  addStorehouse,
  bareWorld,
} from './testUtils.ts';
import {tickWorld} from './tick.ts';
import {cargoOf} from './units.ts';
import {killUnit, placeBuiltBuilding, type World} from './world.ts';

const WINTER = ICE_FROM * YEAR_TICKS;
const THAW = WINTER_UNTIL * YEAR_TICKS;

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

/** A storehouse of wood with `sleds` sleds on its shelf, and a
 * woodcutter's site six wood short, in winter. */
function winterSite(sleds = 2) {
  const world = bareWorld();
  world.tick = WINTER;
  const store = addStorehouse(world, 30, 30, {
    [GoodId.wood]: 10,
    [GoodId.sled]: sleds,
  });
  const site = addSite(world, 24, 30);
  return {world, store, site, start: countGoods(world)};
}

describe('winter', () => {
  it('lies from the first hard frost until the snow is half gone', () => {
    expect(isWinter(0)).toBe(false);
    expect(isWinter(WINTER - 1)).toBe(false);
    expect(isWinter(WINTER)).toBe(true);
    expect(isWinter(THAW - 1)).toBe(true);
    expect(isWinter(THAW)).toBe(false);
    expect(isWinter(YEAR_TICKS + WINTER)).toBe(true);
  });

  it('slows the walk everywhere, roads included', () => {
    const {map} = bareWorld();
    const grass = tileIdx(5, 5, map.size);
    const trail = tileIdx(6, 5, map.size);
    const road = tileIdx(7, 5, map.size);
    map.pathLevel[trail] = PathLevel.Trail;
    map.pathLevel[road] = PathLevel.Road;
    const summer = [grass, trail, road].map(i => tileSpeedMult(map, i));
    expect(summer).toEqual([1, 1.15, 1.35]);

    map.winter = true;
    // The snow buries the trail and the paving alike.
    for (const i of [grass, trail, road]) {
      expect(tileSpeedMult(map, i)).toBe(SNOW_SPEED);
      // And a route is priced the way it will be walked.
      expect(tileStepCost(map, i)).toBeCloseTo(1 / SNOW_SPEED);
    }
  });
});

describe('sleds', () => {
  it('are what makes a walk of more than one load', () => {
    // No sled at the castle: winter or not, every load is its own walk.
    const {world, store} = winterSite(0);
    run(world, 1);
    expect(world.jobs.size).toBe(8);
    expect(sparesSleds(world, 0)).toBe(0);

    // One sled: one walk goes four-up, the other two wood go one apiece.
    const one = winterSite(1);
    run(one.world, 1);
    const wood = [...one.world.jobs.values()].filter(
      j => j.good === GoodId.wood,
    );
    expect(wood.map(j => j.count ?? 1).sort((a, b) => a - b)).toEqual([
      1,
      1,
      SLED_LOAD,
    ]);
    expect(sparesSleds(one.world, 0)).toBe(0);
    // Booked, not yet fetched: the sled is still on the castle's shelf.
    expect(store.stock[GoodId.sled]).toBe(0);
    expect(one.store.stock[GoodId.sled]).toBe(1);
    expect(checkInvariants(one.world).violations).toEqual([]);
  });

  it('book a load of one good along one walk as one job', () => {
    const {world, store, site} = winterSite();
    run(world, 1);

    // Six wood is a full sled and two over; the hammer and the axe are one
    // of each and ride alone. Summer books eight walks for the same site.
    const wood = [...world.jobs.values()].filter(j => j.good === GoodId.wood);
    expect(wood.map(j => j.count ?? 1).sort((a, b) => a - b)).toEqual([
      2,
      SLED_LOAD,
    ]);
    expect(world.jobs.size).toBe(4);
    // The reservations are the goods', not the walks'.
    expect(store.reservedOut[GoodId.wood]).toBe(6);
    expect(site.inbound[GoodId.wood]).toBe(6);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('carry the whole load there in one trip', () => {
    const {world, site, start} = winterSite();
    const serf = addSerf(world, 28, 30);
    let most = 0;
    for (let i = 0; i < 400 && (site.siteNeeds?.[GoodId.wood] ?? 0) > 0; i++) {
      tickWorld(world, []);
      most = Math.max(most, cargoOf(serf));
      expect(checkInvariants(world).violations).toEqual([]);
    }
    expect(most).toBe(SLED_LOAD);
    expect(site.siteNeeds?.[GoodId.wood] ?? 0).toBe(0);
    expect(checkLedger(world, start)).toEqual([]);
  });

  it('spill what they hold where the carrier falls', () => {
    const {world, start} = winterSite();
    const serf = addSerf(world, 28, 30);
    for (let i = 0; i < 400 && cargoOf(serf) < SLED_LOAD; i++) {
      tickWorld(world, []);
    }
    expect(cargoOf(serf)).toBe(SLED_LOAD);
    killUnit(world, serf);
    run(world, 30);
    // Four on the ground or burned and ledgered, never three lost quietly.
    expect(checkLedger(world, start)).toEqual([]);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('are unpacked into single walks when the snow goes', () => {
    const {world, store, site} = winterSite();
    run(world, 1);
    expect(world.jobs.size).toBe(4);

    world.tick = THAW;
    run(world, 1);
    const jobs = [...world.jobs.values()];
    expect(jobs.every(j => (j.count ?? 1) === 1)).toBe(true);
    expect(jobs.filter(j => j.good === GoodId.wood)).toHaveLength(6);
    expect(jobs.every(j => j.phase === HaulPhase.open)).toBe(true);
    expect(store.reservedOut[GoodId.wood]).toBe(6);
    expect(site.inbound[GoodId.wood]).toBe(6);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('are not booked in summer', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {[GoodId.wood]: 10});
    addSite(world, 24, 30);
    run(world, 1);
    expect(world.jobs.size).toBe(8);
    expect([...world.jobs.values()].every(j => j.count === undefined)).toBe(
      true,
    );
  });

  it('are forged at the Smith from wood, and only when ordered', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const smith = placeBuiltBuilding(
      world,
      BuildingTypeId.weaponsmith,
      0,
      20,
      30,
    );
    const def = buildingDef(smith.type);
    // Every post served and not a sled in the village: auto still forges
    // nothing. A village has the sleds somebody asked for.
    expect(autoForgeIndex(world, smith, def)).toBeUndefined();
    const index = def.recipeOptions!.findIndex(
      o => (o.recipe.outputs[GoodId.sled] ?? 0) > 0,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const recipe = def.recipeOptions![index]!.recipe;
    expect(recipe.inputs).toEqual({[GoodId.wood]: 2});
    expect(def.recipeOptions![index]!.requiresTech).toBeUndefined();
  });

  it('take home whatever is waiting at the door, not just what was booked', () => {
    const world = bareWorld();
    world.tick = WINTER;
    const castle = addStorehouse(world, 30, 30, {[GoodId.sled]: 1});
    const hut = addBuiltHut(world, 20, 30, false);
    hut.stock[GoodId.wood] = 1;
    const serf = addSerf(world, 25, 30);
    run(world, 1);
    // One plank on the shelf: one booked.
    const job = [...world.jobs.values()].find(j => j.good === GoodId.wood)!;
    expect(job.count ?? 1).toBe(1);
    // Three more are cut before he gets there.
    hut.stock[GoodId.wood] = 4;
    let most = 0;
    for (let i = 0; i < 1500 && (castle.stock[GoodId.wood] ?? 0) === 0; i++) {
      tickWorld(world, []);
      most = Math.max(most, cargoOf(serf));
      expect(checkInvariants(world).violations).toEqual([]);
    }
    expect(most).toBe(SLED_LOAD);
    expect(castle.stock[GoodId.wood]).toBe(SLED_LOAD);
    expect(hut.stock[GoodId.wood] ?? 0).toBe(0);
  });

  it('take nothing extra without a sled to put it on', () => {
    const world = bareWorld();
    world.tick = WINTER;
    const castle = addStorehouse(world, 30, 30, {});
    const hut = addBuiltHut(world, 20, 30, false);
    hut.stock[GoodId.wood] = 1;
    const serf = addSerf(world, 25, 30);
    run(world, 1);
    hut.stock[GoodId.wood] = 4;
    let most = 0;
    for (let i = 0; i < 1500 && (castle.stock[GoodId.wood] ?? 0) === 0; i++) {
      tickWorld(world, []);
      most = Math.max(most, cargoOf(serf));
    }
    expect(most).toBe(1);
  });

  it('are fetched from the castle, and brought back after', () => {
    const {world, store, site, start} = winterSite(1);
    // Out by the site, away from the castle the sled is kept at.
    const serf = addSerf(world, 22, 33);
    let held = false;
    let wentHome = false;
    for (let i = 0; i < 3000 && (site.siteNeeds?.[GoodId.wood] ?? 0) > 0; i++) {
      tickWorld(world, []);
      if (serf.sled) {
        held = true;
        // While he has it, it is off the shelf.
        expect(store.stock[GoodId.sled] ?? 0).toBe(0);
      }
      expect(checkInvariants(world).violations).toEqual([]);
    }
    expect(held).toBe(true);
    // ...and once there is nothing left to haul four-up, it goes home.
    for (let i = 0; i < 3000 && serf.sled; i++) {
      tickWorld(world, []);
      wentHome = true;
    }
    expect(wentHome).toBe(true);
    expect(serf.sled).toBeUndefined();
    expect(store.stock[GoodId.sled]).toBe(1);
    expect(checkLedger(world, start)).toEqual([]);
  });

  it('fall where their hauler does', () => {
    const {world, store, start} = winterSite(1);
    const serf = addSerf(world, 28, 30);
    for (let i = 0; i < 3000 && !serf.sled; i++) tickWorld(world, []);
    expect(serf.sled).toBe(true);
    killUnit(world, serf);
    run(world, 2);
    // Not back on the shelf: on the ground where he fell, for hauling home.
    expect(store.stock[GoodId.sled] ?? 0).toBe(0);
    expect(checkLedger(world, start)).toEqual([]);
    expect(checkInvariants(world).violations).toEqual([]);
  });
});
