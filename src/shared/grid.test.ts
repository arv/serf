import { describe, expect, it } from 'vitest';
import { MAX_MAP_SIZE, MIN_MAP_SIZE, gridFor, marginFor, marginTargetFor } from './grid.ts';

/** Every playable side a world can be built at (resolveMapSize forces even). */
function legalPlaySizes(): number[] {
  const out: number[] = [];
  for (let play = MIN_MAP_SIZE; play <= MAX_MAP_SIZE; play += 2) out.push(play);
  return out;
}

describe('marginFor', () => {
  it('lands a whole number of texture repeats out, at every legal size', () => {
    // Four tiles is one repeat of the ground detail texture, which the fine
    // mesh phases from the play square's corner and the margin mesh from the
    // grid's. An offset between them that is not a multiple of four steps
    // the speckle across the boundary the two meshes exist to hide.
    for (const play of legalPlaySizes()) {
      expect(marginFor(play) % 4, `play ${play}`).toBe(0);
      expect(gridFor(play) % 2, `play ${play}`).toBe(0);
    }
  });

  it('rounds the target up, never into it', () => {
    // marginTargetFor is the frame's overshoot itself, not a figure with
    // slack in it, so the rounding may only ever add. The upper bound is
    // the other half of that: one repeat is all it is allowed to add, or
    // the snapping has quietly become a second margin.
    for (const play of legalPlaySizes()) {
      const target = marginTargetFor(play);
      expect(marginFor(play), `play ${play}`).toBeGreaterThanOrEqual(target);
      expect(marginFor(play), `play ${play}`).toBeLessThan(target + 4);
    }
  });

  it('is affine in the play side, not proportional', () => {
    // The shape is the point: a share of the side plus a flat allowance.
    // Were it a fraction, the ring would be the same proportion of the
    // smallest map as the largest, and the smallest is where the flat four
    // tiles of pan weigh most. So the proportion must FALL as maps grow.
    const small = marginFor(MIN_MAP_SIZE) / MIN_MAP_SIZE;
    const large = marginFor(MAX_MAP_SIZE) / MAX_MAP_SIZE;
    expect(large).toBeLessThan(small);
    // And it must still be a ring, not a rounding error at one end or half
    // the world at the other, anywhere in the range.
    for (const play of legalPlaySizes()) {
      expect(marginFor(play) / play, `play ${play}`).toBeGreaterThan(0.15);
      expect(marginFor(play) / play, `play ${play}`).toBeLessThan(0.5);
    }
  });

  it('grows with the playable side and never shrinks', () => {
    let last = 0;
    for (const play of legalPlaySizes()) {
      const margin = marginFor(play);
      expect(margin, `play ${play}`).toBeGreaterThanOrEqual(last);
      last = margin;
    }
  });
});
