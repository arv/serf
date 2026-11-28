import {describe, expect, it} from 'vitest';
import {tileIdx} from '../shared/grid.ts';
import {atBuilding} from './arrival.ts';
import {checkInvariants, checkLedger, countGoods} from './debug/invariants.ts';
import {
  BARROW_LOAD,
  ICE_FROM,
  SLED_LOAD,
  cartFor,
  SNOW_SPEED,
  WINTER_UNTIL,
  YEAR_TICKS,
  isWinter,
} from './defs/balance.ts';
import {buildingDef} from './defs/buildings.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as GoodId from './defs/goodIdEnum.ts';
import * as EconomyRuleId from './economyRuleIdEnum.ts';
import {ECONOMY_RULES, type RuleContext} from './economyRules.ts';
import * as HaulPhase from './haulPhaseEnum.ts';
import {tileSpeedMult, tileStepCost} from './path.ts';
import * as PathLevel from './pathLevelEnum.ts';
import {spareCarts, splitCartLoads} from './systems/logistics.ts';
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
import * as UnitTaskKind from './unitTaskKindEnum.ts';
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
    expect(spareCarts(world, 0, GoodId.sled)).toBe(0);

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
    expect(spareCarts(one.world, 0, GoodId.sled)).toBe(0);
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
    addStorehouse(world, 30, 30, {[GoodId.wood]: 10, [GoodId.sled]: 2});
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
      if (serf.cart === GoodId.sled) {
        held = true;
        // While he has it, it is off the shelf.
        expect(store.stock[GoodId.sled] ?? 0).toBe(0);
      }
      expect(checkInvariants(world).violations).toEqual([]);
    }
    expect(held).toBe(true);
    // ...and once there is nothing left to haul four-up, it goes home.
    for (let i = 0; i < 3000 && serf.cart !== undefined; i++) {
      tickWorld(world, []);
      wentHome = true;
    }
    expect(wentHome).toBe(true);
    expect(serf.cart).toBeUndefined();
    expect(store.stock[GoodId.sled]).toBe(1);
    expect(checkLedger(world, start)).toEqual([]);
  });

  it('fall where their hauler does', () => {
    const {world, store, start} = winterSite(1);
    const serf = addSerf(world, 28, 30);
    for (let i = 0; i < 3000 && serf.cart === undefined; i++)
      tickWorld(world, []);
    expect(serf.cart).toBe(GoodId.sled);
    killUnit(world, serf);
    run(world, 2);
    // Not back on the shelf: on the ground where he fell, for hauling home.
    expect(store.stock[GoodId.sled] ?? 0).toBe(0);
    expect(checkLedger(world, start)).toEqual([]);
    expect(checkInvariants(world).violations).toEqual([]);
  });
});

/** A storehouse of wood with `barrows` wheelbarrows on its shelf, and a
 * woodcutter's site six wood short, at `tick` (summer by default). */
function summerSite(barrows = 2, tick = 0) {
  const world = bareWorld();
  world.tick = tick;
  const store = addStorehouse(world, 30, 30, {
    [GoodId.wood]: 10,
    [GoodId.wheelbarrow]: barrows,
  });
  const site = addSite(world, 24, 30);
  return {world, store, site, start: countGoods(world)};
}

function woodLoads(world: World): number[] {
  return [...world.jobs.values()]
    .filter(j => j.good === GoodId.wood)
    .map(j => j.count ?? 1)
    .sort((a, b) => a - b);
}

describe('the season’s cart', () => {
  it('is a barrow until the frost, a sled in the snow, and nothing in the thaw', () => {
    expect(cartFor(0)?.good).toBe(GoodId.wheelbarrow);
    expect(cartFor(WINTER - 1)?.good).toBe(GoodId.wheelbarrow);
    expect(cartFor(WINTER)?.good).toBe(GoodId.sled);
    expect(cartFor(THAW - 1)?.good).toBe(GoodId.sled);
    expect(cartFor(THAW)).toBeUndefined();
    expect(cartFor(YEAR_TICKS - 1)).toBeUndefined();
    expect(cartFor(YEAR_TICKS)?.good).toBe(GoodId.wheelbarrow);
    expect(cartFor(0)?.load).toBe(BARROW_LOAD);
    expect(cartFor(WINTER)?.load).toBe(SLED_LOAD);
  });
});

describe('wheelbarrows', () => {
  it('book two of one good along one walk as one job', () => {
    const {world, store, site} = summerSite();
    run(world, 1);
    // Six wood on two barrows is two walks of two, and two of one once
    // both barrows are spoken for. Without them it is six walks.
    expect(woodLoads(world)).toEqual([1, 1, BARROW_LOAD, BARROW_LOAD]);
    expect(spareCarts(world, 0, GoodId.wheelbarrow)).toBe(0);
    expect(store.reservedOut[GoodId.wood]).toBe(6);
    expect(site.inbound[GoodId.wood]).toBe(6);
    expect(checkInvariants(world).violations).toEqual([]);

    const none = summerSite(0);
    run(none.world, 1);
    expect(woodLoads(none.world)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('are fetched from the castle, carry two, and go back after', () => {
    const {world, store, site, start} = summerSite(1);
    const serf = addSerf(world, 22, 33);
    let most = 0;
    let held = false;
    for (let i = 0; i < 4000 && (site.siteNeeds?.[GoodId.wood] ?? 0) > 0; i++) {
      tickWorld(world, []);
      most = Math.max(most, cargoOf(serf));
      if (serf.cart === GoodId.wheelbarrow) {
        held = true;
        expect(store.stock[GoodId.wheelbarrow] ?? 0).toBe(0);
      }
      expect(checkInvariants(world).violations).toEqual([]);
    }
    expect(held).toBe(true);
    expect(most).toBe(BARROW_LOAD);
    expect(site.siteNeeds?.[GoodId.wood] ?? 0).toBe(0);
    for (let i = 0; i < 3000 && serf.cart !== undefined; i++) {
      tickWorld(world, []);
    }
    expect(serf.cart).toBeUndefined();
    expect(store.stock[GoodId.wheelbarrow]).toBe(1);
    expect(checkLedger(world, start)).toEqual([]);
  });

  it('take home what is waiting at the door, up to two', () => {
    const world = bareWorld();
    const castle = addStorehouse(world, 30, 30, {[GoodId.wheelbarrow]: 1});
    const hut = addBuiltHut(world, 20, 30, false);
    hut.stock[GoodId.wood] = 1;
    const serf = addSerf(world, 25, 30);
    run(world, 1);
    hut.stock[GoodId.wood] = 4;
    let most = 0;
    for (let i = 0; i < 1500 && (castle.stock[GoodId.wood] ?? 0) === 0; i++) {
      tickWorld(world, []);
      most = Math.max(most, cargoOf(serf));
      expect(checkInvariants(world).violations).toEqual([]);
    }
    expect(most).toBe(BARROW_LOAD);
    expect(castle.stock[GoodId.wood]).toBe(BARROW_LOAD);
  });

  it('are taken on the spot by a man already at the castle door', () => {
    const world = bareWorld();
    const castle = addStorehouse(world, 30, 30, {});
    castle.stock = {[GoodId.wheelbarrow]: 1}; // no fixture tools to deliver
    const hut = addBuiltHut(world, 10, 30, false);
    hut.stock[GoodId.wood] = 2;
    const serf = addSerf(world, castle.x - 1, castle.y);
    expect(atBuilding(serf, castle)).toBe(true);
    for (let i = 0; i < 50 && serf.jobId === undefined; i++) {
      tickWorld(world, []);
    }
    expect(serf.jobId).toBeDefined();
    // The barrow leaves the shelf before he leaves the door: no walk to the
    // hut and back for it.
    expect(serf.cart).toBe(GoodId.wheelbarrow);
    expect(castle.stock[GoodId.wheelbarrow] ?? 0).toBe(0);
    expect(atBuilding(serf, castle)).toBe(true);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('spill what they hold, barrow and all, where the carrier falls', () => {
    const {world, store, start} = summerSite(1);
    const serf = addSerf(world, 28, 30);
    for (let i = 0; i < 3000 && cargoOf(serf) < BARROW_LOAD; i++) {
      tickWorld(world, []);
    }
    expect(cargoOf(serf)).toBe(BARROW_LOAD);
    expect(serf.cart).toBe(GoodId.wheelbarrow);
    killUnit(world, serf);
    run(world, 30);
    expect(store.stock[GoodId.wheelbarrow] ?? 0).toBe(0);
    expect(checkLedger(world, start)).toEqual([]);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('are no use in the snow, where only a sled is', () => {
    const {world} = summerSite(2, WINTER);
    run(world, 1);
    expect(woodLoads(world)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('are forged at the Smith from one wood, cheaper than a sled, and only when ordered', () => {
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
    expect(autoForgeIndex(world, smith, def)).toBeUndefined();
    const options = def.recipeOptions!;
    const barrow = options.find(
      o => (o.recipe.outputs[GoodId.wheelbarrow] ?? 0) > 0,
    )!;
    const sled = options.find(o => (o.recipe.outputs[GoodId.sled] ?? 0) > 0)!;
    expect(barrow.recipe.inputs).toEqual({[GoodId.wood]: 1});
    expect(barrow.requiresTech).toBeUndefined();
    expect(barrow.recipe.inputs[GoodId.wood]!).toBeLessThan(
      sled.recipe.inputs[GoodId.wood]!,
    );
    // Appended after the sled: no tool's index moved.
    expect(options.indexOf(barrow)).toBe(options.length - 1);
  });

  it('are swapped at the castle for a sled when the snow comes', () => {
    // A barrow left in a man's hands over the frost goes back on the shelf
    // when he comes for a sled, not on the sled.
    const world = bareWorld();
    world.tick = WINTER;
    const store = addStorehouse(world, 30, 30, {
      [GoodId.wood]: 10,
      [GoodId.sled]: 1,
    });
    const site = addSite(world, 24, 30);
    const start = countGoods(world);
    const serf = addSerf(world, 31, 33);
    serf.cart = GoodId.wheelbarrow;
    start[GoodId.wheelbarrow] = 1;
    let swapped = false;
    for (let i = 0; i < 4000 && (site.siteNeeds?.[GoodId.wood] ?? 0) > 0; i++) {
      tickWorld(world, []);
      if ((serf.cart as number | undefined) === GoodId.sled) {
        swapped = true;
        expect(store.stock[GoodId.wheelbarrow]).toBe(1);
      }
      expect(checkInvariants(world).violations).toEqual([]);
    }
    expect(swapped).toBe(true);
    expect(site.siteNeeds?.[GoodId.wood] ?? 0).toBe(0);
    expect(checkLedger(world, start)).toEqual([]);
  });
});

describe('a cart in hand', () => {
  it('goes home to the castle before its hauler takes up a post', () => {
    // A post wants a worker, and the one loose serf is walking a barrow
    // home. He puts it on the shelf first: hired with it in hand, a post
    // would keep it from the castle for good, and a barracks or a tower
    // would take it in with him.
    const world = bareWorld();
    const castle = addStorehouse(world, 30, 30, {[GoodId.axe]: 1});
    addBuiltHut(world, 20, 30, false);
    const serf = addSerf(world, 24, 31);
    serf.cart = GoodId.wheelbarrow;
    const start = countGoods(world);
    for (let i = 0; i < 3000 && serf.homeId === undefined; i++) {
      tickWorld(world, []);
      if (serf.task.t === UnitTaskKind.staff) expect(serf.cart).toBeUndefined();
    }
    expect(serf.homeId).toBeDefined();
    expect(castle.stock[GoodId.wheelbarrow]).toBe(1);
    expect(checkLedger(world, start)).toEqual([]);
  });
});

describe('the thaw', () => {
  it('books every load as its own walk, sleds and barrows on the shelf or not', () => {
    const world = bareWorld();
    world.tick = THAW;
    addStorehouse(world, 30, 30, {
      [GoodId.wood]: 10,
      [GoodId.sled]: 2,
      [GoodId.wheelbarrow]: 2,
    });
    addSite(world, 24, 30);
    run(world, 1);
    expect(woodLoads(world)).toEqual([1, 1, 1, 1, 1, 1]);
    expect([...world.jobs.values()].every(j => j.count === undefined)).toBe(
      true,
    );
  });

  it('takes nothing extra at the door, whatever a man has in hand', () => {
    const world = bareWorld();
    world.tick = THAW;
    const castle = addStorehouse(world, 30, 30, {});
    const hut = addBuiltHut(world, 20, 30, false);
    hut.stock[GoodId.wood] = 4;
    const serf = addSerf(world, 25, 30);
    // Still holding last winter's sled.
    serf.cart = GoodId.sled;
    let most = 0;
    for (let i = 0; i < 1500 && (castle.stock[GoodId.wood] ?? 0) === 0; i++) {
      tickWorld(world, []);
      most = Math.max(most, cargoOf(serf));
    }
    expect(most).toBe(1);
  });

  it('unpacks the barrows’ walks when the frost comes, and the sleds’ when it goes', () => {
    const summer = summerSite(2, WINTER - 100);
    for (let i = 0; i < 100 && summer.world.jobs.size === 0; i++)
      run(summer.world, 1);
    expect(woodLoads(summer.world)).toEqual([1, 1, 2, 2]);
    while (summer.world.tick <= WINTER) run(summer.world, 1); // the frost
    expect(woodLoads(summer.world)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(summer.store.reservedOut[GoodId.wood]).toBe(6);
    expect(checkInvariants(summer.world).violations).toEqual([]);
  });
});

describe('a walk cut back to one load', () => {
  it('gives the well back the draw time of the loads that left', () => {
    const world = bareWorld();
    const store = addStorehouse(world, 30, 30, {});
    const well = placeBuiltBuilding(world, BuildingTypeId.well, 0, 20, 30);
    const draw = buildingDef(well.type).drawTicks!;
    well.stock[GoodId.water] = 4;
    well.reservedOut[GoodId.water] = 4;
    store.inbound[GoodId.water] = 4;
    const serf = addSerf(world, 20, 32);
    const id = world.nextJobId++;
    world.jobs.set(id, {
      id,
      good: GoodId.water,
      from: well.id,
      to: store.id,
      owner: 0,
      priority: 3,
      createdTick: 0,
      phase: HaulPhase.toPickup,
      serfId: serf.id,
      count: SLED_LOAD,
      drawUntil: world.tick + draw * SLED_LOAD,
    });
    serf.jobId = id;
    splitCartLoads(world);
    // He stands at the windlass for the one bucket he still takes.
    expect(world.jobs.get(id)!.drawUntil).toBe(world.tick + draw);
    expect(world.jobs.size).toBe(SLED_LOAD);
  });
});

describe('a cart at a well', () => {
  it('takes only the buckets it stood at the windlass for', () => {
    const world = bareWorld();
    world.tick = WINTER;
    const store = addStorehouse(world, 30, 30, {});
    const well = placeBuiltBuilding(world, BuildingTypeId.well, 0, 20, 30);
    well.stock[GoodId.water] = 2;
    well.reservedOut[GoodId.water] = 2;
    store.inbound[GoodId.water] = 2;
    const serf = addSerf(world, 20, 32);
    serf.cart = GoodId.sled;
    const job = (serfId?: number) => {
      const id = world.nextJobId++;
      world.jobs.set(id, {
        id,
        good: GoodId.water,
        from: well.id,
        to: store.id,
        owner: 0,
        priority: 3,
        createdTick: 0,
        phase: HaulPhase.toPickup,
        serfId,
        ...(serfId === undefined ? {phase: HaulPhase.open} : {}),
      });
      return id;
    };
    serf.jobId = job(serf.id);
    serf.task = {t: UnitTaskKind.haul};
    const other = job();
    let started: number | undefined;
    for (let i = 0; i < 200 && serf.carrying === undefined; i++) {
      tickWorld(world, []);
      if (started === undefined && world.jobs.get(serf.jobId!)?.drawUntil)
        started = world.tick;
    }
    // One bucket wound up, one carried: the other load waits its own turn.
    expect(started).toBeDefined();
    expect(cargoOf(serf)).toBe(1);
    expect(world.jobs.has(other)).toBe(true);
    expect(checkInvariants(world).violations).toEqual([]);
  });
});

describe('stockTheCarts', () => {
  const rule = ECONOMY_RULES.find(r => r.id === EconomyRuleId.stockTheCarts)!;

  function contextFor(world: World): RuleContext {
    return {
      world,
      owner: 0,
      mine: [...world.buildings.values()]
        .filter(b => b.owner === 0)
        .sort((a, b) => a.id - b.id),
    } as RuleContext;
  }

  it('orders the season’s cart first, then the other, one of a kind at a time', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {[GoodId.wood]: 10});
    const smith = placeBuiltBuilding(
      world,
      BuildingTypeId.weaponsmith,
      0,
      20,
      30,
    );
    const options = buildingDef(smith.type).recipeOptions!;
    const indexOf = (good: GoodId.sled | GoodId.wheelbarrow): number =>
      options.findIndex(o => (o.recipe.outputs[good] ?? 0) > 0);
    const order = (): number | undefined => {
      const fired = rule.fire(contextFor(world));
      const cmd = fired?.commands[0];
      return cmd && 'recipeIndex' in cmd ? cmd.recipeIndex : undefined;
    };

    // Summer: a barrow first.
    expect(order()).toBe(indexOf(GoodId.wheelbarrow));
    smith.forgeQueue = [
      {recipeIndex: indexOf(GoodId.wheelbarrow), started: false},
    ];
    // One barrow on order: then a sled.
    expect(order()).toBe(indexOf(GoodId.sled));

    // Enough of both: nothing.
    smith.forgeQueue = [];
    const castle = [...world.buildings.values()].find(b => b !== smith)!;
    castle.stock[GoodId.wheelbarrow] = 3;
    castle.stock[GoodId.sled] = 3;
    expect(order()).toBeUndefined();

    // Winter with no sleds: a sled first.
    castle.stock[GoodId.sled] = 0;
    castle.stock[GoodId.wheelbarrow] = 0;
    world.tick = WINTER;
    expect(order()).toBe(indexOf(GoodId.sled));
  });
});

describe('a cart at the castle door', () => {
  /** Four men at the castle door and a site six planks short. */
  function siteRun(make: () => ReturnType<typeof summerSite>) {
    const {world, store, site, start} = make();
    const men = [0, 1, 2, 3].map(k => addSerf(world, 29 + k, 33));
    const carriers = new Set<number>();
    let most = 0;
    for (let i = 0; i < 4000 && (site.siteNeeds?.[GoodId.wood] ?? 0) > 0; i++) {
      tickWorld(world, []);
      for (const m of men) {
        if (m.carrying === GoodId.wood) carriers.add(m.id);
        most = Math.max(most, cargoOf(m));
      }
      expect(checkInvariants(world).violations).toEqual([]);
    }
    expect(site.siteNeeds?.[GoodId.wood] ?? 0).toBe(0);
    expect(store.stock[GoodId.wood]).toBe(4);
    expect(checkLedger(world, start)).toEqual([]);
    return {most, carriers: carriers.size};
  }

  it('takes a site its planks four to a sled in winter, not a man a plank', () => {
    const {most, carriers} = siteRun(() => winterSite(1));
    expect(most).toBe(SLED_LOAD);
    expect(carriers).toBeLessThanOrEqual(3);
  });

  it('and two to a barrow the rest of the year', () => {
    const {most, carriers} = siteRun(() => summerSite(1));
    expect(most).toBe(BARROW_LOAD);
    expect(carriers).toBeLessThanOrEqual(5);
  });
});
