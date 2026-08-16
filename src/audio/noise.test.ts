import { describe, expect, it } from 'vitest';
import { fillNoise } from './noise';

describe('fillNoise', () => {
  it('is deterministic per seed', () => {
    const a = new Float32Array(1024);
    const b = new Float32Array(1024);
    fillNoise(a, 7);
    fillNoise(b, 7);
    expect(a).toEqual(b);
    fillNoise(b, 8);
    expect(a).not.toEqual(b);
  });

  it('stays in [-1, 1) with the RMS of uniform white noise', () => {
    const buf = new Float32Array(1 << 15);
    fillNoise(buf, 1013);
    let sumSq = 0;
    for (const s of buf) {
      expect(s).toBeGreaterThanOrEqual(-1);
      expect(s).toBeLessThan(1);
      sumSq += s * s;
    }
    // Uniform over [-1, 1) has RMS 1/√3 ≈ 0.577.
    const rms = Math.sqrt(sumSq / buf.length);
    expect(rms).toBeGreaterThan(0.55);
    expect(rms).toBeLessThan(0.61);
  });

  it('has no DC bias worth speaking of', () => {
    const buf = new Float32Array(1 << 15);
    fillNoise(buf, 1013);
    let sum = 0;
    for (const s of buf) sum += s;
    expect(Math.abs(sum / buf.length)).toBeLessThan(0.02);
  });
});
