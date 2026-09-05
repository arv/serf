import {describe, expect, it} from 'vitest';
import {tileIdx} from '../shared/grid.ts';
import * as GoodId from './defs/goodIdEnum.ts';
import * as HaulPhase from './haulPhaseEnum.ts';
import {addSerf, addSite, addStorehouse, bareWorld} from './testUtils.ts';
import {tickWorld} from './tick.ts';
import type {World} from './world.ts';

/** Wall a serf in where he stands, without building anything on him. */
function stranded(world: World, x: number, y: number): number {
  const serf = addSerf(world, x, y);
  const size = world.map.size;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      world.map.blocked[tileIdx(x + dx, y + dy, size)] = 1;
    }
  }
  return serf.id;
}

/**
 * dispatch offers each haul to the nearest idle serf. When that man cannot
 * path to the pickup the fault is his, not the job's — but the job used to
 * wear it: backed off, tried again, and after four goes aborted as
 * unreachable with a 600-tick demand backoff on its destination. Since the
 * stranded man stayed in the pool he was nearest again every time, so one
 * of him could stop a village's haulage while everybody else stood idle.
 */
describe('a haul whose nearest serf is walled in', () => {
  it('goes to the next serf who can reach the source', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, {[GoodId.wood]: 10});
    addSite(world, 24, 30);

    // Near the storehouse and going nowhere. Clear of its ring on
    // purpose: findPathToAdjacent counts any tile touching the building as
    // arrival, so a serf parked against the wall is already "there" and no
    // amount of walling in makes him unreachable.
    const stuck = stranded(world, 36, 31);
    // Further off, and perfectly able to walk.
    const walker = addSerf(world, 45, 45);

    for (let i = 0; i < 20; i++) tickWorld(world, []);

    const jobs = [...world.jobs.values()];
    expect(jobs.length).toBeGreaterThan(0);
    const claimed = jobs.filter(j => j.serfId !== undefined);
    expect(claimed.length).toBeGreaterThan(0);
    for (const j of claimed) expect(j.serfId).not.toBe(stuck);
    expect(claimed.some(j => j.serfId === walker.id)).toBe(true);
    expect(sh.id).toBeDefined();
  });

  it('keeps the village working instead of stalling on him', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {[GoodId.wood]: 10});
    const site = addSite(world, 24, 30); // wants 6 wood and the hammer loan
    stranded(world, 36, 31);
    for (let i = 0; i < 4; i++) addSerf(world, 45 + i, 45);

    for (let i = 0; i < 400; i++) tickWorld(world, []);

    // The measure is not "no job was ever backed off" — once every
    // reachable hand is out, backing off is the honest answer. It is that
    // wood arrives at all. Before, the stranded man was nearest to every
    // haul out of that storehouse, each was aborted as unreachable in
    // turn, and the site sat needing all six forever.
    const left = site.siteNeeds?.[GoodId.wood] ?? 0;
    expect(left).toBeLessThan(6);

    // Not zero, and deliberately not asserted as zero. A second flaw
    // upstream of this one is still live: when the only idle serf at some
    // instant happens to be the stranded one, the job still takes a
    // blockedCount, and four such instants abort it with a 600-tick demand
    // backoff on the site — "no free hands right now" read as "this source
    // is walled off". Skipping the man was never going to fix the counting.
    expect(left).toBeGreaterThan(0);
  });
});
