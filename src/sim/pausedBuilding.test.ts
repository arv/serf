import { describe, expect, it } from 'vitest';
import { tickWorld } from './tick.ts';
import { placeBuiltBuilding, type World } from './world.ts';
import { checkInvariants } from './debug/invariants.ts';
import { addSerf, addSite, addStorehouse, bareWorld, cmds, staffBuilding } from './testUtils.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

/**
 * The pause lever: a halted building neither works its recipe nor calls for
 * inputs — the fix for a weaponsmith quietly eating the village's wood — and
 * it hands its worker back to the pool, which is the fix for a village that
 * has spent its last hand on a post. Everything resumes on unpause.
 */
describe('pausing a building', () => {
  it('a paused weaponsmith stops converting, stops demanding wood, and sends its worker home', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, { wood: 12, iron: 6 });
    const smith = placeBuiltBuilding(world, 'weaponsmith', 0, 36, 30);
    staffBuilding(world, smith);
    const worker = world.units.get(smith.workerId!)!;
    addSerf(world, 33, 33);

    tickWorld(world, cmds({ kind: 'setBuildingPaused', buildingId: smith.id, paused: true }));
    // The post empties on the order itself: the hand is loose again.
    expect(smith.workerId).toBeUndefined();
    expect(worker.kind).toBe('serf');
    run(world, 1200);

    // Nothing hauled in, nothing forged: the piles are untouched.
    expect(sh.stock.wood).toBe(12);
    expect(sh.stock.iron).toBe(6);
    expect(smith.inputs.wood ?? 0).toBe(0);
    expect(smith.stock.spear ?? 0).toBe(0);
    // ...and nobody was quietly walked back into the post.
    expect(smith.workerId).toBeUndefined();
    expect(checkInvariants(world).violations).toEqual([]);

    // Unpause: a worker is recruited, materials flow and spears come out.
    tickWorld(world, cmds({ kind: 'setBuildingPaused', buildingId: smith.id, paused: false }));
    let guard = 0;
    while ((smith.stock.spear ?? 0) === 0 && guard++ < 4000) tickWorld(world, []);
    expect(smith.workerId).toBeDefined();
    expect(smith.stock.spear ?? 0).toBeGreaterThan(0);
    expect(sh.stock.wood).toBeLessThan(12);
  });

  it('a paused site gets no materials, no builder and no progress', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { wood: 20 });
    const site = addSite(world, 36, 30);
    for (let i = 0; i < 3; i++) addSerf(world, 32, 33 + i);
    tickWorld(world, cmds({ kind: 'setBuildingPaused', buildingId: site.id, paused: true }));
    run(world, 800);
    expect(site.state).toBe('site');
    expect(site.buildProgress ?? 0).toBe(0);
    expect(site.workerId).toBeUndefined();

    tickWorld(world, cmds({ kind: 'setBuildingPaused', buildingId: site.id, paused: false }));
    let guard = 0;
    while (site.state !== 'built' && guard++ < 6000) tickWorld(world, []);
    expect(site.state).toBe('built');
  });

  it('a rival cannot pause your buildings', () => {
    const world = bareWorld(1, 2);
    addStorehouse(world, 30, 30, { wood: 0 });
    const smith = placeBuiltBuilding(world, 'weaponsmith', 0, 36, 30);
    tickWorld(world, [
      { playerId: 1, cmd: { kind: 'setBuildingPaused', buildingId: smith.id, paused: true } },
    ]);
    expect(smith.paused).toBeUndefined();
  });
});
