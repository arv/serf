import { describe, expect, it } from 'vitest';
import { tickWorld } from './tick.ts';
import { canPlace, placeBuiltBuilding, type World } from './world.ts';
import { buildingDef } from './defs/buildings.ts';
import { checkInvariants, checkLedger, countGoods } from './debug/invariants.ts';
import {
  addBuiltHut,
  addResourceTile,
  addSite,
  addStorehouse,
  bareWorld,
  cmds,
} from './testUtils.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

/**
 * Selling a building: half the construction cost back (floored per good),
 * the resident walks out a serf, the footprint frees up. The escape hatch
 * when the village is built into a corner.
 */
describe('selling a building', () => {
  it('refunds half the cost, frees the worker and the ground', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, { wood: 0 });
    addResourceTile(world, 40, 30); // a grove in reach, or the hut is illegal ground
    const hut = addBuiltHut(world, 36, 30);
    const workerId = hut.workerId!;
    const initial = countGoods(world);

    tickWorld(world, cmds({ kind: 'sellBuilding', buildingId: hut.id }));
    run(world, 2);

    const cost = buildingDef('woodcutter').cost.wood!;
    expect(sh.stock.wood).toBe(Math.floor(cost / 2));
    const worker = world.units.get(workerId)!;
    expect(worker.dead).toBe(false);
    expect(worker.kind).toBe('serf');
    expect(worker.homeId).toBeUndefined();
    expect(world.buildings.get(hut.id)).toBeUndefined();
    expect(canPlace(world.map, 'woodcutter', 36, 30)).toBe(true);
    expect(checkInvariants(world).violations).toEqual([]);
    expect(checkLedger(world, initial)).toEqual([]);
  });

  it('a site refunds half of what was delivered, not half the price', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, { wood: 0 });
    const site = addSite(world, 36, 30);
    // Two of six planks delivered so far.
    site.siteNeeds = { wood: (buildingDef('woodcutter').cost.wood ?? 0) - 2 };
    tickWorld(world, cmds({ kind: 'sellBuilding', buildingId: site.id }));
    expect(sh.stock.wood).toBe(1); // floor(2 / 2)
    expect(world.buildings.get(site.id)).toBeUndefined();
  });

  it('a sold Smith loses its forged stock, hammers included', () => {
    // The rescue set exists for the post's own tool and a site's borrowed
    // hammer. A built Smith works with no tool and its hammers are forged
    // STOCK — an unconditional hammer rescue walked them out of the sale
    // while the axes on the same shelf were lost.
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, { wood: 0, hammer: 0, axe: 0 });
    const smith = placeBuiltBuilding(world, 'weaponsmith', 0, 36, 30);
    smith.stock = { hammer: 3, axe: 2 };
    tickWorld(world, cmds({ kind: 'sellBuilding', buildingId: smith.id }));
    expect(sh.stock.hammer ?? 0).toBe(0); // lost with the rest of the shelf
    expect(sh.stock.axe ?? 0).toBe(0);
  });

  it("a sold site's borrowed hammer walks back to the stores", () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, { wood: 0, hammer: 0 });
    const site = addSite(world, 36, 30);
    site.siteNeeds = { wood: buildingDef('woodcutter').cost.wood ?? 0 };
    site.inputs = { hammer: 1 }; // the loan, delivered and waiting
    tickWorld(world, cmds({ kind: 'sellBuilding', buildingId: site.id }));
    expect(sh.stock.hammer).toBe(1); // a move, not a refund
  });

  it("a rival cannot sell your buildings, and nobody sells a storehouse", () => {
    const world = bareWorld(1, 2);
    const sh = addStorehouse(world, 30, 30, { wood: 0 });
    const hut = addBuiltHut(world, 36, 30);
    tickWorld(world, [{ playerId: 1, cmd: { kind: 'sellBuilding', buildingId: hut.id } }]);
    expect(world.buildings.get(hut.id)).toBeDefined();

    tickWorld(world, cmds({ kind: 'sellBuilding', buildingId: sh.id }));
    expect(world.buildings.get(sh.id)).toBeDefined();
  });
});
