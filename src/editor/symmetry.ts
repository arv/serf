import {inBounds, tileIdx} from '../shared/grid.ts';
import type {StartSpot} from '../sim/map.ts';

/**
 * Kaleidoscope math: N-fold rotation about the map's center. The center in
 * tile-corner space is exactly (size/2, size/2) — world sizes are forced
 * even (see resolveMapSize) — so folds 2 and 4 are exact integer maps of
 * the tile grid, and fold 3 is a rounded rotation that lands within a tile.
 *
 * Everything here works on the *continuous* grid plane and floors back to
 * tiles at the end. The brush rotates its stroke center this way rather
 * than rotating painted tiles one by one: a Euclidean-disc stamp around a
 * rotated center is rotation-invariant by construction, so the copies come
 * out congruent even when the fold angle doesn't align with the grid.
 */

export interface FoldStep {
  cos: number;
  sin: number;
}

/** cos/sin of 1/n turns — constant tables, exact ±1/0 entries for 1/2/4. */
const HALF_ROOT3 = Math.sqrt(3) / 2;
const BASES: Record<number, FoldStep[]> = {
  1: [{cos: 1, sin: 0}],
  2: [
    {cos: 1, sin: 0},
    {cos: -1, sin: 0},
  ],
  3: [
    {cos: 1, sin: 0},
    {cos: -0.5, sin: HALF_ROOT3},
    {cos: -0.5, sin: -HALF_ROOT3},
  ],
  4: [
    {cos: 1, sin: 0},
    {cos: 0, sin: 1},
    {cos: -1, sin: 0},
    {cos: 0, sin: -1},
  ],
};

/** The k-th entry rotates by k/n of a full turn; entry 0 is the identity. */
export function foldBasis(folds: number): FoldStep[] {
  return BASES[folds] ?? BASES[1]!;
}

/** Rotate a continuous grid point about the map center (size/2, size/2). */
export function rotatePoint(
  x: number,
  y: number,
  size: number,
  step: FoldStep,
): {x: number; y: number} {
  const c = size / 2;
  const u = x - c;
  const v = y - c;
  return {
    x: c + u * step.cos - v * step.sin,
    y: c + u * step.sin + v * step.cos,
  };
}

/**
 * All fold images of one tile, as deduped in-bounds tile indices (the
 * source tile included). Rotates the tile's center and floors back; for
 * folds 2/4 this reduces to the exact closed forms (size-1-x, size-1-y)
 * and (size-1-y, x).
 */
export function tileImages(
  x: number,
  y: number,
  size: number,
  folds: number,
): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const step of foldBasis(folds)) {
    const p = rotatePoint(x + 0.5, y + 0.5, size, step);
    const tx = Math.floor(p.x);
    const ty = Math.floor(p.y);
    if (!inBounds(tx, ty, size)) continue;
    const i = tileIdx(tx, ty, size);
    if (seen.has(i)) continue;
    seen.add(i);
    out.push(i);
  }
  return out;
}

/** Storehouse footprint side — start spots are 3x3 footprint origins. */
const START_W = 3;

/**
 * The k-th fold image of a start spot: rotate the 3x3 footprint's center
 * (x+1.5, y+1.5) and round back to an origin. Exact for folds 2 and 4
 * (the half-tile center offset cancels against the even-sized map's
 * integer center); fold 3 rounds to the nearest whole origin.
 */
export function rotateStart(
  s: StartSpot,
  size: number,
  k: number,
  folds: number,
): StartSpot {
  const step = foldBasis(folds)[((k % folds) + folds) % folds]!;
  const half = START_W / 2;
  const p = rotatePoint(s.x + half, s.y + half, size, step);
  return {x: Math.round(p.x - half), y: Math.round(p.y - half)};
}
