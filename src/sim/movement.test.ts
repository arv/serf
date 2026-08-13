import { describe, expect, it } from 'vitest';
import { tileIdx } from '../shared/grid.ts';
import { tickWorld } from './tick.ts';
import { checkInvariants } from './debug/invariants.ts';
import { addStorehouse, bareWorld, cmds } from './testUtils.ts';
import { spawnUnit, type World } from './world.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

/**
 * A null path is how every owner system reads "the walk is over", and it
 * cannot tell that from "the walk failed". Dropping the route when a building
 * lands on it therefore either finishes an errand from wherever the unit
 * stands, or — for a plain move, the one task with no owner system — strands
 * the unit for good.
 *
 * Knights, not serfs: an idle serf strolls, which would muddy where a walk
 * actually ended. The storehouse is the elimination token — without one the
 * player is dead within a few ticks and every later order is ignored.
 */
describe('a route obstructed mid-walk', () => {
  it('routes around a building dropped on the path instead of stopping dead', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const knight = spawnUnit(world, 'knight', 0, 30.5, 30.5);
    tickWorld(world, cmds({ kind: 'moveUnits', unitIds: [knight.id], x: 40, y: 30 }));
    expect(knight.task.t).toBe('move');
    run(world, 10); // under way, well short of the goal

    world.map.blocked[knight.path![knight.pathIdx]!] = 1;
    tickWorld(world, []);

    // The walk is still live: had it been reported finished here, an owner
    // system would have run its arrival from most of the way across the map.
    expect(knight.path).not.toBeNull();
    expect(knight.x).toBeLessThan(35);

    run(world, 20 * 30);
    expect(Math.floor(knight.x)).toBe(40);
    expect(Math.floor(knight.y)).toBe(30);
    expect(knight.task.t).toBe('idle');
  });

  it('releases a unit whose goal is walled off, rather than stranding it', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const knight = spawnUnit(world, 'knight', 0, 30.5, 30.5);
    tickWorld(world, cmds({ kind: 'moveUnits', unitIds: [knight.id], x: 40, y: 30 }));
    run(world, 10);

    const path = knight.path!;
    world.map.blocked[path[path.length - 1]!] = 1; // the destination itself
    world.map.blocked[path[knight.pathIdx]!] = 1; // and the step that breaks the walk
    tickWorld(world, []);

    // Idle is the state every other system recruits from — wander, the job
    // dispatcher, staffing. Left on 'move' he was invisible to all of them.
    expect(knight.task.t).toBe('idle');
    expect(knight.path).toBeNull();
    expect(checkInvariants(world).violations).toEqual([]);

    // And he is genuinely available again: a fresh order still moves him.
    tickWorld(world, cmds({ kind: 'moveUnits', unitIds: [knight.id], x: 30, y: 36 }));
    run(world, 20 * 30);
    expect(Math.floor(knight.y)).toBe(36);
  });

  it('a column ordered through a wall that goes up behind it still arrives, all of it', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push(spawnUnit(world, 'knight', 0, 30.5, 29.5 + i).id);
    tickWorld(world, cmds({ kind: 'moveUnits', unitIds: ids, x: 42, y: 30 }));
    run(world, 10);

    // A wall across the whole column's route, bar one gap far to the south.
    for (let y = 20; y < 42; y++) {
      if (y !== 38) world.map.blocked[tileIdx(35, y)] = 1;
    }
    run(world, 20 * 90);

    // An AI army waits on every member reaching idle before it attacks, so
    // one straggler left on 'move' used to hang the whole sweep.
    for (const id of ids) {
      const u = world.units.get(id)!;
      expect(u.task.t).toBe('idle');
      expect(u.x).toBeGreaterThan(35);
    }
    expect(checkInvariants(world).violations).toEqual([]);
  });
});
