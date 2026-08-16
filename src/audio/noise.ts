/**
 * The one noise table every noise layer plays through. Deterministic —
 * hash2, not Math.random — not because the sim demands it (audio is
 * main-thread presentation), but because it makes the RMS test exact and
 * two sessions render bit-identical cue buffers for free.
 */

import { hash2 } from '../shared/math';

/** Fill `out` with white noise in [-1, 1) for a given seed. */
export function fillNoise(out: Float32Array, seed: number): void {
  for (let i = 0; i < out.length; i++) {
    out[i] = hash2(seed, i) * 2 - 1;
  }
}
