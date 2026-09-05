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

/** A gold seam on one tile — all the monument's placement rule asks for. */
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
  it('stands only within reach of a gold seam', () => {
    const world = bareWorld();
    // Flat, empty grass: every other rule this def answers to is satisfied,
    // so a refusal here can only be the seam rule.
    expect(refusalFor(world, 32, 30)).toBe('seam');
    plantGold(world, 30, 30);
    expect(refusalFor(world, 32, 30)).toBeNull();
    // ...and only within its radius. The def's 4 is measured from the
    // footprint, so a seam 12 tiles off is out of reach by any reading.
    expect(refusalFor(world, 44, 30)).toBe('seam');
  });

  it('still stands where the seam WAS, once the gold is dug out', () => {
    // The trap this rule used to be. A gold seam is finite and the mission
    // that wants a monument also wants a gold mine, so the obvious order of
    // play — dig the gold, then raise the thing it is for — deleted every
    // legal site on the map the moment the last tile went dry. Measured on
    // a campaign seat with the tech and the step in its playbook: 72 legal
    // sites at t=5000, and 0 from t=62500, holding 108 gold it could not
    // spend anywhere.
    const world = bareWorld();
    plantGold(world, 30, 30);
    const i = tileIdx(30, 30, world.map.size);
    expect(refusalFor(world, 32, 30)).toBeNull();

    // Work it out, one load at a time, the way a mine does.
    while (world.map.resource[i] === TileResource.GoldDep)
      depleteResourceTile(world, i);

    // The ore is gone and no mine will ever work this tile again...
    expect(world.map.resource[i]).toBe(TileResource.GoldSpoil);
    expect(world.map.resourceAmt[i]).toBe(0);
    expect(placementRefusal(world.map, BuildingTypeId.goldMine, 29, 29)).toBe(
      'resource',
    );
    // ...but the ground remembers what it was, so the monument still stands.
    expect(refusalFor(world, 32, 30)).toBeNull();
  });

  it('takes the tailings as its own footprint, not just its neighbour', () => {
    // Spoil is dirt, not standing material. Before it existed the same tile
    // went back to bare grass and took a building like any other ground, so
    // refusing one here would be a regression wearing a rule's clothes —
    // and the tailings are the last place THIS building should be unwelcome.
    const world = bareWorld();
    for (let x = 29; x <= 33; x++)
      for (let y = 29; y <= 33; y++) plantGold(world, x, y);
    for (let x = 29; x <= 33; x++)
      for (let y = 29; y <= 33; y++) {
        const i = tileIdx(x, y, world.map.size);
        while (world.map.resource[i] === TileResource.GoldDep)
          depleteResourceTile(world, i);
      }
    // A footprint standing entirely on worked-out ground.
    expect(refusalFor(world, 30, 30)).toBeNull();
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
