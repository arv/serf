import { describe, expect, it } from 'vitest';
import { tickWorld } from './tick.ts';
import { placeBuiltBuilding, type World } from './world.ts';
import { addStorehouse, bareWorld, cmds, staffBuilding } from './testUtils.ts';
import { GoodId } from './defs/goods.ts';
import { BuildingTypeId } from './defs/buildings.ts';

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
    const smith = placeBuiltBuilding(world, BuildingTypeId.weaponsmith, 0, 30, 30);
    staffBuilding(world, smith);
    smith.inputs[GoodId.iron] = 1;
    smith.inputs[GoodId.wood] = 5;
    // A fresh Smith idles on auto; pin the standing order on spears.
    tickWorld(world, cmds({ kind: 'setBuildingRecipe', buildingId: smith.id, index: 0 }));

    let guard = 0;
    while (smith.prodTicksLeft === undefined && guard++ < 100) tickWorld(world, []);
    expect(smith.prodTicksLeft).toBeDefined();

    // ...switch to bows mid-batch: the spear still comes out first.
    tickWorld(world, cmds({ kind: 'setBuildingRecipe', buildingId: smith.id, index: 2 }));
    guard = 0;
    while ((smith.stock[GoodId.spear] ?? 0) === 0 && guard++ < 5000) tickWorld(world, []);
    expect(smith.stock[GoodId.spear]).toBe(1);
    expect(smith.stock[GoodId.bow] ?? 0).toBe(0);

    // The next batch is the new selection.
    guard = 0;
    while ((smith.stock[GoodId.bow] ?? 0) === 0 && guard++ < 5000) tickWorld(world, []);
    expect(smith.stock[GoodId.bow]).toBe(1);
  });

  it('refuses a recipe whose tech is missing', () => {
    const world = bareWorld();
    addStorehouse(world, 24, 24, {}); // stay alive across ticks
    world.players[0]!.techs.researched.push('ironworking'); // no archery
    const smith = placeBuiltBuilding(world, BuildingTypeId.weaponsmith, 0, 30, 30);
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
    const smith = placeBuiltBuilding(world, BuildingTypeId.weaponsmith, 0, 30, 30);
    tickWorld(world, [
      { playerId: 1, cmd: { kind: 'setBuildingRecipe', buildingId: smith.id, index: 1 } },
    ]);
    expect(smith.recipeIndex).toBeUndefined();
  });
});

/**
 * The Smith's order of service: the queue first, then the standing order,
 * then auto — forge whatever tool the village most lacks, or nothing.
 */
describe('the forge queue', () => {
  function forgeWorld() {
    const world = bareWorld();
    // Zero the fixture tool kit: these tests measure the tool economy
    // itself, and a shelf of spare axes covers every gap auto would see.
    addStorehouse(world, 24, 24, { [GoodId.axe]: 0, [GoodId.pickaxe]: 0, [GoodId.scythe]: 0, [GoodId.hammer]: 0, [GoodId.cauldron]: 0, [GoodId.rod]: 0 });
    world.players[0]!.techs.researched.push('ironworking', 'archery');
    const smith = placeBuiltBuilding(world, BuildingTypeId.weaponsmith, 0, 30, 30);
    staffBuilding(world, smith);
    return { world, smith };
  }

  it('works orders ahead of the standing order, then falls back', () => {
    const { world, smith } = forgeWorld();
    smith.inputs[GoodId.iron] = 4;
    smith.inputs[GoodId.wood] = 8;
    // One beat: standing order on spears, one bow ordered ahead of it.
    // (Two beats would let a spear batch take the fire between them, and a
    // batch on the fire finishes as what it started as.)
    tickWorld(
      world,
      cmds(
        { kind: 'setBuildingRecipe', buildingId: smith.id, index: 0 },
        { kind: 'enqueueForge', buildingId: smith.id, recipeIndex: 2 },
      ),
    );

    let guard = 0;
    while ((smith.stock[GoodId.bow] ?? 0) === 0 && guard++ < 5000) tickWorld(world, []);
    expect(smith.stock[GoodId.bow]).toBe(1);
    expect(smith.stock[GoodId.spear] ?? 0).toBe(0); // the order jumped the line
    expect(smith.forgeQueue).toBeUndefined(); // worked off and struck

    guard = 0;
    while ((smith.stock[GoodId.spear] ?? 0) === 0 && guard++ < 5000) tickWorld(world, []);
    expect(smith.stock[GoodId.spear]).toBe(1); // then back to the standing order
  });

  it('cancelling a started order keeps the batch on the fire', () => {
    const { world, smith } = forgeWorld();
    smith.inputs[GoodId.iron] = 4;
    smith.inputs[GoodId.wood] = 8;
    tickWorld(world, cmds({ kind: 'enqueueForge', buildingId: smith.id, recipeIndex: 2 }));
    let guard = 0;
    while (smith.prodTicksLeft === undefined && guard++ < 100) tickWorld(world, []);
    expect(smith.forgeQueue![0]!.started).toBe(true);

    tickWorld(
      world,
      cmds({ kind: 'cancelForge', buildingId: smith.id, index: 0, recipeIndex: 2 }),
    );
    expect(smith.forgeQueue).toBeUndefined();
    guard = 0;
    while ((smith.stock[GoodId.bow] ?? 0) === 0 && guard++ < 5000) tickWorld(world, []);
    expect(smith.stock[GoodId.bow]).toBe(1); // the batch still lands, exactly once
    tickWorld(world, []);
    expect(smith.stock[GoodId.bow]).toBe(1);
  });

  it('a stale cancel misses instead of striking a neighbour', () => {
    const { world, smith } = forgeWorld();
    tickWorld(world, cmds({ kind: 'enqueueForge', buildingId: smith.id, recipeIndex: 2 }));
    tickWorld(world, cmds({ kind: 'enqueueForge', buildingId: smith.id, recipeIndex: 0 }));
    // The player saw [bow, spear] and clicked slot 0 to cancel the bow —
    // but by then the bow was already struck; slot 0 now holds the spear.
    smith.forgeQueue!.splice(0, 1);
    tickWorld(
      world,
      cmds({ kind: 'cancelForge', buildingId: smith.id, index: 0, recipeIndex: 2 }),
    );
    expect(smith.forgeQueue).toHaveLength(1); // the spear order survived
    expect(smith.forgeQueue![0]!.recipeIndex).toBe(0);
  });

  it('a tech-locked recipe cannot be enqueued', () => {
    const world = bareWorld();
    addStorehouse(world, 24, 24, {});
    world.players[0]!.techs.researched.push('ironworking'); // no archery
    const smith = placeBuiltBuilding(world, BuildingTypeId.weaponsmith, 0, 30, 30);
    tickWorld(world, cmds({ kind: 'enqueueForge', buildingId: smith.id, recipeIndex: 2 }));
    expect(smith.forgeQueue).toBeUndefined();
  });

  it('auto forges the tool the village most lacks, then goes cold', () => {
    const { world, smith } = forgeWorld();
    smith.inputs[GoodId.iron] = 4;
    smith.inputs[GoodId.wood] = 8;
    // recipeIndex stays undefined: auto. An open post that wants an axe...
    const hut = placeBuiltBuilding(world, BuildingTypeId.woodcutter, 0, 36, 36);
    expect(hut.workerId).toBeUndefined();

    let guard = 0;
    while ((smith.stock[GoodId.axe] ?? 0) === 0 && guard++ < 5000) tickWorld(world, []);
    expect(smith.stock[GoodId.axe]).toBe(1);

    // ...and once the gap is covered (one axe free, one post open), the
    // fire goes cold rather than burning iron on surplus.
    const iron = smith.inputs[GoodId.iron] ?? 0;
    for (let i = 0; i < 400; i++) tickWorld(world, []);
    expect(smith.inputs[GoodId.iron]).toBe(iron);
  });

  it('auto with every rack served forges nothing at all', () => {
    const { world, smith } = forgeWorld();
    smith.inputs[GoodId.iron] = 4;
    smith.inputs[GoodId.wood] = 8;
    for (let i = 0; i < 400; i++) tickWorld(world, []);
    expect(smith.prodTicksLeft).toBeUndefined();
    expect(smith.inputs[GoodId.iron]).toBe(4);
  });
});
