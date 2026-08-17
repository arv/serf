import { describe, expect, it } from 'vitest';
import { edgeDist, tileCount, tileIdx } from '../shared/grid.ts';
import { createWorld, campCorners, type World } from './world.ts';
import { Terrain, TileResource, type GameMap } from './map.ts';
import { WOOD_MAX_AMT } from './defs/balance.ts';

/**
 * The mixed-border contract: every edge draws sea, ridge, or forest from
 * the seed; the outermost strip is always water (the renderer's endless
 * sea and the corner rule both lean on it); the whole rim is impassable
 * as generated; and at least one edge per map is honest coast.
 */

const SIZE = 96;
const STRIP = 2; // floor(96 / 48)
const FRINGE = 4; // floor(96 / 24)

function solo(seed: number): World {
  return createWorld({ seed, players: [{ kind: 'human' }] });
}

/** Classify one edge by probing its band at several positions. */
function edgeStyle(map: GameMap, side: number): 'sea' | 'ridge' | 'forest' {
  const size = map.size;
  let rock = 0;
  let wood = 0;
  let water = 0;
  // Probe just inside the strip at many positions along the edge; the
  // wobble keeps depth >= FRINGE so d = STRIP is always inside the band.
  for (let along = 10; along < size - 10; along += 3) {
    const d = STRIP;
    const [x, y] =
      side === 0 ? [along, d] : side === 1 ? [size - 1 - d, along] : side === 2 ? [along, size - 1 - d] : [d, along];
    const i = tileIdx(x, y, size);
    if (map.terrain[i] === Terrain.Rock) rock++;
    else if (map.terrain[i] === Terrain.Water) water++;
    else if (map.resource[i] === TileResource.Wood) wood++;
  }
  if (rock > wood && rock > water) return 'ridge';
  if (wood > rock && wood > water) return 'forest';
  return 'sea';
}

describe('map borders', () => {
  it('draws all three styles across seeds, with >=1 sea edge per map', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 32; seed++) {
      const map = solo(seed).map;
      const styles = [0, 1, 2, 3].map((s) => edgeStyle(map, s));
      for (const s of styles) seen.add(s);
      expect(styles, `seed ${seed} has no sea edge: ${styles.join(',')}`).toContain('sea');
    }
    expect([...seen].sort()).toEqual(['forest', 'ridge', 'sea']);
  });

  it('keeps the outermost strip water and the whole band blocked', () => {
    for (const seed of [1, 7, 11]) {
      const map = solo(seed).map;
      for (let i = 0; i < tileCount(SIZE); i++) {
        const x = i % SIZE;
        const y = (i / SIZE) | 0;
        const d = edgeDist(x, y, SIZE);
        if (d < STRIP) {
          expect(map.terrain[i], `seed ${seed}: strip tile ${x},${y}`).toBe(Terrain.Water);
        }
        // Everything inside the minimum band depth is rim of SOME style:
        // water, rock, or belt wood — all of which block. (Belt inner rows
        // are thinned, so only the guaranteed-depth band is asserted.)
        if (d < FRINGE - 1) {
          expect(map.blocked[i], `seed ${seed}: rim tile ${x},${y} walkable`).toBe(1);
        }
      }
    }
  });

  it('raises a real range under a ridge edge', () => {
    // Find a seed with a ridge edge among the sweep and assert its band
    // reaches rock-and-snow heights somewhere.
    let checked = 0;
    for (let seed = 1; seed <= 32 && checked < 3; seed++) {
      const map = solo(seed).map;
      const sides = [0, 1, 2, 3].filter((s) => edgeStyle(map, s) === 'ridge');
      if (sides.length === 0) continue;
      checked++;
      let peak = 0;
      for (let i = 0; i < tileCount(SIZE); i++) {
        if (map.terrain[i] === Terrain.Rock) peak = Math.max(peak, map.height[i]!);
      }
      expect(peak, `seed ${seed}: ridge crest too low`).toBeGreaterThan(1.8);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('plants the belt as a live, regrowth-capped timber reserve', () => {
    let checked = 0;
    for (let seed = 1; seed <= 32 && checked < 3; seed++) {
      const map = solo(seed).map;
      const belted: number[] = [];
      for (let i = 0; i < tileCount(SIZE); i++) {
        const x = i % SIZE;
        const y = (i / SIZE) | 0;
        if (edgeDist(x, y, SIZE) >= FRINGE) continue;
        if (map.resource[i] === TileResource.Wood) belted.push(i);
      }
      if (belted.length < 20) continue; // no forest edge this seed
      checked++;
      for (const i of belted.slice(0, 5)) {
        expect(map.resourceAmt[i]).toBe(WOOD_MAX_AMT);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('is deterministic and keeps the camp corners on land at every size', () => {
    for (const mapSize of [64, 96, 128]) {
      const a = createWorld({ seed: 5, players: [{ kind: 'human' }], mapSize });
      const b = createWorld({ seed: 5, players: [{ kind: 'human' }], mapSize });
      expect(a.map.terrain).toEqual(b.map.terrain);
      expect(a.map.resource).toEqual(b.map.resource);
      for (const [cx, cy] of campCorners(mapSize)) {
        // The seed spot itself may be pushed off by lakes (the camp search
        // widens), but the corner must not sit inside the rim band.
        expect(
          edgeDist(cx, cy, mapSize),
          `corner ${cx},${cy} inside the rim at ${mapSize}`,
        ).toBeGreaterThanOrEqual(2 * Math.max(1, Math.floor(mapSize / 24)));
      }
    }
  });
});
