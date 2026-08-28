import { describe, expect, it } from 'vitest';
import { tickWorld } from './tick.ts';
import { killUnit, spawnUnit, type World } from './world.ts';
import { checkInvariants } from './debug/invariants.ts';
import { addBuiltHut, addSerf, addSite, addStorehouse, bareWorld, cmds } from './testUtils.ts';
import { GoodId } from './defs/goods.ts';
import { UnitTypeId } from './defs/units.ts';

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
    addStorehouse(world, 30, 30, { [GoodId.wood]: 20 });
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
    addStorehouse(world, 30, 30, { [GoodId.wood]: 20 });
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
    addStorehouse(world, 30, 30, { [GoodId.wood]: 20 });
    const site = addSite(world, 36, 30);
    for (let i = 0; i < 2; i++) addSerf(world, 32, 33 + i);
    let guard = 0;
    while ((site.buildProgress ?? 0) < 5 && guard++ < 2000) tickWorld(world, []);
    const firstBuilder = site.workerId!;
    // Kill the builder AND every loose serf: the village is out of hands.
    killUnit(world, world.units.get(firstBuilder)!);
    for (const u of world.units.values()) {
      if (!u.dead && u.kind === UnitTypeId.serf) killUnit(world, u);
    }
    run(world, 300);
    expect(site.state).toBe('site'); // stalled, correctly — nobody to send
    // A new serf arrives (hire); the site should claim him.
    spawnUnit(world, UnitTypeId.serf, 0, 30.5, 34.5);
    guard = 0;
    while (site.state !== 'built' && guard++ < 4000) tickWorld(world, []);
    expect(site.state).toBe('built');
    expect(checkInvariants(world).violations).toEqual([]);
  });
});

/**
 * Pausing is the escape hatch as well as the halt lever: the one order
 * empties the post, which is what breaks a village that has spent its last
 * hand on a hut and has nobody left to build with.
 */
describe('the pause escape hatch', () => {
  it('breaks the no-silver/no-serfs deadlock: the freed worker builds the new site', () => {
    const world = bareWorld();
    // Silver is gone, and every last serf holds a post: nobody to haul,
    // nobody to build — the deadlock from the field report.
    addStorehouse(world, 30, 30, { [GoodId.wood]: 20, [GoodId.silver]: 0 });
    const huts = [addBuiltHut(world, 25, 30), addBuiltHut(world, 25, 34)];
    const site = addSite(world, 36, 30);
    run(world, 300);
    expect(site.buildProgress ?? 0).toBe(0); // truly stuck
    expect((site.siteNeeds?.[GoodId.wood] ?? 0)).toBeGreaterThan(0);

    // The player halts one hut, which hands its worker back.
    tickWorld(world, cmds({ kind: 'setBuildingPaused', buildingId: huts[0]!.id, paused: true }));
    expect(huts[0]!.workerId).toBeUndefined();

    // With no further orders he hauls the materials, then — because sites
    // outrank his old post in the recruit sweep — raises the building.
    let guard = 0;
    while (site.state !== 'built' && guard++ < 6000) tickWorld(world, []);
    expect(site.state).toBe('built');
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('keeps the halted post empty rather than recruiting straight over the order', () => {
    // The whole reason the freed hand is worth anything: a post that called
    // for a replacement the moment one went idle would undo the order.
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const hut = addBuiltHut(world, 25, 30);
    tickWorld(world, cmds({ kind: 'setBuildingPaused', buildingId: hut.id, paused: true }));
    run(world, 1200);
    expect(hut.workerId).toBeUndefined();
    expect(hut.recruitId).toBeUndefined();
    expect(checkInvariants(world).violations).toEqual([]);

    // Starting it again is what asks for a worker back.
    tickWorld(world, cmds({ kind: 'setBuildingPaused', buildingId: hut.id, paused: false }));
    let guard = 0;
    while (hut.workerId === undefined && guard++ < 2000) tickWorld(world, []);
    expect(hut.workerId).toBeDefined();
  });

  it('turns away a recruit who was already walking over when it was halted', () => {
    const world = bareWorld();
    // Stocked, so the site actually gets far enough to call for a builder —
    // one is only summoned once the materials are in or in assigned hands.
    addStorehouse(world, 30, 30, { [GoodId.wood]: 20 });
    const site = addSite(world, 36, 30);
    for (let i = 0; i < 4; i++) addSerf(world, 32, 33 + i);
    let guard = 0;
    while (site.recruitId === undefined && guard++ < 2000) tickWorld(world, []);
    expect(site.recruitId).toBeDefined();
    const walker = world.units.get(site.recruitId!)!;
    tickWorld(world, cmds({ kind: 'setBuildingPaused', buildingId: site.id, paused: true }));
    run(world, 600);
    // He reached the door and was sent away, rather than binding to a post
    // the player had just emptied on purpose.
    expect(site.workerId).toBeUndefined();
    expect(walker.homeId).toBeUndefined();
    expect(walker.kind).toBe(UnitTypeId.serf);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it("ignores a halt aimed at somebody else's building", () => {
    const world = bareWorld(1, 2);
    addStorehouse(world, 30, 30, {});
    const hut = addBuiltHut(world, 25, 30);
    const worker = hut.workerId;
    expect(worker).toBeDefined();
    tickWorld(world, [
      { playerId: 1, cmd: { kind: 'setBuildingPaused', buildingId: hut.id, paused: true } },
    ]);
    expect(hut.paused).toBeUndefined();
    expect(hut.workerId).toBe(worker); // player 1 cannot fire player 0's people
  });
});
