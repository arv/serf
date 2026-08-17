import { describe, expect, it } from 'vitest';
import { DEFAULT_MAP_SIZE, tileCount, tileIdx } from '../shared/grid';
import { PathLevel } from '../sim/map';
import { ROAD_HALF, TRAIL_HALF, newRibbonDist, ribbonCover, ribbonDistances } from './pathRibbon';

function mapWith(tiles: readonly (readonly [number, number, number])[]): Uint8Array {
  const path = new Uint8Array(tileCount(DEFAULT_MAP_SIZE));
  for (const [x, y, level] of tiles) path[tileIdx(x, y, DEFAULT_MAP_SIZE)] = level;
  return path;
}

/** A straight east-west run of trail tiles through y = 10. */
const lane = mapWith([8, 9, 10, 11, 12].map((x) => [x, 10, PathLevel.Trail] as const));

describe('path ribbons', () => {
  const dist = newRibbonDist();

  it('runs down the middle of a lane, not over the whole tile', () => {
    // Centerline of the tiles: on the ribbon.
    ribbonDistances(lane, 10, 10.5, dist);
    expect(dist.trail).toBe(0);
    // The tile's own corner is grass — this is the whole point.
    ribbonDistances(lane, 10.05, 10.05, dist);
    expect(dist.trail).toBeGreaterThan(TRAIL_HALF);
  });

  it('joins neighbors with no gap at the shared edge', () => {
    // Sample straight along the lane, edges included: never leaves the ribbon.
    for (let x = 8.5; x <= 12.5; x += 0.1) {
      ribbonDistances(lane, x, 10.5, dist);
      expect(dist.trail).toBeLessThan(0.001);
    }
  });

  it('rounds off a dead end rather than squaring it', () => {
    // Just past the last tile's center, still within a half-width: covered.
    ribbonDistances(lane, 12.5 + TRAIL_HALF * 0.4, 10.5, dist);
    expect(dist.trail).toBeLessThan(TRAIL_HALF);
    // A whole tile beyond the end: nothing.
    ribbonDistances(lane, 13.9, 10.5, dist);
    expect(dist.trail).toBeGreaterThan(TRAIL_HALF);
  });

  it('threads diagonal steps, which the pathfinder also takes', () => {
    const stair = mapWith([
      [4, 4, PathLevel.Trail],
      [5, 5, PathLevel.Trail],
    ]);
    // The corner the two tiles share is the middle of the diagonal ribbon.
    ribbonDistances(stair, 5, 5, dist);
    expect(dist.trail).toBe(0);
  });

  it('keeps trails and roads apart so each paints its own width', () => {
    const mixed = mapWith([
      [20, 20, PathLevel.Trail],
      [21, 20, PathLevel.Road],
    ]);
    ribbonDistances(mixed, 20.5, 20.5, dist);
    expect(dist.trail).toBe(0);
    expect(dist.road).toBeGreaterThan(0);
    ribbonDistances(mixed, 21.5, 20.5, dist);
    expect(dist.road).toBe(0);
  });

  it('reports full coverage down the middle and none off the shoulder', () => {
    const cover = { trail: 0, road: 0 };
    // The wobble moves the edge around, so judge the middle and the far side.
    ribbonCover(lane, 10, 10.5, cover);
    expect(cover.trail).toBeGreaterThan(0.5);
    ribbonCover(lane, 10, 12, cover);
    expect(cover.trail).toBe(0);
  });

  it('leaves untouched ground clear', () => {
    ribbonDistances(lane, 30, 30, dist);
    expect(dist.trail).toBe(Infinity);
    expect(dist.road).toBe(Infinity);
    expect(TRAIL_HALF).toBeLessThan(ROAD_HALF);
  });
});
