import {describe, expect, it} from 'vitest';
import {tileIdx} from '../shared/grid.ts';
import {exactDist} from '../shared/math.ts';
import * as CommandKind from './commandKindEnum.ts';
import {checkInvariants} from './debug/invariants.ts';
import * as UnitTypeId from './defs/unitTypeIdEnum.ts';
import {BANDIT} from './entities.ts';
import {hashWorld} from './hash.ts';
import {SEPARATION} from './systems/separation.ts';
import {addStorehouse, bareWorld, cmds} from './testUtils.ts';
import {tickWorld} from './tick.ts';
import type {Unit} from './units.ts';
import {spawnUnit, type World} from './world.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

function dist(a: Unit, b: Unit): number {
  return exactDist(a.x - b.x, a.y - b.y);
}

/** The closest any two of these stand to one another. */
function closestPair(units: readonly Unit[]): number {
  let min = Infinity;
  for (let i = 0; i < units.length; i++)
    for (let j = i + 1; j < units.length; j++)
      min = Math.min(min, dist(units[i]!, units[j]!));
  return min;
}

/**
 * Soldiers hold each other off; serfs walk through everyone. The push is
 * soft — no tile is ever claimed — so nothing here can deadlock, but every
 * soldier still ends up with room around him, which is what stops a squad
 * that converged on one target from being drawn as one man.
 */
describe('soldiers take up room', () => {
  it('parts two knights standing on one spot, at a walk rather than a leap', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const a = spawnUnit(world, UnitTypeId.knight, 0, 30.5, 30.5);
    const b = spawnUnit(world, UnitTypeId.knight, 0, 30.5, 30.5);

    tickWorld(world, []);
    // One tick moves them, but no further than a stride: a stack that
    // sprang apart would read as a glitch, not a crowd making room.
    expect(dist(a, b)).toBeGreaterThan(0);
    expect(dist(a, b)).toBeLessThan(0.2);

    run(world, 20);
    expect(dist(a, b)).toBeGreaterThanOrEqual(SEPARATION - 1e-9);
    // Parted, not scattered: they are still standing together.
    expect(dist(a, b)).toBeLessThan(SEPARATION + 0.1);
    checkInvariants(world);
  });

  it('leaves a serf and a soldier sharing a tile exactly where they are', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 30.5, 30.5);
    spawnUnit(world, UnitTypeId.serf, 0, 30.5, 30.5);
    // Two serfs on the knight as well: civilians do not push each other
    // either, so however many stand here the knight is not moved.
    spawnUnit(world, UnitTypeId.serf, 0, 30.5, 30.5);
    spawnUnit(world, UnitTypeId.worker, 0, 30.5, 30.5);

    run(world, 30);
    expect(knight.x).toBe(30.5);
    expect(knight.y).toBe(30.5);
  });

  it('never shoves a soldier onto blocked ground', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const size = world.map.size;
    // A one-tile cell: every neighbor of (10, 10) is a wall.
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (dx !== 0 || dy !== 0)
          world.map.blocked[tileIdx(10 + dx, 10 + dy, size)] = 1;
    const a = spawnUnit(world, UnitTypeId.knight, 0, 10.5, 10.5);
    const b = spawnUnit(world, UnitTypeId.knight, 0, 10.5, 10.5);
    const c = spawnUnit(world, UnitTypeId.spearman, 0, 10.5, 10.5);

    run(world, 40);
    for (const u of [a, b, c]) {
      expect(Math.floor(u.x)).toBe(10);
      expect(Math.floor(u.y)).toBe(10);
    }
    // Room was still made where there was room to make it.
    expect(closestPair([a, b, c])).toBeGreaterThan(0);
  });

  it('leaves a formation dealt a tile apart exactly as dealt', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const squad = [
      spawnUnit(world, UnitTypeId.knight, 0, 20.5, 30.5),
      spawnUnit(world, UnitTypeId.knight, 0, 20.5, 31.5),
      spawnUnit(world, UnitTypeId.knight, 0, 20.5, 32.5),
      spawnUnit(world, UnitTypeId.knight, 0, 20.5, 33.5),
    ];
    tickWorld(
      world,
      cmds({
        kind: CommandKind.moveUnits,
        unitIds: squad.map(u => u.id),
        x: 30,
        y: 30,
      }),
    );
    run(world, 20 * 30);
    // Arrived: each on his own tile center, and not nudged off it — the
    // spread order already keeps soldiers a whole tile apart, which is
    // further than they hold each other off.
    for (const u of squad) {
      expect(u.path).toBeNull();
      expect(u.x % 1).toBe(0.5);
      expect(u.y % 1).toBe(0.5);
    }
    expect(closestPair(squad)).toBeGreaterThanOrEqual(1);
  });
});

/**
 * The scene this exists for: a squad piles onto one enemy. Without room
 * between them, every attacker stopped at the first point of his own route
 * that was within reach, and six men arriving down one road stood on one
 * spot. With it they fan out into a ring — still all within reach, so the
 * fight is no slower, but each man on his own patch of ground.
 */
describe('a squad closing on one enemy', () => {
  function battle(): {world: World; knights: Unit[]; target: Unit} {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const target = spawnUnit(world, UnitTypeId.marauder, BANDIT, 40.5, 30.5);
    // Nobody dies: the fight should run the whole way through so the ring
    // has time to settle, and so a death cannot be what spaced them.
    target.hp = target.maxHp = 1e6;
    const knights: Unit[] = [];
    for (let i = 0; i < 6; i++) {
      const k = spawnUnit(world, UnitTypeId.knight, 0, 20.5, 30.5 + i * 0.01);
      k.hp = k.maxHp = 1e6;
      knights.push(k);
    }
    tickWorld(
      world,
      cmds({
        kind: CommandKind.moveUnits,
        unitIds: knights.map(k => k.id),
        x: 40,
        y: 30,
        attack: true,
      }),
    );
    return {world, knights, target};
  }

  it('fans out into a ring within reach instead of a stack', () => {
    const {world, knights, target} = battle();
    run(world, 20 * 20);

    // The fight is on, and everyone is in it.
    expect(target.hp).toBeLessThan(1e6);
    for (const k of knights) expect(k.targetId).toBe(target.id);
    // Each within his own reach of the target (1.3, a shove's worth of slack
    // for the men on the outside of the ring being nudged as they swing)...
    for (const k of knights) expect(dist(k, target)).toBeLessThan(1.3 + 0.3);
    // ...and no two of them in one place. A little under SEPARATION: a man
    // pushed out this tick may be pushed back in the next by the ring
    // behind him, and the cap means the crowd settles rather than snaps.
    expect(closestPair(knights)).toBeGreaterThan(SEPARATION * 0.8);
    checkInvariants(world);
  });

  it('is the same fight every time it is fought', () => {
    const a = battle();
    const b = battle();
    run(a.world, 20 * 10);
    run(b.world, 20 * 10);
    expect(hashWorld(a.world)).toBe(hashWorld(b.world));
  });
});
