import {describe, expect, it} from 'vitest';
import {tileIdx} from '../shared/grid.ts';
import * as BuildingState from './buildingStateEnum.ts';
import {BUILDING_DEFS} from './defs/buildings.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as GoodId from './defs/goodIdEnum.ts';
import * as MatchState from './matchStateEnum.ts';
import {addStorehouse, bareWorld} from './testUtils.ts';
import {tickWorld} from './tick.ts';
import * as TileResource from './tileResourceEnum.ts';
import {
  depleteResourceTile,
  destroyBuilding,
  placeBuiltBuilding,
  placementRefusal,
  placeSite,
  type World,
} from './world.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

/** A gold seam on one tile: what a gold mine works, and what the twelve
 * gold in the monument's price ultimately come out of. */
function plantGold(world: World, x: number, y: number): void {
  const i = tileIdx(x, y, world.map.size);
  world.map.resource[i] = TileResource.GoldDep;
  world.map.resourceAmt[i] = 6;
}

/**
 * Two seats and a gold seam. Two because the elimination rules end a
 * one-seat match the moment the only castle falls, which would hide
 * whatever the monument did.
 */
function valley(): World {
  const world = bareWorld(1, 2);
  addStorehouse(world, 10, 10, {}, 0);
  addStorehouse(world, 50, 50, {}, 1);
  plantGold(world, 30, 30);
  return world;
}

function refusalFor(world: World, x: number, y: number): string | null {
  return placementRefusal(world.map, BuildingTypeId.monument, x, y);
}

describe('the monument', () => {
  it('stands on any ground its owner can clear, seam or no seam', () => {
    // It was pinned within four tiles of a gold seam once, which put the
    // one building that wins on the economy out on the one patch of ground
    // worldgen deals to nobody. The contest is the price now: the twelve
    // gold in `cost` come from the middle of the map wherever the plinth
    // goes up (map.ts, mapFairness.test.ts).
    const world = bareWorld();
    // Flat, empty grass, and nothing buried anywhere on the map.
    expect(refusalFor(world, 32, 30)).toBeNull();
    // The ground it used to be refused: as far from gold as the map goes.
    plantGold(world, 30, 30);
    expect(refusalFor(world, 60, 60)).toBeNull();
  });

  it('answers to the rules every building answers to, all the same', () => {
    // Free of the seam is not free of the ground. A footprint on standing
    // material is still refused — this is the check that would catch a
    // placement rule dropped wholesale rather than the one rule it was.
    const world = bareWorld();
    plantGold(world, 30, 30);
    expect(refusalFor(world, 30, 30)).toBe('occupied');
    placeBuiltBuilding(world, BuildingTypeId.storehouse, 0, 40, 40);
    expect(refusalFor(world, 40, 40)).toBe('occupied');
  });

  it('stands where a seam was worked out, the way it stands anywhere', () => {
    // The trap the old rule was, kept as a test because the failure it
    // guards against is the expensive one: a campaign seat with the tech
    // and the step in its playbook had 72 legal sites at t=5000 and 0 from
    // t=62500 — it had dug its own gold, and digging it deleted every site
    // for the thing the gold was for. Gold leaves bare ground now like
    // every other seam (`depleteResourceTile`), and bare ground builds.
    const world = bareWorld();
    plantGold(world, 30, 30);
    const i = tileIdx(30, 30, world.map.size);

    // Work it out, one load at a time, the way a mine does.
    while (world.map.resource[i] === TileResource.GoldDep)
      depleteResourceTile(world, i);

    expect(world.map.resource[i]).toBe(TileResource.None);
    expect(world.map.resourceAmt[i]).toBe(0);
    // No mine will ever work this tile again...
    expect(placementRefusal(world.map, BuildingTypeId.goldMine, 29, 29)).toBe(
      'resource',
    );
    // ...and the monument stands on it, tailings and all.
    expect(refusalFor(world, 30, 30)).toBeNull();
    expect(refusalFor(world, 32, 30)).toBeNull();
  });

  it('is gated behind Deep Mining, the tech that opens the gold at all', () => {
    expect(BUILDING_DEFS[BuildingTypeId.monument].requiresTech).toBeDefined();
  });

  it('finishing it wins the match', () => {
    const world = valley();
    expect(world.outcome.state).toBe(MatchState.playing);
    placeBuiltBuilding(world, BuildingTypeId.monument, 0, 32, 30);
    run(world, 2);
    expect(world.outcome).toEqual({state: MatchState.over, winner: 0});
  });

  it('an unfinished one wins nothing, however long it stands', () => {
    const world = valley();
    const site = placeSite(world, BuildingTypeId.monument, 0, 32, 30);
    // No hauler in this world, so the frame stands owed its whole bill.
    run(world, 6000);
    expect(site.state).toBe(BuildingState.site); // never topped out
    expect(world.outcome.state).toBe(MatchState.playing);
  });

  it('breaking the frame ends it: there is nothing banked to resume', () => {
    const world = valley();
    const site = placeSite(world, BuildingTypeId.monument, 0, 32, 30);
    // A site stands at a fifth of the finished building's hit points, which
    // is what makes the raising the place to contest it.
    expect(site.hp).toBeLessThan(BUILDING_DEFS[BuildingTypeId.monument].hp / 2);
    destroyBuilding(world, site);
    run(world, 600);
    expect(world.outcome.state).toBe(MatchState.playing);
  });

  it('costs gold, stone and bread — a price no single chain can pay', () => {
    // The identity is the gold; the bread is what makes it hurt, now that
    // the mines eat too. A monument bought only with gold would be paid for
    // in the one good nothing else in the game wants.
    const cost = BUILDING_DEFS[BuildingTypeId.monument].cost;
    expect(cost[GoodId.gold]).toBeGreaterThan(0);
    expect(cost[GoodId.stone]).toBeGreaterThan(0);
    expect(cost[GoodId.food]).toBeGreaterThan(0);
  });
});
