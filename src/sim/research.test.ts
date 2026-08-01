import { describe, expect, it } from 'vitest';
import { tickWorld } from './tick.ts';
import { placeBuiltBuilding, type World } from './world.ts';
import { TECH_DEFS } from './defs/techs.ts';
import { FESTIVAL_DURATION } from './defs/balance.ts';
import { getModifier, isBuildingUnlocked } from './techHelpers.ts';
import { cmds, addStorehouse, bareWorld, staffBuilding } from './testUtils.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

function setupSchool(world: World): void {
  addStorehouse(world, 30, 30, { wheat: 50, silver: 50, stone: 20, wood: 20, ale: 10, iron: 10 });
  placeBuiltBuilding(world, 'abbey', 0, 24, 30);
}

describe('research', () => {
  it('requires a abbey', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { wheat: 50, silver: 50 });
    tickWorld(world, cmds({ kind: 'research', tech: 'irrigation' }));
    expect(world.players[0]!.techs.active).toBeUndefined();
  });

  it('pays the cost, takes time, then applies', () => {
    const world = bareWorld();
    setupSchool(world);
    const silverBefore = 50;
    tickWorld(world, cmds({ kind: 'research', tech: 'cobbledBoots' }));

    expect(world.players[0]!.techs.active?.tech).toBe('cobbledBoots');
    const sh = [...world.buildings.values()].find((b) => b.type === 'storehouse')!;
    expect(sh.stock.silver).toBe(silverBefore - (TECH_DEFS.cobbledBoots.cost.silver ?? 0));
    expect(getModifier(world, 0, 'serfSpeed')).toBe(1);

    run(world, TECH_DEFS.cobbledBoots.durationTicks + 2);
    expect(world.players[0]!.techs.researched).toContain('cobbledBoots');
    expect(world.players[0]!.techs.active).toBeUndefined();
    expect(getModifier(world, 0, 'serfSpeed')).toBeCloseTo(1.15);
  });

  it('enforces prereqs and one-at-a-time', () => {
    const world = bareWorld();
    setupSchool(world);
    // ironworking requires cobbledBoots — rejected.
    tickWorld(world, cmds({ kind: 'research', tech: 'ironworking' }));
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
    expect(isBuildingUnlocked(world, 0, 'swordsmith')).toBe(false);

    tickWorld(world, cmds({ kind: 'placeBuilding', building: 'swordsmith', x: 40, y: 40 }));
    expect([...world.buildings.values()].some((b) => b.type === 'swordsmith')).toBe(false);

    world.players[0]!.techs.researched.push('cobbledBoots', 'ironworking');
    expect(isBuildingUnlocked(world, 0, 'swordsmith')).toBe(true);
    tickWorld(world, cmds({ kind: 'placeBuilding', building: 'swordsmith', x: 40, y: 40 }));
    expect([...world.buildings.values()].some((b) => b.type === 'swordsmith')).toBe(true);
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
    const tera = [...world.buildings.values()].find((b) => b.type === 'abbey')!;
    tera.inputs.ale = 1;

    tickWorld(world, []);
    expect(world.players[0]!.techs.festivalTicksLeft).toBeGreaterThan(0);
    expect(tera.inputs.ale ?? 0).toBe(0);
    expect(getModifier(world, 0, 'workSpeed')).toBeCloseTo(1.25);

    run(world, FESTIVAL_DURATION + 2);
    expect(getModifier(world, 0, 'workSpeed')).toBe(1);
  });

  it('modifiers speed up production batches', () => {
    const world = bareWorld();
    const farm = placeBuiltBuilding(world, 'wheatFarm', 0, 30, 30);
    staffBuilding(world, farm);
    farm.inputs.water = 2;
    world.players[0]!.techs.researched.push('irrigation');
    run(world, 2); // batch starts with the modifier applied
    expect(farm.prodTicksLeft).toBeLessThan(200); // 200 base / 1.3 ≈ 154
  });
});
