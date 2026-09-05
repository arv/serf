import {describe, expect, it} from 'vitest';
import {tileIdx} from '../shared/grid.ts';
import {MONUMENT_HOLD_TICKS} from './defs/balance.ts';
import {BUILDING_DEFS} from './defs/buildings.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as MatchState from './matchStateEnum.ts';
import {addStorehouse, bareWorld} from './testUtils.ts';
import {tickWorld} from './tick.ts';
import * as TileResource from './tileResourceEnum.ts';
import {
  destroyBuilding,
  placeBuiltBuilding,
  placementRefusal,
  placeSite,
  type World,
} from './world.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

/** A gold seam on one tile — all the monument's placement rule asks for. */
function plantGold(world: World, x: number, y: number): void {
  const i = tileIdx(x, y, world.map.size);
  world.map.resource[i] = TileResource.GoldDep;
  world.map.resourceAmt[i] = 6;
}

/**
 * A two-seat world with seat 0's monument standing on the gold. Two seats
 * because the elimination rules end a one-seat match the moment the only
 * castle falls, which would hide whatever the hold clock did.
 */
function withMonument(): {
  world: World;
  monument: ReturnType<typeof placeBuiltBuilding>;
} {
  const world = bareWorld(1, 2);
  addStorehouse(world, 10, 10, {}, 0);
  addStorehouse(world, 50, 50, {}, 1);
  plantGold(world, 30, 30);
  const monument = placeBuiltBuilding(
    world,
    BuildingTypeId.monument,
    0,
    32,
    30,
  );
  return {world, monument};
}

function placementRefusalFor(
  world: World,
  x: number,
  y: number,
): string | null {
  return placementRefusal(world.map, BuildingTypeId.monument, x, y);
}

function placeSiteAt(
  world: World,
  x: number,
  y: number,
): ReturnType<typeof placeSite> {
  return placeSite(world, BuildingTypeId.monument, 0, x, y);
}

describe('the monument', () => {
  it('stands only within reach of a gold seam', () => {
    const world = bareWorld();
    // Flat, empty grass: every other rule this def answers to is satisfied,
    // so a refusal here can only be the seam rule.
    expect(placementRefusalFor(world, 32, 30)).toBe('seam');
    plantGold(world, 30, 30);
    expect(placementRefusalFor(world, 32, 30)).toBeNull();
    // ...and only within its radius. The def's 4 is measured from the
    // footprint, so a seam 12 tiles off is out of reach by any reading.
    expect(placementRefusalFor(world, 44, 30)).toBe('seam');
  });

  it('is gated behind Deep Mining, the tech that opens the gold at all', () => {
    expect(BUILDING_DEFS[BuildingTypeId.monument].requiresTech).toBeDefined();
  });

  it('wins the match once it has stood the full hold', () => {
    const {world} = withMonument();
    run(world, MONUMENT_HOLD_TICKS - 2);
    expect(world.outcome.state).toBe(MatchState.playing);

    run(world, 4);
    expect(world.outcome).toEqual({state: MatchState.over, winner: 0});
  });

  it('counts only while it stands: razing it takes the clock with it', () => {
    const {world, monument} = withMonument();
    run(world, MONUMENT_HOLD_TICKS - 100);
    expect(monument.holdTicks).toBeGreaterThan(0);

    destroyBuilding(world, monument);
    run(world, 400);
    // Well past the tick the hold would have come good on, and nobody has
    // won: the count died with the stone rather than surviving on the
    // player, which is the whole reason the hold is worth contesting.
    expect(world.outcome.state).toBe(MatchState.playing);
  });

  it('a second monument starts the hold again from nothing', () => {
    const {world, monument} = withMonument();
    run(world, MONUMENT_HOLD_TICKS - 100);
    destroyBuilding(world, monument);
    const rebuilt = placeBuiltBuilding(
      world,
      BuildingTypeId.monument,
      0,
      32,
      30,
    );
    run(world, 200);
    expect(rebuilt.holdTicks).toBeLessThan(MONUMENT_HOLD_TICKS);
    expect(world.outcome.state).toBe(MatchState.playing);
  });

  it('a site does not count — only a finished monument holds', () => {
    const world = bareWorld(1, 2);
    addStorehouse(world, 10, 10, {}, 0);
    addStorehouse(world, 50, 50, {}, 1);
    plantGold(world, 30, 30);
    const site = placeSiteAt(world, 32, 30);
    run(world, 600);
    expect(site.holdTicks ?? 0).toBe(0);
    expect(world.outcome.state).toBe(MatchState.playing);
  });
});
