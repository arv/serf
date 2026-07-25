import { describe, expect, it } from 'vitest';
import { tickWorld } from './tick';
import { placeBuiltBuilding, type World } from './world';
import { TECH_DEFS } from './defs/techs';
import { FESTIVAL_DURATION } from './defs/balance';
import { getModifier, isBuildingUnlocked } from './techHelpers';
import { addStorehouse, bareWorld, staffBuilding } from './testUtils';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

function setupSchool(world: World): void {
  addStorehouse(world, 30, 30, { rice: 50, silver: 50, stone: 20, bamboo: 20, sake: 10, iron: 10 });
  placeBuiltBuilding(world, 'terakoya', 'player', 24, 30);
}

describe('research', () => {
  it('requires a terakoya', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { rice: 50, silver: 50 });
    tickWorld(world, [{ kind: 'research', tech: 'irrigation' }]);
    expect(world.techs.active).toBeUndefined();
  });

  it('pays the cost, takes time, then applies', () => {
    const world = bareWorld();
    setupSchool(world);
    const silverBefore = 50;
    tickWorld(world, [{ kind: 'research', tech: 'strawSandals' }]);

    expect(world.techs.active?.tech).toBe('strawSandals');
    const sh = [...world.buildings.values()].find((b) => b.type === 'storehouse')!;
    expect(sh.stock.silver).toBe(silverBefore - (TECH_DEFS.strawSandals.cost.silver ?? 0));
    expect(getModifier(world, 'serfSpeed')).toBe(1);

    run(world, TECH_DEFS.strawSandals.durationTicks + 2);
    expect(world.techs.researched).toContain('strawSandals');
    expect(world.techs.active).toBeUndefined();
    expect(getModifier(world, 'serfSpeed')).toBeCloseTo(1.15);
  });

  it('enforces prereqs and one-at-a-time', () => {
    const world = bareWorld();
    setupSchool(world);
    // ironworking requires strawSandals — rejected.
    tickWorld(world, [{ kind: 'research', tech: 'ironworking' }]);
    expect(world.techs.active).toBeUndefined();

    tickWorld(world, [{ kind: 'research', tech: 'strawSandals' }]);
    expect(world.techs.active?.tech).toBe('strawSandals');
    // A second research while active — rejected.
    tickWorld(world, [{ kind: 'research', tech: 'irrigation' }]);
    expect(world.techs.active?.tech).toBe('strawSandals');
  });

  it('gates buildings until researched', () => {
    const world = bareWorld();
    setupSchool(world);
    expect(isBuildingUnlocked(world, 'swordsmith')).toBe(false);

    tickWorld(world, [{ kind: 'placeBuilding', building: 'swordsmith', x: 40, y: 40 }]);
    expect([...world.buildings.values()].some((b) => b.type === 'swordsmith')).toBe(false);

    world.techs.researched.push('strawSandals', 'ironworking');
    expect(isBuildingUnlocked(world, 'swordsmith')).toBe(true);
    tickWorld(world, [{ kind: 'placeBuilding', building: 'swordsmith', x: 40, y: 40 }]);
    expect([...world.buildings.values()].some((b) => b.type === 'swordsmith')).toBe(true);
  });

  it('masonry unlocks paving', () => {
    const world = bareWorld();
    setupSchool(world);
    expect(world.pavingUnlocked).toBe(false);
    world.techs.researched.push('strawSandals');
    tickWorld(world, [{ kind: 'research', tech: 'masonry' }]);
    run(world, TECH_DEFS.masonry.durationTicks + 2);
    expect(world.pavingUnlocked).toBe(true);
  });

  it('festival: terakoya burns sake for a work-speed buff', () => {
    const world = bareWorld();
    setupSchool(world);
    world.techs.researched.push('irrigation', 'sakeBrewing', 'festivals');
    const tera = [...world.buildings.values()].find((b) => b.type === 'terakoya')!;
    tera.inputs.sake = 1;

    tickWorld(world, []);
    expect(world.techs.festivalTicksLeft).toBeGreaterThan(0);
    expect(tera.inputs.sake ?? 0).toBe(0);
    expect(getModifier(world, 'workSpeed')).toBeCloseTo(1.25);

    run(world, FESTIVAL_DURATION + 2);
    expect(getModifier(world, 'workSpeed')).toBe(1);
  });

  it('modifiers speed up production batches', () => {
    const world = bareWorld();
    const paddy = placeBuiltBuilding(world, 'ricePaddy', 'player', 30, 30);
    staffBuilding(world, paddy);
    paddy.inputs.water = 2;
    world.techs.researched.push('irrigation');
    run(world, 2); // batch starts with the modifier applied
    expect(paddy.prodTicksLeft).toBeLessThan(200); // 200 base / 1.3 ≈ 154
  });
});
