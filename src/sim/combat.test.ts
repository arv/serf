import { describe, expect, it } from 'vitest';
import { BANDIT } from './entities.ts';
import { tickWorld } from './tick.ts';
import { placeBuiltBuilding, spawnUnit, spawnUnitNearby, type World } from './world.ts';
import { Terrain } from './map.ts';
import { COUNTER_TABLE, UNIT_DEFS } from './defs/units.ts';
import { checkInvariants } from './debug/invariants.ts';
import { cmds, addSerf, addStorehouse, bareWorld } from './testUtils.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

describe('the counter triangle', () => {
  it('is a strict rock-paper-scissors table', () => {
    expect(COUNTER_TABLE.heavy.light).toBeGreaterThan(1);
    expect(COUNTER_TABLE.light.ranged).toBeGreaterThan(1);
    expect(COUNTER_TABLE.ranged.heavy).toBeGreaterThan(1);
    expect(COUNTER_TABLE.light.heavy).toBeLessThan(1);
    expect(COUNTER_TABLE.ranged.light).toBeLessThan(1);
    expect(COUNTER_TABLE.heavy.ranged).toBeLessThan(1);
  });

  it('knight (heavy) beats spearman (light) in a straight duel', () => {
    const world = bareWorld();
    const knight = spawnUnit(world, 'knight', 0, 30.5, 30.5);
    spawnUnit(world, 'spearman', BANDIT, 31.5, 30.5);
    run(world, 20 * 30);
    expect(knight.dead).toBe(false);
    expect([...world.units.values()].filter((u) => u.owner === BANDIT)).toEqual([]);
  });

  it('spearman (light) catches and kills the archer (ranged)', () => {
    const world = bareWorld();
    const spearman = spawnUnit(world, 'spearman', 0, 30.5, 30.5);
    spawnUnit(world, 'archer', BANDIT, 33.5, 30.5);
    run(world, 20 * 30);
    expect(spearman.dead).toBe(false);
    expect([...world.units.values()].filter((u) => u.owner === BANDIT)).toEqual([]);
  });

  it('archer (ranged) kites down the marauder (heavy)', () => {
    const world = bareWorld();
    const archer = spawnUnit(world, 'archer', 0, 30.5, 30.5);
    spawnUnit(world, 'marauder', BANDIT, 34.5, 30.5);
    run(world, 20 * 40);
    expect(archer.dead).toBe(false);
    expect([...world.units.values()].filter((u) => u.owner === BANDIT)).toEqual([]);
  });
});

describe('barracks training', () => {
  it('trains a knight from hauled food + sword', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { food: 10, sword: 2 });
    const barracks = placeBuiltBuilding(world, 'barracks', 0, 36, 30);
    addSerf(world, 34, 34);
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: barracks.id, unit: 'knight' }));

    // Knight isn't tech-gated (only its sword chain is), so the queue fills.
    expect(barracks.trainQueue?.length).toBe(1);
    run(world, 20 * 60);
    const knight = [...world.units.values()].find((u) => u.kind === 'knight');
    expect(knight).toBeDefined();
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('gates gated units until their tech lands', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { food: 10, bow: 2 });
    const barracks = placeBuiltBuilding(world, 'barracks', 0, 36, 30);
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: barracks.id, unit: 'archer' }));
    expect(barracks.trainQueue ?? []).toEqual([]);

    world.players[0]!.techs.researched.push('soldiery', 'archery');
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: barracks.id, unit: 'archer' }));
    expect(barracks.trainQueue?.length).toBe(1);
  });

  it('a stuck head does not block trainable units behind it (skip-ahead)', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { food: 10, spear: 2 }); // spear, but no sword
    world.players[0]!.techs.researched.push('soldiery');
    const barracks = placeBuiltBuilding(world, 'barracks', 0, 36, 30);
    addSerf(world, 34, 34);
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: barracks.id, unit: 'knight' }));
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: barracks.id, unit: 'spearman' }));
    run(world, 20 * 90);

    // The knight still waits for its sword; the spearman trained anyway.
    expect([...world.units.values()].some((u) => u.kind === 'spearman')).toBe(true);
    expect(barracks.trainQueue?.some((q) => q.unit === 'knight' && !q.started)).toBe(true);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('cancels an unstarted order outright — nothing was spent yet', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { food: 10, sword: 2 });
    const barracks = placeBuiltBuilding(world, 'barracks', 0, 36, 30);
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: barracks.id, unit: 'knight' }));
    expect(barracks.trainQueue?.length).toBe(1);

    // The unit guard: a click aimed at a slot that no longer holds what the
    // player saw must not cancel whatever sits there now.
    tickWorld(world, cmds({ kind: 'cancelTraining', buildingId: barracks.id, index: 0, unit: 'archer' }));
    expect(barracks.trainQueue?.length).toBe(1);

    tickWorld(world, cmds({ kind: 'cancelTraining', buildingId: barracks.id, index: 0, unit: 'knight' }));
    expect(barracks.trainQueue ?? []).toEqual([]);
    run(world, 20 * 10);
    expect([...world.units.values()].some((u) => u.kind === 'knight')).toBe(false);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('cancelling a started order returns the ingredients and the recruit', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { food: 10, sword: 1 });
    const barracks = placeBuiltBuilding(world, 'barracks', 0, 36, 30);
    addSerf(world, 34, 34);
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: barracks.id, unit: 'knight' }));

    // Run until the serf has hauled the ingredients in and enlisted.
    let guard = 20 * 120;
    while (!barracks.trainQueue?.[0]?.started && guard-- > 0) tickWorld(world, []);
    expect(barracks.trainQueue?.[0]?.started).toBe(true);
    expect([...world.units.values()].filter((u) => u.kind === 'serf' && !u.dead)).toEqual([]);

    tickWorld(world, cmds({ kind: 'cancelTraining', buildingId: barracks.id, index: 0, unit: 'knight' }));
    expect(barracks.trainQueue ?? []).toEqual([]);
    // The meal and the sword are back in the input buffer for the next order…
    expect(barracks.inputs.food).toBe(3);
    expect(barracks.inputs.sword).toBe(1);
    // …and the person walked back out a serf instead of becoming a knight.
    expect([...world.units.values()].filter((u) => u.kind === 'serf' && !u.dead)).toHaveLength(1);
    run(world, 20 * 30);
    expect([...world.units.values()].some((u) => u.kind === 'knight')).toBe(false);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('applies militaryHp modifiers at spawn', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { food: 10, spear: 2 });
    world.players[0]!.techs.researched.push('soldiery', 'mailArmor');
    const barracks = placeBuiltBuilding(world, 'barracks', 0, 36, 30);
    addSerf(world, 34, 34);
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: barracks.id, unit: 'spearman' }));
    run(world, 20 * 60);
    const spearman = [...world.units.values()].find((u) => u.kind === 'spearman');
    expect(spearman).toBeDefined();
    expect(spearman!.hp).toBe(Math.round(UNIT_DEFS.spearman.hp * 1.25));
  });
});

describe('raids and victory', () => {
  it('spawns escalating waves that attack the storehouse', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, {});
    placeBuiltBuilding(world, 'banditCamp', BANDIT, 44, 30);
    world.raidState = { nextRaidTick: 10, wave: 0 };
    run(world, 20 * 60);

    expect(world.raidState.wave).toBeGreaterThan(0);
    expect(world.pendingEvents.some((e) => e.kind === 'raidIncoming')).toBe(true);
    expect(sh.hp).toBeLessThan(500); // they reached it and did damage
  });

  it('losing the storehouse loses the game', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, {});
    placeBuiltBuilding(world, 'banditCamp', BANDIT, 44, 30);
    sh.hp = 1;
    world.raidState = { nextRaidTick: 10, wave: 3 };
    run(world, 20 * 90);
    expect(world.outcome).toEqual({ state: 'over', winner: null });
  });

  it('musters raiders on dry land when the camp sits against water', () => {
    const world = bareWorld();
    // Flood everything south of the camp — where guards would normally form up.
    for (let y = 33; y < 40; y++) {
      for (let x = 26; x < 40; x++) {
        const i = y * 64 + x;
        world.map.terrain[i] = Terrain.Water;
        world.map.blocked[i] = 1;
      }
    }
    const camp = placeBuiltBuilding(world, 'banditCamp', BANDIT, 30, 30);
    const raider = spawnUnitNearby(world, 'bandit', BANDIT, camp.x + 1.5, camp.y + camp.h + 1.5);
    const tile = Math.floor(raider.y) * 64 + Math.floor(raider.x);
    expect(world.map.blocked[tile]).toBe(0);
  });

  it('idle soldiers auto-besiege an enemy building in acquire range', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const camp = placeBuiltBuilding(world, 'banditCamp', BANDIT, 38, 30);
    camp.hp = 60;
    // No orders given: standing near the camp is enough to start the siege.
    spawnUnit(world, 'knight', 0, 36.5, 30.5);
    run(world, 20 * 60);
    expect(world.outcome).toEqual({ state: 'over', winner: 0 });
  });

  it('idle soldiers ignore enemy buildings beyond acquire range', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const camp = placeBuiltBuilding(world, 'banditCamp', BANDIT, 50, 30);
    const knight = spawnUnit(world, 'knight', 0, 32.5, 30.5);
    run(world, 20 * 10);
    expect(camp.dead).toBe(false);
    expect(knight.x).toBeLessThan(35); // held position, no cross-map crusade
  });

  it('attack-ordered knight raze the camp and win the game', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const camp = placeBuiltBuilding(world, 'banditCamp', BANDIT, 40, 30);
    camp.hp = 60;
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) ids.push(spawnUnit(world, 'knight', 0, 36.5, 29.5 + i).id);
    // Right-click on the camp = attack order.
    tickWorld(world, cmds({ kind: 'moveUnits', unitIds: ids, x: 41, y: 31 }));
    run(world, 20 * 60);

    expect(world.outcome).toEqual({ state: 'over', winner: 0 });
    // Attackers stand down instead of turning on the village.
    for (const id of ids) {
      const u = world.units.get(id);
      if (u) expect(u.targetIsBuilding ?? false).toBe(false);
    }
  });
});
