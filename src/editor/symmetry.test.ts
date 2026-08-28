import {describe, expect, it} from 'vitest';
import {tileIdx, tileX, tileY} from '../shared/grid.ts';
import {foldBasis, rotateStart, tileImages} from './symmetry.ts';

/** The k=1 image of a tile under `folds`, as x/y (assumes it's in bounds). */
function image(
  x: number,
  y: number,
  size: number,
  folds: number,
  k: number,
): [number, number] {
  const imgs = tileImages(x, y, size, folds);
  // tileImages dedupes but preserves fold order starting at the identity.
  const idx = imgs[k]!;
  return [tileX(idx, size), tileY(idx, size)];
}

describe('tileImages', () => {
  it('matches the exact closed forms for fold 4', () => {
    const size = 64;
    for (const [x, y] of [
      [0, 0],
      [10, 3],
      [31, 31],
      [32, 32],
      [63, 0],
      [5, 60],
    ] as const) {
      const imgs = tileImages(x, y, size, 4);
      expect(imgs).toHaveLength(4);
      expect(imgs[1]).toBe(tileIdx(size - 1 - y, x, size));
      expect(imgs[2]).toBe(tileIdx(size - 1 - x, size - 1 - y, size));
      expect(imgs[3]).toBe(tileIdx(y, size - 1 - x, size));
    }
  });

  it('is an involution for fold 2', () => {
    const size = 96;
    for (const [x, y] of [
      [0, 0],
      [17, 40],
      [47, 47],
      [48, 48],
      [95, 95],
    ] as const) {
      const [ix, iy] = image(x, y, size, 2, 1);
      expect([ix, iy]).toEqual([size - 1 - x, size - 1 - y]);
      const back = tileImages(ix, iy, size, 2);
      expect(back[1]).toBe(tileIdx(x, y, size));
    }
  });

  it('applying the quarter turn four times is the identity', () => {
    const size = 96;
    for (const [x0, y0] of [
      [12, 34],
      [0, 95],
      [48, 48],
    ] as const) {
      let x: number = x0;
      let y: number = y0;
      for (let k = 0; k < 4; k++) [x, y] = image(x, y, size, 4, 1);
      expect([x, y]).toEqual([x0, y0]);
    }
  });

  it('fold 3 composes back to within one tile of the start', () => {
    const size = 96;
    for (const [x0, y0] of [
      [30, 20],
      [60, 70],
      [48, 20],
    ] as const) {
      // Chain the 1/3 turn three times through the rounded tile map.
      let x: number = x0;
      let y: number = y0;
      for (let k = 0; k < 3; k++) [x, y] = image(x, y, size, 3, 1);
      expect(Math.max(Math.abs(x - x0), Math.abs(y - y0))).toBeLessThanOrEqual(
        1,
      );
    }
  });

  it('drops out-of-bounds images and dedupes the center orbit', () => {
    const size = 64;
    // A corner tile's fold-3 images swing outside the square grid.
    const corner = tileImages(0, 0, size, 3);
    expect(corner.length).toBeLessThan(3);
    // The four tiles around the exact center form one orbit under fold 4 —
    // each is another's image, and each tile appears once.
    const c = size / 2;
    const orbit = tileImages(c, c, size, 4);
    expect(new Set(orbit).size).toBe(orbit.length);
    expect(orbit).toContain(tileIdx(c - 1, c, size));
  });

  it('fold 1 is just the tile itself', () => {
    expect(tileImages(5, 9, 64, 1)).toEqual([tileIdx(5, 9, 64)]);
  });
});

describe('rotateStart', () => {
  it('is exact for folds 2 and 4', () => {
    const size = 96;
    const s = {x: 46, y: 19};
    expect(rotateStart(s, size, 1, 4)).toEqual({x: size - s.y - 3, y: s.x});
    expect(rotateStart(s, size, 2, 4)).toEqual({
      x: size - s.x - 3,
      y: size - s.y - 3,
    });
    expect(rotateStart(s, size, 1, 2)).toEqual({
      x: size - s.x - 3,
      y: size - s.y - 3,
    });
  });

  it('round-trips: rotating k then folds-k lands home', () => {
    const size = 128;
    const s = {x: 30, y: 22};
    for (const folds of [2, 4] as const) {
      for (let k = 1; k < folds; k++) {
        expect(
          rotateStart(rotateStart(s, size, k, folds), size, folds - k, folds),
        ).toEqual(s);
      }
    }
  });

  it('keeps fold-3 images of an interior spot in bounds', () => {
    const size = 96;
    const s = {x: 46, y: 20};
    for (let k = 0; k < 3; k++) {
      const r = rotateStart(s, size, k, 3);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + 3).toBeLessThanOrEqual(size);
      expect(r.y + 3).toBeLessThanOrEqual(size);
    }
  });
});

describe('foldBasis', () => {
  it('has exact entries for 2 and 4 and unit-length steps for 3', () => {
    expect(foldBasis(4)).toEqual([
      {cos: 1, sin: 0},
      {cos: 0, sin: 1},
      {cos: -1, sin: 0},
      {cos: 0, sin: -1},
    ]);
    for (const {cos, sin} of foldBasis(3)) {
      expect(cos * cos + sin * sin).toBeCloseTo(1, 12);
    }
  });
});
