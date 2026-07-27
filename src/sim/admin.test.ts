import { describe, expect, it } from 'vitest';
import { CORPSE_TICKS } from './defs/balance';
import { tickWorld } from './tick';
import { placeBuiltBuilding, type World } from './world';
import { checkInvariants, checkLedger, countGoods } from './debug/invariants';
import { addSerf, addSite, addStorehouse, bareWorld } from './testUtils';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

describe('admin sandbox', () => {
  it('toggleRaids off silences the bandit camp', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    placeBuiltBuilding(world, 'banditCamp', 'bandit', 44, 30);
    world.raidState = { nextRaidTick: 10, wave: 0 };
    tickWorld(world, [{ kind: 'admin', action: 'toggleRaids' }]);
    run(world, 200);

    expect(world.raidState.wave).toBe(0);
    expect([...world.units.values()].filter((u) => u.owner === 'bandit')).toEqual([]);

    // Toggle back on: raids resume.
    tickWorld(world, [{ kind: 'admin', action: 'toggleRaids' }]);
    run(world, 20);
    expect(world.raidState.wave).toBeGreaterThan(0);
  });

  it('clearBandits kills every bandit on the map', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    placeBuiltBuilding(world, 'banditCamp', 'bandit', 44, 30);
    world.raidState = { nextRaidTick: 10, wave: 0 };
    run(world, 40); // a wave spawns and marches
    expect([...world.units.values()].some((u) => u.owner === 'bandit')).toBe(true);

    tickWorld(world, [{ kind: 'admin', action: 'clearBandits' }]);
    // All dead at once; the corpses linger for the death animation...
    expect([...world.units.values()].filter((u) => u.owner === 'bandit' && !u.dead)).toEqual([]);
    // ...then sweep away.
    run(world, CORPSE_TICKS + 1);
    expect([...world.units.values()].filter((u) => u.owner === 'bandit')).toEqual([]);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('grantGoods fills the storehouse and keeps the ledger honest', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, { bamboo: 3 });
    const initial = countGoods(world);
    tickWorld(world, [{ kind: 'admin', action: 'grantGoods' }]);

    expect(sh.stock.bamboo).toBe(28);
    expect(sh.stock.gold).toBe(25);
    expect(checkLedger(world, initial)).toEqual([]);
  });

  it('instantBuild completes sites with no materials', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {}); // nothing in store
    addSerf(world, 29, 34);
    tickWorld(world, [{ kind: 'admin', action: 'toggleInstantBuild' }]);
    const site = addSite(world, 24, 30);
    run(world, 5);

    expect(site.state).toBe('built');
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('spawnParade lines up one of each unit kind, all player-owned', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const before = world.units.size;
    tickWorld(world, [{ kind: 'admin', action: 'spawnParade' }]);

    const spawned = [...world.units.values()].slice(before);
    expect(spawned).toHaveLength(8);
    expect(new Set(spawned.map((u) => u.kind)).size).toBe(8);
    expect(spawned.every((u) => u.owner === 'player')).toBe(true);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('finishResearch completes the active tech immediately', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { rice: 20, silver: 20 });
    placeBuiltBuilding(world, 'terakoya', 'player', 24, 30);
    tickWorld(world, [{ kind: 'research', tech: 'strawSandals' }]);
    expect(world.techs.active?.tech).toBe('strawSandals');

    tickWorld(world, [{ kind: 'admin', action: 'finishResearch' }]);
    run(world, 2);
    expect(world.techs.researched).toContain('strawSandals');
  });
});
