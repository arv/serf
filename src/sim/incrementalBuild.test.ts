import {describe, expect, it} from 'vitest';
import type {Enum} from '../shared/enum.ts';
import * as BuildingState from './buildingStateEnum.ts';
import {BUILDING_DEFS} from './defs/buildings.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as GoodId from './defs/goodIdEnum.ts';
import type {Building} from './entities.ts';
import {paidBuildTicks} from './systems/construction.ts';
import {addSerf, bareWorld} from './testUtils.ts';
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

/** A quarry site with a builder standing on it and the hammer in hand — the
 * state a site reaches the moment its first load and its recruit arrive. */
function manned(world: World): Building {
  const site = placeSite(world, BuildingTypeId.quarry, 0, 24, 30);
  site.inputs[GoodId.hammer] = 1;
  delete site.siteNeeds![GoodId.hammer];
  addSerf(world, 25, 31);
  return site;
}

/** Hand a site `n` of a good, the way a delivery does. */
function deliverTo(site: Building, good: GoodId, n: number): void {
  site.inputs[good] = (site.inputs[good] ?? 0) + n;
  site.siteNeeds![good] = Math.max(0, (site.siteNeeds![good] ?? 0) - n);
}

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
    site.inputs[GoodId.hammer] = 1;
    site.siteNeeds![GoodId.hammer] = 0;
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

    site.inputs[GoodId.hammer] = 1;
    site.siteNeeds![GoodId.hammer] = 0;
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
