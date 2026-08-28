import { describe, expect, it } from 'vitest';
import { CORPSE_TICKS } from './defs/balance.ts';
import { BANDIT } from './entities.ts';
import { tickWorld } from './tick.ts';
import { placeBuiltBuilding, type World } from './world.ts';
import { checkInvariants, checkLedger, countGoods } from './debug/invariants.ts';
import { cmds, addSerf, addSite, addStorehouse, bareWorld } from './testUtils.ts';
import { GoodId } from './defs/goods.ts';
import { BuildingTypeId } from './defs/buildings.ts';
import { TechId } from './defs/techs.ts';
import { BuildingState } from './entities.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

describe('admin sandbox', () => {
  it('toggleRaids off silences the bandit camp', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    placeBuiltBuilding(world, BuildingTypeId.banditCamp, BANDIT, 44, 30);
    world.raidState = { nextRaidTick: 10, wave: 0 };
    tickWorld(world, cmds({ kind: 'admin', action: 'toggleRaids' }));
    run(world, 200);

    expect(world.raidState.wave).toBe(0);
    expect([...world.units.values()].filter((u) => u.owner === BANDIT)).toEqual([]);

    // Toggle back on: raids resume.
    tickWorld(world, cmds({ kind: 'admin', action: 'toggleRaids' }));
    run(world, 20);
    expect(world.raidState.wave).toBeGreaterThan(0);
  });

  it('clearBandits kills every bandit on the map', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    placeBuiltBuilding(world, BuildingTypeId.banditCamp, BANDIT, 44, 30);
    world.raidState = { nextRaidTick: 10, wave: 0 };
    run(world, 40); // a wave spawns and marches
    expect([...world.units.values()].some((u) => u.owner === BANDIT)).toBe(true);

    tickWorld(world, cmds({ kind: 'admin', action: 'clearBandits' }));
    // All dead at once; the corpses linger for the death animation...
    expect([...world.units.values()].filter((u) => u.owner === BANDIT && !u.dead)).toEqual([]);
    // ...then sweep away.
    run(world, CORPSE_TICKS + 1);
    expect([...world.units.values()].filter((u) => u.owner === BANDIT)).toEqual([]);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('grantGoods fills the storehouse and keeps the ledger honest', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, { [GoodId.wood]: 3 });
    const initial = countGoods(world);
    tickWorld(world, cmds({ kind: 'admin', action: 'grantGoods' }));

    expect(sh.stock[GoodId.wood]).toBe(28);
    expect(sh.stock[GoodId.gold]).toBe(25);
    expect(checkLedger(world, initial)).toEqual([]);
  });

  it('instantBuild completes sites with no materials', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {}); // nothing in store
    addSerf(world, 29, 34);
    tickWorld(world, cmds({ kind: 'admin', action: 'toggleInstantBuild' }));
    const site = addSite(world, 24, 30);
    run(world, 5);

    expect(site.state).toBe(BuildingState.built);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('spawnParade lines up one of each unit kind, all player-owned', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const before = world.units.size;
    tickWorld(world, cmds({ kind: 'admin', action: 'spawnParade' }));

    const spawned = [...world.units.values()].slice(before);
    expect(spawned).toHaveLength(8);
    expect(new Set(spawned.map((u) => u.kind)).size).toBe(8);
    expect(spawned.every((u) => u.owner === 0)).toBe(true);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('finishResearch completes the active tech immediately', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { [GoodId.wheat]: 20, [GoodId.silver]: 20 });
    placeBuiltBuilding(world, BuildingTypeId.abbey, 0, 24, 30);
    tickWorld(world, cmds({ kind: 'research', tech: TechId.cobbledBoots }));
    expect(world.players[0]!.techs.active?.tech).toBe(TechId.cobbledBoots);

    tickWorld(world, cmds({ kind: 'admin', action: 'finishResearch' }));
    run(world, 2);
    expect(world.players[0]!.techs.researched).toContain(TechId.cobbledBoots);
  });
});
