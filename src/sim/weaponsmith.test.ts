import { describe, expect, it } from 'vitest';
import { tickWorld } from './tick.ts';
import { placeBuiltBuilding, type World } from './world.ts';
import { addStorehouse, bareWorld, cmds, staffBuilding } from './testUtils.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

/**
 * The weaponsmith's forge menu: one building, three weapons, the player
 * picks. Recipes are tech-gated individually, and a batch already on the
 * fire finishes as what it started as.
 */
describe('the weaponsmith', () => {
  it('forges what the menu says, and a switch waits for the batch', () => {
    const world = bareWorld();
    addStorehouse(world, 24, 24, {}); // the elimination token: stay alive
    world.players[0]!.techs.researched.push('ironworking', 'archery');
    const smith = placeBuiltBuilding(world, 'weaponsmith', 0, 30, 30);
    staffBuilding(world, smith);
    smith.inputs.iron = 1;
    smith.inputs.wood = 5;

    // Default option is the spear. Let the batch start...
    let guard = 0;
    while (smith.prodTicksLeft === undefined && guard++ < 100) tickWorld(world, []);
    expect(smith.prodTicksLeft).toBeDefined();

    // ...switch to bows mid-batch: the spear still comes out first.
    tickWorld(world, cmds({ kind: 'setBuildingRecipe', buildingId: smith.id, index: 2 }));
    guard = 0;
    while ((smith.stock.spear ?? 0) === 0 && guard++ < 5000) tickWorld(world, []);
    expect(smith.stock.spear).toBe(1);
    expect(smith.stock.bow ?? 0).toBe(0);

    // The next batch is the new selection.
    guard = 0;
    while ((smith.stock.bow ?? 0) === 0 && guard++ < 5000) tickWorld(world, []);
    expect(smith.stock.bow).toBe(1);
  });

  it('refuses a recipe whose tech is missing', () => {
    const world = bareWorld();
    addStorehouse(world, 24, 24, {}); // stay alive across ticks
    world.players[0]!.techs.researched.push('ironworking'); // no archery
    const smith = placeBuiltBuilding(world, 'weaponsmith', 0, 30, 30);
    tickWorld(world, cmds({ kind: 'setBuildingRecipe', buildingId: smith.id, index: 2 }));
    expect(smith.recipeIndex).toBeUndefined();
    tickWorld(world, cmds({ kind: 'setBuildingRecipe', buildingId: smith.id, index: 1 }));
    expect(smith.recipeIndex).toBe(1);
  });

  it('a rival cannot work your forge menu', () => {
    const world = bareWorld(1, 2);
    addStorehouse(world, 24, 24, {});
    addStorehouse(world, 40, 40, {}, 1);
    world.players[0]!.techs.researched.push('ironworking');
    world.players[1]!.techs.researched.push('ironworking');
    const smith = placeBuiltBuilding(world, 'weaponsmith', 0, 30, 30);
    tickWorld(world, [
      { playerId: 1, cmd: { kind: 'setBuildingRecipe', buildingId: smith.id, index: 1 } },
    ]);
    expect(smith.recipeIndex).toBeUndefined();
  });
});
