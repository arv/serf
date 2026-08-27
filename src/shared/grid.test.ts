import { describe, expect, it } from 'vitest';
import {
  MARGIN_CEIL,
  MARGIN_FLOOR,
  MAX_MAP_SIZE,
  MIN_MAP_SIZE,
  gridFor,
  marginFor,
} from './grid.ts';

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

  it('stays inside the band the camera was sized against', () => {
    // Snapping to the nearest four moves the realized fraction away from
    // MARGIN_FRACTION, and it may move DOWN — which is the direction that
    // matters, because the ring has to cover how far a frame reaches past
    // the boundary at full zoom-out (0.373 sides on the worst 16:9 case,
    // see marginFor's own comment). The floor is what keeps that true; the
    // ceiling is what keeps the saving honest.
    for (const play of legalPlaySizes()) {
      const fraction = marginFor(play) / play;
      expect(fraction, `play ${play}`).toBeGreaterThanOrEqual(MARGIN_FLOOR);
      expect(fraction, `play ${play}`).toBeLessThanOrEqual(MARGIN_CEIL);
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
