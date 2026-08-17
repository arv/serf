import { tileIdx } from '../shared/grid';

/**
 * Bilinear sampler over the per-tile elevation map. Tile heights are treated
 * as samples at tile centers (x+0.5, y+0.5); everything the renderer places
 * on the ground asks this for its y.
 */
export class HeightField {
  #heights: Float32Array;
  readonly size: number;

  constructor(heights: Float32Array, size: number) {
    this.#heights = heights;
    this.size = size;
  }

  #tile(x: number, y: number): number {
    const cx = Math.max(0, Math.min(this.size - 1, x));
    const cy = Math.max(0, Math.min(this.size - 1, y));
    return this.#heights[tileIdx(cx, cy, this.size)]!;
  }

  /** Ground height at world (x, z). */
  at(x: number, z: number): number {
    const fx = x - 0.5;
    const fz = z - 0.5;
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const tx = fx - x0;
    const tz = fz - z0;
    const a = this.#tile(x0, z0);
    const b = this.#tile(x0 + 1, z0);
    const c = this.#tile(x0, z0 + 1);
    const d = this.#tile(x0 + 1, z0 + 1);
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  }

  /** Height at a vertex corner (integer lattice): average of adjacent tiles. */
  atVertex(vx: number, vz: number): number {
    let sum = 0;
    let n = 0;
    for (let dz = -1; dz <= 0; dz++) {
      for (let dx = -1; dx <= 0; dx++) {
        const tx = vx + dx;
        const tz = vz + dz;
        if (tx < 0 || tz < 0 || tx >= this.size || tz >= this.size) continue;
        sum += this.#heights[tileIdx(tx, tz, this.size)]!;
        n++;
      }
    }
    return n > 0 ? sum / n : 0;
  }
}
