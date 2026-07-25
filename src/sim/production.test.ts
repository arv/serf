import { describe, expect, it } from 'vitest';
import { tileIdx } from '../shared/grid';
import { tickWorld } from './tick';
import { PathLevel, TileResource } from './map';
import { OUTPUT_CAP } from './defs/buildings';
import { TRAILS_INTERVAL, TRAIL_WEAR_THRESHOLD } from './defs/balance';
import { addBuiltHut, addSerf, addSite, addStorehouse, bareWorld } from './testUtils';
import type { World } from './world';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

function plantBamboo(world: World, x: number, y: number, amt = 6): number {
  const idx = tileIdx(x, y);
  world.map.resource[idx] = TileResource.Bamboo;
  world.map.resourceAmt[idx] = amt;
  world.map.blocked[idx] = 1;
  return idx;
}

describe('gather production', () => {
  it('worker commutes, chops, and stocks the hut; depleted tiles unblock', () => {
    const world = bareWorld();
    const hut = addBuiltHut(world, 30, 30);
    const idx = plantBamboo(world, 34, 31, 2);
    run(world, 3000);

    expect(hut.stock.bamboo ?? 0).toBeGreaterThan(0);
    expect(world.map.resource[idx]).toBe(TileResource.None);
    expect(world.map.blocked[idx]).toBe(0);
    expect(world.ledger.produced.bamboo).toBeGreaterThan(0);
  });

  it('full output buffer stalls production (Settlers rule)', () => {
    const world = bareWorld();
    const hut = addBuiltHut(world, 30, 30);
    hut.stock.bamboo = OUTPUT_CAP;
    const idx = plantBamboo(world, 34, 31);
    const before = world.map.resourceAmt[idx];
    run(world, 600);

    // No storehouse => no evacuation => buffer stays full, no chopping.
    expect(hut.stock.bamboo).toBe(OUTPUT_CAP);
    expect(world.map.resourceAmt[idx]).toBe(before);
  });

  it('producer output flows to the storehouse via serfs', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, {});
    addBuiltHut(world, 24, 30);
    plantBamboo(world, 21, 31, 6);
    addSerf(world, 29, 34);
    run(world, 4000);

    expect(sh.stock.bamboo ?? 0).toBeGreaterThan(0);
  });

  it('site completes exactly when materials arrive and the timer elapses', () => {
    const world = bareWorld();
    const site = addSite(world, 24, 30);
    site.siteNeeds = {}; // materials "already delivered"
    const start = world.tick;
    let builtAt = -1;
    for (let i = 0; i < 500 && builtAt < 0; i++) {
      tickWorld(world, []);
      if (site.state === 'built') builtAt = world.tick;
    }
    // buildTicks=300 for the bamboo hut; construction ticks once per tick.
    expect(builtAt - start).toBe(300);
    expect(site.workerId).toBeDefined();
  });
});

describe('trails', () => {
  it('worn grass becomes a dirt trail; unused trails revert', () => {
    const world = bareWorld();
    const idx = tileIdx(10, 10);
    world.map.wear[idx] = TRAIL_WEAR_THRESHOLD + 2;
    run(world, TRAILS_INTERVAL + 1);
    expect(world.map.pathLevel[idx]).toBe(PathLevel.Trail);

    // Decay with no traffic until it reverts.
    run(world, TRAILS_INTERVAL * 120);
    expect(world.map.pathLevel[idx]).toBe(PathLevel.None);
  });

  it('foot traffic accumulates wear along a haul lane', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { bamboo: 10 });
    addSite(world, 22, 30);
    addSerf(world, 29, 34);
    run(world, 2000);

    let total = 0;
    for (let i = 0; i < world.map.wear.length; i++) total += world.map.wear[i]!;
    expect(total).toBeGreaterThan(0);
  });
});
