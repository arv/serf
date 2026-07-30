import { describe, expect, it } from 'vitest';
import { BANDIT } from './entities';
import { tickWorld } from './tick';
import { placeBuiltBuilding, spawnUnit, spawnUnitNearby, type World } from './world';
import { Terrain } from './map';
import { COUNTER_TABLE, UNIT_DEFS } from './defs/units';
import { checkInvariants } from './debug/invariants';
import { cmds, addSerf, addStorehouse, bareWorld } from './testUtils';

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

  it('samurai (heavy) beats ashigaru (light) in a straight duel', () => {
    const world = bareWorld();
    const samurai = spawnUnit(world, 'samurai', 0, 30.5, 30.5);
    spawnUnit(world, 'ashigaru', BANDIT, 31.5, 30.5);
    run(world, 20 * 30);
    expect(samurai.dead).toBe(false);
    expect([...world.units.values()].filter((u) => u.owner === BANDIT)).toEqual([]);
  });

  it('ashigaru (light) catches and kills the archer (ranged)', () => {
    const world = bareWorld();
    const ashigaru = spawnUnit(world, 'ashigaru', 0, 30.5, 30.5);
    spawnUnit(world, 'archer', BANDIT, 33.5, 30.5);
    run(world, 20 * 30);
    expect(ashigaru.dead).toBe(false);
    expect([...world.units.values()].filter((u) => u.owner === BANDIT)).toEqual([]);
  });

  it('archer (ranged) kites down the ronin (heavy)', () => {
    const world = bareWorld();
    const archer = spawnUnit(world, 'archer', 0, 30.5, 30.5);
    spawnUnit(world, 'ronin', BANDIT, 34.5, 30.5);
    run(world, 20 * 40);
    expect(archer.dead).toBe(false);
    expect([...world.units.values()].filter((u) => u.owner === BANDIT)).toEqual([]);
  });
});

describe('dojo training', () => {
  it('trains a samurai from hauled rice + katana', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { rice: 10, katana: 2 });
    const dojo = placeBuiltBuilding(world, 'dojo', 0, 36, 30);
    addSerf(world, 34, 34);
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: dojo.id, unit: 'samurai' }));

    // Samurai isn't tech-gated (only its katana chain is), so the queue fills.
    expect(dojo.trainQueue?.length).toBe(1);
    run(world, 20 * 60);
    const samurai = [...world.units.values()].find((u) => u.kind === 'samurai');
    expect(samurai).toBeDefined();
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('gates gated units until their tech lands', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { rice: 10, yumi: 2 });
    const dojo = placeBuiltBuilding(world, 'dojo', 0, 36, 30);
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: dojo.id, unit: 'archer' }));
    expect(dojo.trainQueue ?? []).toEqual([]);

    world.players[0]!.techs.researched.push('bushido', 'archery');
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: dojo.id, unit: 'archer' }));
    expect(dojo.trainQueue?.length).toBe(1);
  });

  it('a stuck head does not block trainable units behind it (skip-ahead)', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { rice: 10, yari: 2 }); // yari, but no katana
    world.players[0]!.techs.researched.push('bushido');
    const dojo = placeBuiltBuilding(world, 'dojo', 0, 36, 30);
    addSerf(world, 34, 34);
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: dojo.id, unit: 'samurai' }));
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: dojo.id, unit: 'ashigaru' }));
    run(world, 20 * 90);

    // The samurai still waits for its katana; the ashigaru trained anyway.
    expect([...world.units.values()].some((u) => u.kind === 'ashigaru')).toBe(true);
    expect(dojo.trainQueue?.some((q) => q.unit === 'samurai' && !q.started)).toBe(true);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('applies militaryHp modifiers at spawn', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { rice: 10, yari: 2 });
    world.players[0]!.techs.researched.push('bushido', 'lamellarArmor');
    const dojo = placeBuiltBuilding(world, 'dojo', 0, 36, 30);
    addSerf(world, 34, 34);
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: dojo.id, unit: 'ashigaru' }));
    run(world, 20 * 60);
    const ashigaru = [...world.units.values()].find((u) => u.kind === 'ashigaru');
    expect(ashigaru).toBeDefined();
    expect(ashigaru!.hp).toBe(Math.round(UNIT_DEFS.ashigaru.hp * 1.25));
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
    spawnUnit(world, 'samurai', 0, 36.5, 30.5);
    run(world, 20 * 60);
    expect(world.outcome).toEqual({ state: 'over', winner: 0 });
  });

  it('idle soldiers ignore enemy buildings beyond acquire range', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const camp = placeBuiltBuilding(world, 'banditCamp', BANDIT, 50, 30);
    const samurai = spawnUnit(world, 'samurai', 0, 32.5, 30.5);
    run(world, 20 * 10);
    expect(camp.dead).toBe(false);
    expect(samurai.x).toBeLessThan(35); // held position, no cross-map crusade
  });

  it('attack-ordered samurai raze the camp and win the game', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const camp = placeBuiltBuilding(world, 'banditCamp', BANDIT, 40, 30);
    camp.hp = 60;
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) ids.push(spawnUnit(world, 'samurai', 0, 36.5, 29.5 + i).id);
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
