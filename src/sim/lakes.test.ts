import {describe, expect, it} from 'vitest';
import {tileCount, tileIdx} from '../shared/grid.ts';
import {
  DRY_LEVEL_T,
  LAKE_LEVEL_T,
  MIN_LAKE_TILES,
  settleBasins,
  type GameMap,
} from './map.ts';
import * as Terrain from './terrainEnum.ts';

/**
 * The lake floor where the generated seeds cannot reach it.
 *
 * `mapFairness.test.ts` pins the floor on finished worlds, at all three
 * map sizes — the audit that matters, since it is the map a player is
 * handed. What it cannot cover is the one pass that takes water AWAY:
 * the causeway carve only runs when the lakes cut a start off from home,
 * and over 540 generated worlds (three sizes, sixty seeds, two to four
 * seats) the noise has never once done that. Every seed the suite could
 * roll leaves the carve unexecuted, so the second `settleBasins` behind
 * it would be dead as far as any generated case is concerned — remove
 * the call and the whole suite stays green.
 *
 * So the split is handed to `settleBasins` directly: a lake, a 2-wide
 * cut through it, and the two short halves that leaves. Synthetic ground
 * rather than a generated valley, which is the point — the shape under
 * test is one the generator has yet to produce and must still survive.
 */

/** A bare map: every field `settleBasins` reads, and nothing else. */
function blankMap(size: number): GameMap {
  const tiles = tileCount(size);
  return {
    size,
    play: size,
    terrain: new Uint8Array(tiles),
    resource: new Uint8Array(tiles),
    resourceAmt: new Uint8Array(tiles),
    blocked: new Uint8Array(tiles),
    buildingAt: new Int16Array(tiles).fill(-1),
    wear: new Float32Array(tiles),
    pathLevel: new Uint8Array(tiles),
    height: new Float32Array(tiles),
  };
}

/** Every 4-connected body of water on the map, as tile counts. */
function waterBodies(map: GameMap): number[] {
  const {size, terrain} = map;
  const seen = new Uint8Array(tileCount(size));
  const bodies: number[] = [];
  for (let start = 0; start < seen.length; start++) {
    if (seen[start] || terrain[start] !== Terrain.Water) continue;
    const body = [start];
    seen[start] = 1;
    for (let head = 0; head < body.length; head++) {
      const i = body[head]!;
      const x = i % size;
      const y = (i / size) | 0;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const) {
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const n = tileIdx(nx, ny, size);
        if (seen[n] || terrain[n] !== Terrain.Water) continue;
        seen[n] = 1;
        body.push(n);
      }
    }
    bodies.push(body.length);
  }
  return bodies;
}

const SIZE = 40;
/** The basin's low ground: dry, but under the head a lake may rise through. */
const BASIN_T = LAKE_LEVEL_T + 0.02;
/** Everything outside it: hillside no basin can climb. */
const HILL_T = 0.9;

/**
 * A lake in a basin it has room to grow in, cut in two by a causeway.
 * `lake` and `basin` are inclusive tile bounds; the cut runs the basin's
 * full height, so neither half can reach the other around its ends.
 */
function splitLake(): {map: GameMap; raw: Float32Array; cut: number[]} {
  const map = blankMap(SIZE);
  const raw = new Float32Array(tileCount(SIZE)).fill(HILL_T);
  for (let y = 8; y <= 20; y++) {
    for (let x = 8; x <= 20; x++) raw[tileIdx(x, y, SIZE)] = BASIN_T;
  }
  for (let y = 10; y <= 18; y++) {
    for (let x = 10; x <= 18; x++) {
      const i = tileIdx(x, y, SIZE);
      raw[i] = LAKE_LEVEL_T - 0.06;
      map.terrain[i] = Terrain.Water;
    }
  }
  // The causeway: two columns of the generator's own dried ground.
  const cut: number[] = [];
  for (let y = 8; y <= 20; y++) {
    for (const x of [13, 14]) {
      const i = tileIdx(x, y, SIZE);
      map.terrain[i] = Terrain.Grass;
      raw[i] = DRY_LEVEL_T;
      cut.push(i);
    }
  }
  return {map, raw, cut};
}

describe('the lake floor under a causeway', () => {
  it('the halves a 2-wide cut leaves are not left as puddles', () => {
    const {map, raw} = splitLake();
    // The cut is what makes this worth testing: 81 tiles of lake come out
    // as 27 and 36, each short of a lake on its own.
    expect(waterBodies(map).sort((a, b) => a - b)).toEqual([27, 36]);

    settleBasins(map, raw, () => false);

    for (const body of waterBodies(map)) {
      expect(body).toBeGreaterThanOrEqual(MIN_LAKE_TILES);
    }
    // Both halves had room to rise, so neither is drained away: this is
    // the repair doing its work, not the map going dry.
    expect(waterBodies(map).length).toBe(2);
  });

  it('rising water never takes the causeway back', () => {
    const {map, raw, cut} = splitLake();
    settleBasins(map, raw, () => false);
    // DRY_LEVEL_T stands above the head a basin may rise through, which
    // is the whole reason this pass is safe to run behind the carve —
    // the bridge a start's landmass depends on cannot be re-flooded by
    // the water it just divided.
    for (const i of cut) expect(map.terrain[i]).toBe(Terrain.Grass);
  });

  it('a basin with nowhere to rise is filled in, not left short', () => {
    const {map, raw, cut} = splitLake();
    // Hillside right up to the water: neither half can take a tile.
    for (let i = 0; i < raw.length; i++) {
      if (map.terrain[i] !== Terrain.Water) raw[i] = HILL_T;
    }
    for (const i of cut) raw[i] = DRY_LEVEL_T;

    settleBasins(map, raw, () => false);

    expect(waterBodies(map)).toEqual([]);
    // Filled ground comes back up with the map, or the height curve reads
    // a drowned tile where there is no longer any water.
    for (let i = 0; i < raw.length; i++) {
      expect(raw[i]).toBeGreaterThanOrEqual(LAKE_LEVEL_T);
    }
  });
});
