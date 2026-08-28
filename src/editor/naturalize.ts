import {tileCount, tileIdx, tileX, tileY} from '../shared/grid.ts';
import {clamp, hash2} from '../shared/math.ts';
import * as Terrain from '../sim/terrainEnum.ts';
import type {EditorMapState} from './editorMap.ts';
import {tileImages} from './symmetry.ts';

/**
 * One-click "make it read like a generated map": re-derive the heightfield
 * from the painted terrain classes using worldgen's own shaping rules
 * (computeTerrain in sim/map.ts) —
 *
 *  - lake beds shelve: barely under the surface at the margins, plunging
 *    to full depth a few tiles out (a flat painted bed reads as a slab);
 *  - meadows ease down toward the waterline over a few tiles, so painted
 *    shores stop being cliffs;
 *  - gentle rolling noise breaks up the plains the flat blank map (and a
 *    steady raise brush) leave behind.
 *
 * The author's own sculpting survives as the base the noise rides on —
 * this reshapes toward nature, it doesn't reset. Terrain classes,
 * resources and starts are untouched, and heights are visual only, so
 * nothing about play changes.
 *
 * The noise is sampled at each tile's CANONICAL kaleidoscope image (the
 * smallest tile index among its fold images), so a symmetric map stays
 * exactly symmetric under the active fold count — hash by raw position
 * would give every copy different hills. Returns the changed tiles.
 */
export function naturalize(state: EditorMapState, folds: number): number[] {
  const {map} = state;
  const size = map.size;
  const tiles = tileCount(size);

  // 4-neighbor BFS distances, capped like worldgen's (past a few tiles the
  // shaping saturates): to the nearest water for shore easing, to the
  // nearest land for bed shelving.
  const bfs = (isSeed: (t: number) => boolean): Float32Array => {
    const dist = new Float32Array(tiles).fill(99);
    const queue: number[] = [];
    for (let i = 0; i < tiles; i++) {
      if (isSeed(map.terrain[i]!)) {
        dist[i] = 0;
        queue.push(i);
      }
    }
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head]!;
      const x = tileX(i, size);
      const y = tileY(i, size);
      const d = dist[i]! + 1;
      if (d > 6) continue;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const) {
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const n = tileIdx(nx, ny, size);
        if (d < dist[n]!) {
          dist[n] = d;
          queue.push(n);
        }
      }
    }
    return dist;
  };
  const waterDist = bfs(t => t === Terrain.Water);
  const landDist = bfs(t => t !== Terrain.Water);

  const ease = (t: number): number => {
    const c = clamp(t, 0, 1);
    return c * c * (3 - 2 * c);
  };
  const noiseAt = (
    x: number,
    y: number,
    seed: number,
    scale: number,
  ): number => {
    const fx = x / scale;
    const fy = y / scale;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const h = (cx: number, cy: number): number =>
      hash2(seed + cx * 131, seed * 7 + cy * 337);
    const a = h(x0, y0);
    const b = h(x0 + 1, y0);
    const c = h(x0, y0 + 1);
    const d = h(x0 + 1, y0 + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };

  const changed: number[] = [];
  for (let i = 0; i < tiles; i++) {
    const x = tileX(i, size);
    const y = tileY(i, size);
    // Canonical fold image: every copy of a tile reads the same noise.
    const canon = tileImages(x, y, size, folds).reduce(
      (a, b) => Math.min(a, b),
      i,
    );
    const cx = tileX(canon, size);
    const cy = tileY(canon, size);
    const roll =
      (noiseAt(cx, cy, 61, 12) * 0.6 + noiseAt(cx, cy, 67, 5) * 0.4 - 0.5) *
      0.55;

    const before = map.height[i]!;
    let after: number;
    if (map.terrain[i] === Terrain.Water) {
      // Worldgen's bed: shelve by distance from land, textured by noise.
      const shelf = ease(landDist[i]! / 2.2);
      after = -0.34 - shelf * 0.95 - noiseAt(cx, cy, 71, 5) * 0.22;
    } else if (map.terrain[i] === Terrain.Rock) {
      // Ranges keep their cliff feet; the noise just roughens the crests.
      after = clamp(before + roll * 1.4, 1.1, 2.55);
    } else {
      // Meadow: the author's height plus a roll of the land, eased down
      // to the waterline near any shore — worldgen's exact shape.
      const target = clamp(before + roll, 0.05, 2.55);
      after = 0.04 + (target - 0.04) * ease(waterDist[i]! / 3.5);
    }
    if (Math.abs(after - before) > 1e-4) {
      map.height[i] = after;
      changed.push(i);
    }
  }
  return changed;
}
