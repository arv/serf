import { describe, expect, it } from 'vitest';
import { tickWorld } from './tick.ts';
import { placeBuiltBuilding, type World } from './world.ts';
import { checkInvariants } from './debug/invariants.ts';
import { addSerf, addSite, addStorehouse, bareWorld } from './testUtils.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

/**
 * Mid-game repro: haul demand never dries up (mills far from the storehouse
 * keep the job board non-empty), so the every-tick job dispatcher claims each
 * serf the moment he goes idle. The 25-tick recruitment sweep then always
 * finds an empty pool — a fully supplied site sits with no builder for ages.
 */
describe('builder recruitment under sustained haul pressure', () => {
  it('a fully supplied site still gets a builder while hauls queue', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { wood: 40, wheat: 500 });
    // Mills need no resident; each books up to 4 inbound wheat and keeps
    // consuming, so open jobs exist essentially every tick.
    placeBuiltBuilding(world, 'mill', 0, 4, 4);
    placeBuiltBuilding(world, 'mill', 0, 4, 56);
    placeBuiltBuilding(world, 'mill', 0, 56, 4);
    placeBuiltBuilding(world, 'mill', 0, 56, 56);
    placeBuiltBuilding(world, 'mill', 0, 4, 30);
    placeBuiltBuilding(world, 'mill', 0, 56, 30);
    const site = addSite(world, 36, 30);
    addSerf(world, 32, 34);
    addSerf(world, 33, 34);

    // Run until the site's materials are fully delivered.
    let guard = 0;
    while (
      Object.values(site.siteNeeds ?? {}).some((n) => n > 0) &&
      guard++ < 6000
    ) {
      tickWorld(world, []);
    }
    expect(Object.values(site.siteNeeds ?? {}).every((n) => n === 0)).toBe(true);

    // The wait must be bounded: the starvation clock escalates the site to
    // every-tick claiming, which then wins the next serf who frees up. (It
    // is a bound, not a beat — the serf still finishes the haul he is on.)
    const suppliedAt = world.tick;
    guard = 0;
    while (site.workerId === undefined && guard++ < 3000) tickWorld(world, []);
    expect(site.workerId).toBeDefined();
    expect(world.tick - suppliedAt).toBeLessThan(1500);

    run(world, 50);
    expect(checkInvariants(world).violations).toEqual([]);
  });
});
