import { describe, expect, it } from 'vitest';
import { createWorld, placeBuiltBuilding, placeSite, spawnUnit } from './world.ts';
import { tickWorld } from './tick.ts';
import { hiringSystem } from './systems/training.ts';
import { popCapOf, populationOf, hasRoomToHire, pendingHiresOf } from './population.ts';
import { HIRE_SERF_COST, HIRE_SERF_TICKS, START_SERFS } from './defs/balance.ts';
import { BUILDING_DEFS } from './defs/buildings.ts';
import { addSerf, addStorehouse, bareWorld, cmds } from './testUtils.ts';
import { GoodId } from './defs/goods.ts';
import { UnitTypeId } from './defs/units.ts';

/**
 * The population cap. Beds, not bodies, are the ceiling: the castle sleeps
 * ten and every finished house another ten, and the only way through it is
 * to build.
 */
describe('the population cap', () => {
  /** A one-seat world with a castle full of silver and `serfs` people. */
  function village(serfs: number, silver = 100) {
    const world = bareWorld();
    const sh = addStorehouse(world, 10, 10, { [GoodId.silver]: silver });
    for (let i = 0; i < serfs; i++) addSerf(world, 20 + i, 20);
    return { world, sh };
  }

  it('starts every village at ten beds under the castle', () => {
    const world = createWorld({ seed: 20260724, players: [{ kind: 'human' }] });
    expect(popCapOf(world, 0)).toBe(BUILDING_DEFS.storehouse.housing);
    expect(popCapOf(world, 0)).toBe(10);
    // Eight serfs under ten roofs: room to replace a loss, not to grow on.
    expect(populationOf(world, 0)).toBe(START_SERFS);
  });

  it('counts workers and soldiers, not just idle serfs', () => {
    const { world } = village(0);
    spawnUnit(world, UnitTypeId.serf, 0, 5, 5);
    spawnUnit(world, UnitTypeId.worker, 0, 6, 5);
    spawnUnit(world, UnitTypeId.knight, 0, 7, 5);
    expect(populationOf(world, 0)).toBe(3);
  });

  it('leaves the dead and other seats out of the count', () => {
    const { world } = village(0);
    spawnUnit(world, UnitTypeId.serf, 0, 5, 5);
    spawnUnit(world, UnitTypeId.serf, 0, 6, 5).dead = true;
    spawnUnit(world, UnitTypeId.serf, 1, 7, 5);
    expect(populationOf(world, 0)).toBe(1);
  });

  it('refuses a hire once every bed is taken, and keeps the silver', () => {
    const { world, sh } = village(10); // 10 people under the castle's 10 beds
    expect(hasRoomToHire(world, 0)).toBe(false);
    tickWorld(world, cmds({ kind: 'hireSerf' }));
    expect(sh.hireQueue ?? 0).toBe(0);
    expect(sh.stock[GoodId.silver]).toBe(100); // not spent on a hire that never happened
  });

  it('counts recruits already on the road against the beds', () => {
    const { world, sh } = village(8); // two beds free
    for (let i = 0; i < 5; i++) tickWorld(world, cmds({ kind: 'hireSerf' }));
    // Five orders, two beds: three are refused rather than overshooting.
    expect(sh.hireQueue).toBe(2);
    expect(pendingHiresOf(world, 0)).toBe(2);
    expect(sh.stock[GoodId.silver]).toBe(100 - 2 * HIRE_SERF_COST);
  });

  it('lets a finished house pay for ten more, but not a site', () => {
    const { world } = village(10);
    const site = placeSite(world, 'house', 0, 30, 30);
    expect(popCapOf(world, 0)).toBe(10); // a roof under construction sleeps nobody
    expect(hasRoomToHire(world, 0)).toBe(false);

    site.state = 'built';
    expect(popCapOf(world, 0)).toBe(20);
    expect(hasRoomToHire(world, 0)).toBe(true);
  });

  it('adds ten per house, and takes them back when one falls', () => {
    const { world } = village(0);
    const a = placeBuiltBuilding(world, 'house', 0, 30, 30);
    placeBuiltBuilding(world, 'house', 0, 34, 30);
    expect(popCapOf(world, 0)).toBe(30);
    a.dead = true;
    expect(popCapOf(world, 0)).toBe(20);
  });

  it('holds a paid recruit at the gate until a bed opens', () => {
    const { world, sh } = village(9); // one bed free
    tickWorld(world, cmds({ kind: 'hireSerf' }));
    expect(sh.hireQueue).toBe(1);

    // The bed is taken while the recruit is still walking in.
    addSerf(world, 40, 40);
    for (let t = 0; t < HIRE_SERF_TICKS + 50; t++) hiringSystem(world);
    expect(sh.hireQueue).toBe(1); // still owed, not silently eaten
    expect(populationOf(world, 0)).toBe(10);

    // A house goes up and the recruit walks straight in.
    placeBuiltBuilding(world, 'house', 0, 30, 30);
    hiringSystem(world);
    expect(sh.hireQueue).toBe(0);
    expect(populationOf(world, 0)).toBe(11);
  });
});
