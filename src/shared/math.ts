/**
 * Euclidean distance via sqrt (correctly rounded per IEEE-754, unlike
 * Math.hypot) — lockstep clients on different JS engines must agree, and the
 * renderer must judge "in reach" by exactly the rule combat strikes by.
 */
export function exactDist(dx: number, dy: number): number {
  return Math.sqrt(dx * dx + dy * dy);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Deterministic 2D hash to a float in [0, 1). For stable *visual* jitter
 * (vertex tint, scatter placement) — not part of sim randomness.
 */
export function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
