import { hash2 } from '../shared/math';

/**
 * Smooth value noise in [0,1] over world coords — the renderer's one source
 * of organic wobble. Shared so that anything drawn along the same feature
 * (the terrain paint of a road and the cobbles laid on top of it) wanders
 * together instead of each inventing its own edge.
 */
export function vnoise(seed: number, x: number, y: number, scale: number): number {
  const fx = x / scale;
  const fy = y / scale;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const h = (cx: number, cy: number): number => hash2(seed + cx * 149, seed * 11 + cy * 331);
  const a = h(x0, y0);
  const b = h(x0 + 1, y0);
  const c = h(x0, y0 + 1);
  const d = h(x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
