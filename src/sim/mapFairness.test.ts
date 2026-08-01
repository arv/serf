import { describe, expect, it } from 'vitest';
import { MAP_SIZE, TILE_COUNT, tileX, tileY } from '../shared/grid.ts';
import { createWorld, type World } from './world.ts';
import { TileResource, type TileResourceKind } from './map.ts';

/**
 * The fairness contract for generated maps: every faction has its own wood,
 * stone, iron, and silver at comparable reach, while gold is deliberately
 * contested — one central cluster with the bandit camp standing over it.
 */

const SEEDS = [1, 7, 1337, 20260724];
const MID = MAP_SIZE / 2;

function tilesOf(world: World, code: TileResourceKind): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < TILE_COUNT; i++) {
    if (world.map.resource[i] === code) out.push([tileX(i), tileY(i)]);
  }
  return out;
}

function countNear(tiles: [number, number][], x: number, y: number, r: number): number {
  return tiles.filter(([tx, ty]) => Math.hypot(tx - x, ty - y) <= r).length;
}

function makeWorld(seed: number, players: number): World {
  return createWorld({
    seed,
    players: Array.from({ length: players }, () => ({ kind: 'human' as const })),
  });
}

function anchors(world: World): { x: number; y: number }[] {
  return [...world.buildings.values()]
    .filter((b) => b.type === 'storehouse')
    .map((b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 }));
}

describe('map fairness', () => {
  for (const players of [2, 3, 4]) {
    it(`${players} players: everyone has wood, stone, iron, and silver at home reach`, () => {
      for (const seed of SEEDS) {
        const world = makeWorld(seed, players);
        const homes = anchors(world);
        expect(homes.length).toBe(players);
        const bamboo = tilesOf(world, TileResource.Bamboo);
        const rock = tilesOf(world, TileResource.Rock);
        const iron = tilesOf(world, TileResource.IronDep);
        const silver = tilesOf(world, TileResource.SilverDep);
        for (const h of homes) {
          const label = `seed ${seed}, ${players}p, start ${h.x},${h.y}`;
          expect(countNear(bamboo, h.x, h.y, 17), `${label}: bamboo`).toBeGreaterThanOrEqual(3);
          expect(countNear(rock, h.x, h.y, 17), `${label}: rock`).toBeGreaterThanOrEqual(2);
          expect(countNear(iron, h.x, h.y, 17), `${label}: iron`).toBeGreaterThanOrEqual(1);
          expect(countNear(silver, h.x, h.y, 17), `${label}: silver`).toBeGreaterThanOrEqual(1);
        }
      }
    });

    it(`${players} players: gold and the bandit camp share the middle`, () => {
      for (const seed of SEEDS) {
        const world = makeWorld(seed, players);
        const gold = tilesOf(world, TileResource.GoldDep);
        expect(gold.length, `seed ${seed}: gold exists`).toBeGreaterThan(0);
        const gx = gold.reduce((s, [x]) => s + x, 0) / gold.length;
        const gy = gold.reduce((s, [, y]) => s + y, 0) / gold.length;
        expect(Math.hypot(gx - MID, gy - MID), `seed ${seed}: gold central`).toBeLessThan(10);

        const camp = [...world.buildings.values()].find((b) => b.type === 'banditCamp');
        expect(camp, `seed ${seed}: camp exists`).toBeDefined();
        const cd = Math.max(Math.abs(camp!.x + 1 - MID), Math.abs(camp!.y + 1 - MID));
        expect(cd, `seed ${seed}: camp central`).toBeLessThanOrEqual(12);
      }
    });
  }

  it('solo: the classic mid-ring layout is untouched', () => {
    for (const seed of SEEDS) {
      const world = makeWorld(seed, 1);
      const iron = tilesOf(world, TileResource.IronDep);
      const silver = tilesOf(world, TileResource.SilverDep);
      const gold = tilesOf(world, TileResource.GoldDep);
      // Ring band 13-17 from center, plus cluster radius.
      expect(countNear(iron, MID, MID, 20), `seed ${seed}: iron`).toBeGreaterThanOrEqual(1);
      expect(countNear(silver, MID, MID, 20), `seed ${seed}: silver`).toBeGreaterThanOrEqual(1);
      expect(gold.length, `seed ${seed}: gold exists`).toBeGreaterThan(0);
      // Not at the doorstep (the middle is home in solo), not out of reach.
      const gd = Math.min(...gold.map(([x, y]) => Math.hypot(x - MID, y - MID)));
      expect(gd, `seed ${seed}: gold off the plateau`).toBeGreaterThan(9);
      expect(gd, `seed ${seed}: gold reachable`).toBeLessThan(21);
    }
  });
});
