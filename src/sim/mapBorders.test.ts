import { describe, expect, it } from 'vitest';
import { edgeDist, tileCount, tileIdx } from '../shared/grid.ts';
import { createWorld, campCorners, type World } from './world.ts';
import { Terrain, TileResource, type GameMap } from './map.ts';
import { WOOD_MAX_AMT } from './defs/balance.ts';

/**
 * The mixed-border contract: every edge draws sea, ridge, or forest from
 * the seed; a land border runs its rock or timber to the very last row
 * (no moat — the renderer continues it as land), while a sea border is
 * open water to the map edge; the whole rim is impassable as generated;
 * and at least one edge per map is honest coast.
 */

const SIZE = 96;
const FRINGE = 4; // floor(96 / 24)
// Deepest band any edge can draw: base + capped jitter/meander + teeth.
const MAX_DEPTH = 3 * FRINGE + 2;

function solo(seed: number): World {
  return createWorld({ seed, players: [{ kind: 'human' }] });
}

/** Classify one edge by walking inward at several positions and reading
 * the first non-water tile: rock = ridge, standing wood = forest, and a
 * band that stays wet all the way in (or opens on clear grass) = sea. The
 * walk-in matters — the waterline wobbles, so no fixed depth is reliable. */
function edgeStyle(map: GameMap, side: number): 'sea' | 'ridge' | 'forest' {
  const size = map.size;
  let rock = 0;
  let wood = 0;
  let sea = 0;
  for (let along = 10; along < size - 10; along += 3) {
    let vote: 'sea' | 'ridge' | 'forest' = 'sea';
    for (let d = 0; d < MAX_DEPTH + 1; d++) {
      const [x, y] =
        side === 0 ? [along, d] : side === 1 ? [size - 1 - d, along] : side === 2 ? [along, size - 1 - d] : [d, along];
      const i = tileIdx(x, y, size);
      if (map.terrain[i] === Terrain.Water) continue;
      if (map.terrain[i] === Terrain.Rock) vote = 'ridge';
      else if (map.resource[i] === TileResource.Wood) vote = 'forest';
      break;
    }
    if (vote === 'ridge') rock++;
    else if (vote === 'forest') wood++;
    else sea++;
  }
  if (rock > wood && rock > sea) return 'ridge';
  if (wood > rock && wood > sea) return 'forest';
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

  it('runs each border to the last row in its own style, all of it blocked', () => {
    for (const seed of [1, 7, 11]) {
      const map = solo(seed).map;
      // Everything inside the minimum band depth is rim of SOME style:
      // water, rock, or belt wood — all of which block. (Belt inner rows
      // are thinned, so only the guaranteed-depth band is asserted.)
      for (let i = 0; i < tileCount(SIZE); i++) {
        const x = i % SIZE;
        const y = (i / SIZE) | 0;
        if (edgeDist(x, y, SIZE) < FRINGE - 1) {
          expect(map.blocked[i], `seed ${seed}: rim tile ${x},${y} walkable`).toBe(1);
        }
      }
      // The outermost row IS the border's own material — open sea on a
      // sea side, standing rock on a ridge side (the ramp holds it above
      // any flood), and belt ground on a forest side, where a basin may
      // cut the odd cove but timber must dominate.
      for (let side = 0; side < 4; side++) {
        const style = edgeStyle(map, side);
        let wood = 0;
        let samples = 0;
        for (let along = 10; along < SIZE - 10; along += 3) {
          const [x, y] =
            side === 0
              ? [along, 0]
              : side === 1
                ? [SIZE - 1, along]
                : side === 2
                  ? [along, SIZE - 1]
                  : [0, along];
          const i = tileIdx(x, y, SIZE);
          samples++;
          const label = `seed ${seed}, side ${side} (${style}): edge tile ${x},${y}`;
          if (style === 'sea') {
            expect(map.terrain[i], label).toBe(Terrain.Water);
          } else if (style === 'ridge') {
            expect(map.terrain[i], label).toBe(Terrain.Rock);
          } else if (map.resource[i] === TileResource.Wood) {
            wood++;
          }
        }
        if (style === 'forest') {
          expect(wood / samples, `seed ${seed}, side ${side}: forest edge thin`).toBeGreaterThan(0.5);
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
    // Sampled along the forest wall itself: on a forest-voted side, the
    // first land tile in from the edge that carries wood is belt by
    // construction (grove clusters can never overwrite it — the belt is
    // planted first), so its amount must be the full reserve. A window by
    // edgeDist alone would catch interior groves now that the band wobbles
    // this deep.
    let checked = 0;
    for (let seed = 1; seed <= 32 && checked < 3; seed++) {
      const map = solo(seed).map;
      const sides = [0, 1, 2, 3].filter((s) => edgeStyle(map, s) === 'forest');
      if (sides.length === 0) continue;
      const wall: number[] = [];
      for (const side of sides) {
        for (let along = 10; along < SIZE - 10; along += 3) {
          for (let d = 0; d < MAX_DEPTH + 1; d++) {
            const [x, y] =
              side === 0
                ? [along, d]
                : side === 1
                  ? [SIZE - 1 - d, along]
                  : side === 2
                    ? [along, SIZE - 1 - d]
                    : [d, along];
            const i = tileIdx(x, y, SIZE);
            if (map.terrain[i] === Terrain.Water) continue;
            if (map.resource[i] === TileResource.Wood) wall.push(i);
            break;
          }
        }
      }
      if (wall.length < 10) continue;
      checked++;
      for (const i of wall) {
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
