import {describe, expect, it} from 'vitest';
import type {Enum} from '../shared/enum.ts';
import * as BuildingState from './buildingStateEnum.ts';
import * as CommandKind from './commandKindEnum.ts';
import {BUILDING_DEFS} from './defs/buildings.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as GoodId from './defs/goodIdEnum.ts';
import type {Building} from './entities.ts';
import {paidBuildTicks} from './systems/construction.ts';
import {addSerf, addStorehouse, bareWorld, cmds} from './testUtils.ts';
import {tickWorld} from './tick.ts';
import {placeSite, type World} from './world.ts';

type GoodId = Enum<typeof GoodId>;

/**
 * A site rises as it is paid for.
 *
 * It used to be all or nothing: not one tick of progress until every good
 * had landed, so a building was a long silence and then a sudden roof. The
 * Monument made the cost of that obvious — sixty-odd goods hauled to the far
 * end of the map, and a frame that sat at a fifth of its hit points looking
 * broken the whole way — but the rule was never about the Monument. Every
 * building in the game reads better rising.
 */

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

/**
 * Hand a site `n` of a good, the way `deliver` does (systems/logistics.ts).
 *
 * A construction material is consumed into the frame — `siteNeeds` comes
 * down and the good is ledgered away — and does NOT sit in `inputs`. Only
 * the borrowed hammer stays in the site's hands, because it is a loan the
 * site gives back. Modelling it any other way would leave these tests
 * asserting against a delivery the game never makes.
 */
function deliverTo(site: Building, good: GoodId, n: number): void {
  for (let i = 0; i < n; i++) {
    site.siteNeeds![good] = Math.max(0, (site.siteNeeds![good] ?? 0) - 1);
    if (good === GoodId.hammer) {
      site.inputs[good] = (site.inputs[good] ?? 0) + 1;
    }
  }
}

/**
 * A quarry site holding its borrowed hammer, with a serf free beside it.
 *
 * Not a builder already bound: the staffing system recruits and walks one
 * over the ticks each test then runs, which is the path the real game takes
 * and the one worth exercising. What this guarantees is only that a builder
 * CAN arrive — the tool is there for him and a hand is free — so a test that
 * stalls is stalling on the rule under test rather than on an empty village.
 * Materials are the caller's to deliver.
 */
function manned(world: World): Building {
  const site = placeSite(world, BuildingTypeId.quarry, 0, 24, 30);
  deliverTo(site, GoodId.hammer, 1);
  addSerf(world, 25, 31);
  return site;
}

/**
 * Placing costs nothing. The bill is what the site is owed, not what the
 * castle must be holding before a plan may be pegged out, and the sim has
 * never charged a toll at placement — but the build ribbon used to grey out
 * every button the stores could not cover, which said the opposite to the
 * only player who could not argue with it. These are the sim-side half of
 * that rule, so a gate re-grown anywhere fails here rather than quietly in
 * a menu nobody tests.
 */
describe('a site is placed on credit', () => {
  // A house rather than the quarry the rest of this file uses: these two go
  // through the real command path, which enforces placement rules, and a
  // quarry wants a rock seam beside it before it will stand anywhere.
  const HOUSE = BUILDING_DEFS[BuildingTypeId.house];

  function orderHouse(world: World): Building | undefined {
    tickWorld(
      world,
      cmds({
        kind: CommandKind.placeBuilding,
        building: BuildingTypeId.house,
        x: 24,
        y: 30,
      }),
    );
    return [...world.buildings.values()].find(
      b => b.type === BuildingTypeId.house,
    );
  }

  it('takes the order with the stores stripped bare', () => {
    const world = bareWorld();
    // Not one plank of the house's six, and no tools either: the emptiest
    // village the game can hold.
    addStorehouse(world, 30, 30, {
      [GoodId.wood]: 0,
      [GoodId.stone]: 0,
      [GoodId.hammer]: 0,
    });
    const site = orderHouse(world);
    expect(site?.state).toBe(BuildingState.site);
    expect(site?.siteNeeds?.[GoodId.wood]).toBe(HOUSE.cost[GoodId.wood]);
  });

  it('spends nothing at placement: the goods are hauled, not billed', () => {
    const world = bareWorld();
    const wood = HOUSE.cost[GoodId.wood]!;
    const stone = HOUSE.cost[GoodId.stone]!;
    const store = addStorehouse(world, 30, 30, {
      [GoodId.wood]: wood,
      [GoodId.stone]: stone,
    });
    expect(orderHouse(world)?.state).toBe(BuildingState.site);
    // Still on the shelf. It leaves in a serf's hands, one load at a time,
    // and a village that could pay cash up front is not a village that got
    // its house any sooner.
    expect(store.stock[GoodId.wood]).toBe(wood);
    expect(store.stock[GoodId.stone]).toBe(stone);
  });
});

describe('a frame rises as far as it is paid for', () => {
  it('buys build ticks in proportion to the goods that have landed', () => {
    // The quarry costs six wood, so each plank buys a sixth of the frame.
    const def = BUILDING_DEFS[BuildingTypeId.quarry];
    const world = bareWorld();
    const site = placeSite(world, BuildingTypeId.quarry, 0, 24, 30);
    expect(paidBuildTicks(site, def)).toBe(0); // nothing delivered, nothing bought

    deliverTo(site, GoodId.wood, 3);
    expect(paidBuildTicks(site, def)).toBe(Math.floor(def.buildTicks / 2));

    deliverTo(site, GoodId.wood, 3);
    expect(paidBuildTicks(site, def)).toBe(def.buildTicks);
  });

  it('counts goods, not kinds: thirty stone owed is most of a Monument', () => {
    // A share by kind would call a monument owing all its stone "two thirds
    // paid" on the strength of the gold and the bread. The bill is 12 gold,
    // 30 stone and 20 food, so the stone alone is nearly half of it.
    const def = BUILDING_DEFS[BuildingTypeId.monument];
    const world = bareWorld();
    const site = placeSite(world, BuildingTypeId.monument, 0, 24, 30);
    deliverTo(site, GoodId.gold, def.cost[GoodId.gold]!);
    deliverTo(site, GoodId.food, def.cost[GoodId.food]!);
    const share = paidBuildTicks(site, def) / def.buildTicks;
    expect(share).toBeGreaterThan(0.4);
    expect(share).toBeLessThan(0.6);
  });

  it('the borrowed hammer is a tool, not a share of the bill', () => {
    // It is a loan (placeSite) and comes back at the end, so it is what the
    // builder raises the frame WITH rather than part of what the frame is
    // made of. A site holding nothing but a hammer has bought no work.
    const def = BUILDING_DEFS[BuildingTypeId.quarry];
    const world = bareWorld();
    const site = placeSite(world, BuildingTypeId.quarry, 0, 24, 30);
    deliverTo(site, GoodId.hammer, 1);
    expect(paidBuildTicks(site, def)).toBe(0);
  });
});

describe('the frame in the world', () => {
  it('stops at what it has paid for, and goes on when the next load lands', () => {
    const def = BUILDING_DEFS[BuildingTypeId.quarry];
    const world = bareWorld();
    const site = manned(world);
    deliverTo(site, GoodId.wood, 3); // half the bill

    run(world, def.buildTicks * 2);
    expect(site.state).toBe(BuildingState.site); // ...and not a tick further
    expect(site.buildProgress).toBe(Math.floor(def.buildTicks / 2));

    deliverTo(site, GoodId.wood, 3); // the rest
    run(world, def.buildTicks);
    expect(site.state).toBe(BuildingState.built);
  });

  it('will not rise at all with nothing delivered, however long it stands', () => {
    // The old rule and the new one agree here, and it is the half worth
    // keeping: a frame nobody has paid for is a frame, not a building.
    const world = bareWorld();
    const site = manned(world);
    run(world, BUILDING_DEFS[BuildingTypeId.quarry].buildTicks * 3);
    expect(site.buildProgress ?? 0).toBe(0);
    expect(site.state).toBe(BuildingState.site);
  });

  it('needs the hammer in hand, not merely on the way', () => {
    const def = BUILDING_DEFS[BuildingTypeId.quarry];
    const world = bareWorld();
    const site = placeSite(world, BuildingTypeId.quarry, 0, 24, 30);
    addSerf(world, 25, 31);
    deliverTo(site, GoodId.wood, 6); // every plank, no tool
    run(world, def.buildTicks * 2);
    expect(site.buildProgress ?? 0).toBe(0);

    deliverTo(site, GoodId.hammer, 1);
    // Twice the build time, because the recruit was never sent while there
    // was no tool for him: a builder is wanted only where there is bought
    // work he can actually do (staffing.ts), so the walk starts here.
    run(world, def.buildTicks * 2);
    expect(site.state).toBe(BuildingState.built);
  });

  it('firms up as it rises: a part-built frame is tougher than a bare one', () => {
    // hp climbs with progress, so an early delivery buys durability as well
    // as height — which is the half of this that a raider notices.
    const def = BUILDING_DEFS[BuildingTypeId.quarry];
    const world = bareWorld();
    const site = manned(world);
    const bare = site.hp;
    deliverTo(site, GoodId.wood, 3);
    run(world, def.buildTicks);
    expect(site.hp).toBeGreaterThan(bare);
    expect(site.hp).toBeLessThan(def.hp);
  });

  it('makes a road pay for its stone, though it lays itself', () => {
    // Copilot caught this on #238, and it was real. A road pays no hammer
    // loan and needs no builder — "roads pave themselves" — and an earlier
    // cut of this change read those two exemptions as a third: it capped a
    // road at its full height regardless of delivery, which paved every road
    // in the game free and cancelled the stone already walking towards it
    // (a finished site's hauls are reconciled away). The rule this replaced
    // made roads wait for the stone like everything else.
    const def = BUILDING_DEFS[BuildingTypeId.roadSite];
    const world = bareWorld();
    const site = placeSite(world, BuildingTypeId.roadSite, 0, 24, 30);
    expect(site.siteNeeds?.[GoodId.stone]).toBe(def.cost[GoodId.stone]);

    run(world, def.buildTicks * 3);
    expect(site.dead, 'an unpaid road has not paved itself').toBe(false);
    expect(site.buildProgress ?? 0).toBe(0);

    deliverTo(site, GoodId.stone, def.cost[GoodId.stone]!);
    run(world, def.buildTicks + 2);
    // A finished road destroys its own site and paves the tile.
    expect(site.dead).toBe(true);
  });

  it('banks nothing: a frame that falls is gone, part-built or not', () => {
    // What keeps a half-raised Monument worth marching on. Progress is not
    // stored anywhere but the site, and the site is what the raiders break.
    const def = BUILDING_DEFS[BuildingTypeId.quarry];
    const world = bareWorld();
    const site = manned(world);
    deliverTo(site, GoodId.wood, 5);
    run(world, def.buildTicks);
    expect(site.buildProgress ?? 0).toBeGreaterThan(0);

    const again = placeSite(world, BuildingTypeId.quarry, 0, 34, 30);
    expect(again.buildProgress ?? 0).toBe(0);
    expect(again.siteNeeds?.[GoodId.wood]).toBe(def.cost[GoodId.wood]);
  });
});
