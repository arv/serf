/**
 * Deterministic PRNG (mulberry32). The sim stores only `state` (a number) in
 * the World so it serializes trivially; wrap it in an Rng for a tick, then
 * write `.state` back.
 */
export class Rng {
  state: number;

  constructor(state: number) {
    this.state = state;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Uniform float in [a, b). */
  range(a: number, b: number): number {
    return a + this.next() * (b - a);
  }

  /** Pick a random element. Array must be non-empty. */
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)]!;
  }
}
