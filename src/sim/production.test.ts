import { describe, expect, it } from 'vitest';
import { tileIdx } from '../shared/grid.ts';
import { tickWorld } from './tick.ts';
import { PathLevel, TileResource } from './map.ts';
import { OUTPUT_CAP } from './defs/buildings.ts';
import { TRAILS_INTERVAL } from './defs/balance.ts';
import { addBuiltHut, addSerf, addSite, addStorehouse, bareWorld } from './testUtils.ts';
import type { World } from './world.ts';
import { GoodId } from './defs/goods.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

function plantGrove(world: World, x: number, y: number, amt = 6): number {
  const idx = tileIdx(x, y, world.map.size);
  world.map.resource[idx] = TileResource.Wood;
  world.map.resourceAmt[idx] = amt;
  world.map.blocked[idx] = 1;
  return idx;
}

describe('gather production', () => {
  it('worker commutes, chops, and stocks the hut; depleted tiles unblock', () => {
    const world = bareWorld();
    const hut = addBuiltHut(world, 30, 30);
    const idx = plantGrove(world, 34, 31, 2);
    run(world, 3000);

    expect(hut.stock[GoodId.wood] ?? 0).toBeGreaterThan(0);
    expect(world.map.resource[idx]).toBe(TileResource.None);
    expect(world.map.blocked[idx]).toBe(0);
    expect(world.ledger.produced[GoodId.wood]).toBeGreaterThan(0);
  });

  it('an unreachable nearest tile does not starve the hut (walled-in tree)', () => {
    const world = bareWorld();
    const hut = addBuiltHut(world, 30, 30);
    // The nearest tree to the hut's gather origin (31,31), sealed inside a
    // ring of blocking rock: no adjacent tile is walkable, so no path ever
    // reaches it. Before reachability-aware trips, the worker re-picked
    // exactly this tile every retry and idled forever.
    const walled = plantGrove(world, 33, 31, 6);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const i = tileIdx(33 + dx, 31 + dy, world.map.size);
        world.map.resource[i] = TileResource.Rock;
        world.map.resourceAmt[i] = 6;
        world.map.blocked[i] = 1;
      }
    }
    // A workable tree farther out but still inside the recipe radius.
    const open = plantGrove(world, 37, 31, 6);
    run(world, 3000);

    expect(hut.stock[GoodId.wood] ?? 0).toBeGreaterThan(0);
    // The yield came from the reachable grove; the sealed one stands.
    expect(world.map.resourceAmt[walled]).toBe(6);
    expect(world.map.resourceAmt[open]!).toBeLessThan(6);
  });

  it('full output buffer stalls production (Settlers rule)', () => {
    const world = bareWorld();
    const hut = addBuiltHut(world, 30, 30);
    hut.stock[GoodId.wood] = OUTPUT_CAP;
    const idx = plantGrove(world, 34, 31);
    const before = world.map.resourceAmt[idx];
    run(world, 600);

    // No storehouse => no evacuation => buffer stays full, no chopping.
    expect(hut.stock[GoodId.wood]).toBe(OUTPUT_CAP);
    expect(world.map.resourceAmt[idx]).toBe(before);
  });

  it('producer output flows to the storehouse via serfs', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, {});
    addBuiltHut(world, 24, 30);
    plantGrove(world, 21, 31, 6);
    addSerf(world, 29, 34);
    run(world, 4000);

    expect(sh.stock[GoodId.wood] ?? 0).toBeGreaterThan(0);
  });

  it('a recruited builder raises the site, then stays on as its worker', () => {
    const world = bareWorld();
    addSerf(world, 26, 34); // the future builder-then-worker
    const site = addSite(world, 24, 30);
    site.siteNeeds = {}; // materials "already delivered" (hammer loan included)
    site.inputs[GoodId.axe] = 1; // the post's pre-ordered tool, waiting on the rack

    // Nothing happens until the recruited builder arrives...
    let arrivedAt = -1;
    for (let i = 0; i < 2000 && arrivedAt < 0; i++) {
      tickWorld(world, []);
      if (site.workerId !== undefined) arrivedAt = world.tick;
    }
    expect(arrivedAt).toBeGreaterThan(0);
    expect(site.buildProgress ?? 0).toBeLessThanOrEqual(1);

    // ...then the frame rises in exactly buildTicks (300 for the hut),
    // give or take the arrival tick's system ordering.
    let builtAt = -1;
    for (let i = 0; i < 500 && builtAt < 0; i++) {
      tickWorld(world, []);
      if (site.state === 'built') builtAt = world.tick;
    }
    expect(builtAt - arrivedAt).toBeGreaterThanOrEqual(300);
    expect(builtAt - arrivedAt).toBeLessThanOrEqual(301);

    // The builder is now the worker; the serf pool is empty.
    const worker = site.workerId !== undefined ? world.units.get(site.workerId) : undefined;
    expect(worker?.kind).toBe('worker');
    expect([...world.units.values()].filter((u) => u.kind === 'serf')).toEqual([]);
  });
});

describe('trails', () => {
  it('worn grass becomes a dirt trail; unused trails revert', () => {
    const world = bareWorld();
    const idx = tileIdx(10, 10, world.map.size);
    // 11 wear sits between the 10-wear formation threshold and the
    // pre-v20 12: a regression to the old threshold leaves this grass.
    world.map.wear[idx] = 11;
    run(world, TRAILS_INTERVAL + 1);
    expect(world.map.pathLevel[idx]).toBe(PathLevel.Trail);

    // Decay with no traffic. From 11 wear the pre-v20 revert floor of
    // 1.5 cleared the trail by pass 100; the 0.75 floor holds it until
    // pass ~134. At 120 passes only the new floor keeps it standing.
    run(world, TRAILS_INTERVAL * 119); // 120 passes counting the one above
    expect(world.map.pathLevel[idx]).toBe(PathLevel.Trail);

    // Then keep decaying until it reverts, bounded so a trail that
    // never fades fails the assertion instead of hanging the suite.
    for (let i = 0; i < 500 && world.map.pathLevel[idx] === PathLevel.Trail; i++) {
      run(world, TRAILS_INTERVAL);
    }
    expect(world.map.pathLevel[idx]).toBe(PathLevel.None);
  });

  it('foot traffic accumulates wear along a haul lane', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { [GoodId.wood]: 10 });
    addSite(world, 22, 30);
    addSerf(world, 29, 34);
    run(world, 2000);

    let total = 0;
    for (let i = 0; i < world.map.wear.length; i++) total += world.map.wear[i]!;
    expect(total).toBeGreaterThan(0);
  });
});
