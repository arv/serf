import { describe, expect, it } from 'vitest';
import { tickWorld } from './tick.ts';
import { killUnit, spawnUnit, type World } from './world.ts';
import { checkInvariants } from './debug/invariants.ts';
import { addBuiltHut, addSerf, addSite, addStorehouse, bareWorld, cmds } from './testUtils.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

/**
 * A builder's death must never orphan a site: staffing re-recruits from
 * the loose serf pool, whether the loss happens at the frame, on the walk
 * over, or while the village briefly has no free hands at all.
 */
describe("a builder's death never orphans the site", () => {
  it('a dead builder is replaced and the site still completes', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { bamboo: 20 });
    const site = addSite(world, 36, 30);
    for (let i = 0; i < 4; i++) addSerf(world, 32, 33 + i);
    let guard = 0;
    while ((site.buildProgress ?? 0) < 5 && guard++ < 2000) tickWorld(world, []);
    const firstBuilder = site.workerId!;
    killUnit(world, world.units.get(firstBuilder)!);
    guard = 0;
    while (site.state !== 'built' && guard++ < 4000) tickWorld(world, []);
    expect(site.state).toBe('built');
    expect(site.workerId).not.toBe(firstBuilder);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('a recruit killed on the walk over is also replaced', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { bamboo: 20 });
    const site = addSite(world, 36, 30);
    for (let i = 0; i < 4; i++) addSerf(world, 32, 33 + i);
    // Run until someone is en route to staff the site, then kill them.
    let guard = 0;
    while (site.recruitId === undefined && guard++ < 2000) tickWorld(world, []);
    expect(site.recruitId).toBeDefined();
    killUnit(world, world.units.get(site.recruitId!)!);
    guard = 0;
    while (site.state !== 'built' && guard++ < 4000) tickWorld(world, []);
    expect(site.state).toBe('built');
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('with nobody free, the site waits and takes the next serf who appears', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { bamboo: 20 });
    const site = addSite(world, 36, 30);
    for (let i = 0; i < 2; i++) addSerf(world, 32, 33 + i);
    let guard = 0;
    while ((site.buildProgress ?? 0) < 5 && guard++ < 2000) tickWorld(world, []);
    const firstBuilder = site.workerId!;
    // Kill the builder AND every loose serf: the village is out of hands.
    killUnit(world, world.units.get(firstBuilder)!);
    for (const u of world.units.values()) {
      if (!u.dead && u.kind === 'serf') killUnit(world, u);
    }
    run(world, 300);
    expect(site.state).toBe('site'); // stalled, correctly — nobody to send
    // A new serf arrives (hire); the site should claim him.
    spawnUnit(world, 'serf', 0, 30.5, 34.5);
    guard = 0;
    while (site.state !== 'built' && guard++ < 4000) tickWorld(world, []);
    expect(site.state).toBe('built');
    expect(checkInvariants(world).violations).toEqual([]);
  });
});

describe('the dismiss escape hatch', () => {
  it('breaks the no-silver/no-serfs deadlock: dismissed worker builds the new site', () => {
    const world = bareWorld();
    // Silver is gone, and every last serf holds a post: nobody to haul,
    // nobody to build — the deadlock from the field report.
    addStorehouse(world, 30, 30, { bamboo: 20, silver: 0 });
    const huts = [addBuiltHut(world, 25, 30), addBuiltHut(world, 25, 34)];
    const site = addSite(world, 36, 30);
    run(world, 300);
    expect(site.buildProgress ?? 0).toBe(0); // truly stuck
    expect((site.siteNeeds?.bamboo ?? 0)).toBeGreaterThan(0);

    // The player releases one worker.
    tickWorld(world, cmds({ kind: 'dismissWorker', buildingId: huts[0]!.id }));
    expect(huts[0]!.workerId).toBeUndefined();

    // With no further orders he hauls the materials, then — because sites
    // outrank his old post in the recruit sweep — raises the building.
    let guard = 0;
    while (site.state !== 'built' && guard++ < 6000) tickWorld(world, []);
    expect(site.state).toBe('built');
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('ignores a dismiss aimed at somebody else\x27s building', () => {
    const world = bareWorld(1, 2);
    addStorehouse(world, 30, 30, {});
    const hut = addBuiltHut(world, 25, 30);
    const worker = hut.workerId;
    expect(worker).toBeDefined();
    tickWorld(world, [{ playerId: 1, cmd: { kind: 'dismissWorker', buildingId: hut.id } }]);
    expect(hut.workerId).toBe(worker); // player 1 cannot fire player 0's people
  });
});
