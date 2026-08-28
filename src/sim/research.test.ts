import { describe, expect, it } from 'vitest';
import { tickWorld } from './tick.ts';
import { placeBuiltBuilding, type World } from './world.ts';
import { TECH_DEFS } from './defs/techs.ts';
import { BARRACKS_ALE_CAP, FESTIVAL_DURATION } from './defs/balance.ts';
import { getModifier, isBuildingUnlocked } from './techHelpers.ts';
import { cmds, addSerf, addStorehouse, bareWorld, staffBuilding } from './testUtils.ts';
import { GoodId } from './defs/goods.ts';
import { UnitTypeId } from './defs/units.ts';
import { BuildingTypeId } from './defs/buildings.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

function setupSchool(world: World): void {
  addStorehouse(world, 30, 30, { [GoodId.wheat]: 50, [GoodId.silver]: 50, [GoodId.stone]: 20, [GoodId.wood]: 20, [GoodId.ale]: 10, [GoodId.iron]: 10 });
  placeBuiltBuilding(world, BuildingTypeId.abbey, 0, 24, 30);
}

describe('research', () => {
  it('requires a abbey', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { [GoodId.wheat]: 50, [GoodId.silver]: 50 });
    tickWorld(world, cmds({ kind: 'research', tech: 'irrigation' }));
    expect(world.players[0]!.techs.active).toBeUndefined();
  });

  it('pays the cost, takes time, then applies', () => {
    const world = bareWorld();
    setupSchool(world);
    const silverBefore = 50;
    tickWorld(world, cmds({ kind: 'research', tech: 'cobbledBoots' }));

    expect(world.players[0]!.techs.active?.tech).toBe('cobbledBoots');
    const sh = [...world.buildings.values()].find((b) => b.type === BuildingTypeId.storehouse)!;
    expect(sh.stock[GoodId.silver]).toBe(silverBefore - (TECH_DEFS.cobbledBoots.cost[GoodId.silver] ?? 0));
    expect(getModifier(world, 0, 'serfSpeed')).toBe(1);

    run(world, TECH_DEFS.cobbledBoots.durationTicks + 2);
    expect(world.players[0]!.techs.researched).toContain('cobbledBoots');
    expect(world.players[0]!.techs.active).toBeUndefined();
    expect(getModifier(world, 0, 'serfSpeed')).toBeCloseTo(1.15);
  });

  it('enforces prereqs and one-at-a-time', () => {
    const world = bareWorld();
    setupSchool(world);
    // deepMining requires ironworking — rejected. (Ironworking itself is a
    // craft root now: the tool economy cannot wait on boots.)
    tickWorld(world, cmds({ kind: 'research', tech: 'deepMining' }));
    expect(world.players[0]!.techs.active).toBeUndefined();

    tickWorld(world, cmds({ kind: 'research', tech: 'cobbledBoots' }));
    expect(world.players[0]!.techs.active?.tech).toBe('cobbledBoots');
    // A second research while active — rejected.
    tickWorld(world, cmds({ kind: 'research', tech: 'irrigation' }));
    expect(world.players[0]!.techs.active?.tech).toBe('cobbledBoots');
  });

  it('gates buildings until researched', () => {
    const world = bareWorld();
    setupSchool(world);
    // The Smith itself is ungated (the village's only tool source), so the
    // iron mine carries this test now.
    expect(isBuildingUnlocked(world, 0, BuildingTypeId.weaponsmith)).toBe(true);
    expect(isBuildingUnlocked(world, 0, BuildingTypeId.ironMine)).toBe(false);

    tickWorld(world, cmds({ kind: 'placeBuilding', building: BuildingTypeId.ironMine, x: 40, y: 40 }));
    expect([...world.buildings.values()].some((b) => b.type === BuildingTypeId.ironMine)).toBe(false);

    world.players[0]!.techs.researched.push('ironworking');
    expect(isBuildingUnlocked(world, 0, BuildingTypeId.ironMine)).toBe(true);
  });

  it('masonry unlocks paving', () => {
    const world = bareWorld();
    setupSchool(world);
    expect(world.players[0]!.pavingUnlocked).toBe(false);
    world.players[0]!.techs.researched.push('cobbledBoots');
    tickWorld(world, cmds({ kind: 'research', tech: 'masonry' }));
    run(world, TECH_DEFS.masonry.durationTicks + 2);
    expect(world.players[0]!.pavingUnlocked).toBe(true);
  });

  it('festival: abbey burns ale for a work-speed buff', () => {
    const world = bareWorld();
    setupSchool(world);
    world.players[0]!.techs.researched.push('irrigation', 'brewing', 'festivals');
    const tera = [...world.buildings.values()].find((b) => b.type === BuildingTypeId.abbey)!;
    tera.inputs[GoodId.ale] = 1;

    tickWorld(world, []);
    expect(world.players[0]!.techs.festivalTicksLeft).toBeGreaterThan(0);
    expect(tera.inputs[GoodId.ale] ?? 0).toBe(0);
    expect(getModifier(world, 0, 'workSpeed')).toBeCloseTo(1.25);

    run(world, FESTIVAL_DURATION + 2);
    expect(getModifier(world, 0, 'workSpeed')).toBe(1);
  });

  it('modifiers speed up production batches', () => {
    const world = bareWorld();
    const farm = placeBuiltBuilding(world, BuildingTypeId.wheatFarm, 0, 30, 30);
    staffBuilding(world, farm);
    farm.inputs[GoodId.water] = 2;
    world.players[0]!.techs.researched.push('irrigation');
    run(world, 2); // batch starts with the modifier applied
    expect(farm.prodTicksLeft).toBeLessThan(200); // 200 base / 1.3 ≈ 154
  });

  it('millstones speeds the mill and the bakery', () => {
    const world = bareWorld();
    const mill = placeBuiltBuilding(world, BuildingTypeId.mill, 0, 30, 30);
    mill.inputs[GoodId.wheat] = 1;
    const bakery = placeBuiltBuilding(world, BuildingTypeId.bakery, 0, 40, 30);
    staffBuilding(world, bakery);
    bakery.inputs[GoodId.flour] = 1;
    bakery.inputs[GoodId.water] = 1;
    world.players[0]!.techs.researched.push('irrigation', 'millstones');
    expect(getModifier(world, 0, 'foodSpeed')).toBeCloseTo(1.3);
    run(world, 2);
    expect(mill.prodTicksLeft).toBeLessThan(160); // 160 base / 1.3 ≈ 123
    expect(bakery.prodTicksLeft).toBeLessThan(240); // 240 base / 1.3 ≈ 185
  });

  it('bellows speeds the weaponsmith', () => {
    const world = bareWorld();
    const smith = placeBuiltBuilding(world, BuildingTypeId.weaponsmith, 0, 30, 30);
    smith.recipeIndex = 0; // pinned on spears (default is auto)
    staffBuilding(world, smith);
    smith.inputs[GoodId.iron] = 1;
    smith.inputs[GoodId.wood] = 2;
    world.players[0]!.techs.researched.push('cobbledBoots', 'ironworking', 'bellows');
    run(world, 2);
    expect(smith.prodTicksLeft).toBeLessThan(200); // spear: 200 base / 1.3 ≈ 154
  });

  it('ale rations: the barracks cask is kept topped up', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { [GoodId.ale]: 10 });
    world.players[0]!.techs.researched.push(
      'irrigation',
      'brewing',
      'festivals',
      'aleRations',
    );
    const barracks = placeBuiltBuilding(world, BuildingTypeId.barracks, 0, 36, 30);
    addSerf(world, 34, 34);
    run(world, 20 * 60);
    expect(barracks.inputs[GoodId.ale]).toBe(BARRACKS_ALE_CAP);
  });

  it('ale rations: the recruit drinks from the cask and trains faster', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { [GoodId.food]: 10, [GoodId.spear]: 1 });
    world.players[0]!.techs.researched.push(
      'irrigation',
      'brewing',
      'festivals',
      'aleRations',
      'soldiery',
    );
    const barracks = placeBuiltBuilding(world, BuildingTypeId.barracks, 0, 36, 30);
    barracks.inputs[GoodId.ale] = 1;
    addSerf(world, 34, 34);
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: barracks.id, unit: UnitTypeId.spearman }));

    let guard = 20 * 120;
    while (!barracks.trainQueue?.[0]?.started && guard-- > 0) tickWorld(world, []);
    const head = barracks.trainQueue?.[0];
    expect(head?.started).toBe(true);
    // The 200-tick course was set to 200 / 1.25 = 160 at enlistment (the
    // range absorbs the decrements of the tick that flipped `started`).
    expect(head!.ticksLeft).toBeGreaterThan(150);
    expect(head!.ticksLeft).toBeLessThanOrEqual(160);
    expect(barracks.inputs[GoodId.ale] ?? 0).toBe(0); // the drink was drunk
  });
});
