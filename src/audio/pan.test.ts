import { describe, expect, it } from 'vitest';
import { CAMERA_YAW } from '../render/cameraRig';
import { MIN_AUDIBLE, PAN_CEIL, type Rect, type Spatial, spatialize } from './pan';

const rect = (cx: number, cz: number, ext: number): Rect => ({
  minX: cx - ext,
  maxX: cx + ext,
  minZ: cz - ext,
  maxZ: cz + ext,
});

const at = (x: number, z: number, b: Rect): Spatial =>
  spatialize(x, z, b, { pan: 0, gain: 0, audible: false });

describe('spatialize', () => {
  it('assumes the camera yaw it hard-codes: 45°, forever', () => {
    // pan.ts's screen basis is right = (dx - dz)/√2 — only true at π/4.
    // If the rig ever rotates, this failure is the map to what must change.
    expect(CAMERA_YAW).toBe(Math.PI / 4);
  });

  it('centres: pan 0, full gain at reference zoom', () => {
    const s = at(50, 50, rect(50, 50, 20));
    expect(s.pan).toBe(0);
    expect(s.gain).toBeCloseTo(1, 5);
    expect(s.audible).toBe(true);
  });

  it('screen-right (world +x -z) pans right, screen-down stays centred', () => {
    const b = rect(50, 50, 20);
    expect(at(55, 45, b).pan).toBeGreaterThan(0);
    expect(at(45, 55, b).pan).toBeLessThan(0);
    // Along screen-vertical (dx === dz) there is no stereo offset at all.
    expect(at(56, 56, b).pan).toBe(0);
  });

  it('mirror symmetry: swapping dx/dz negates pan, preserves gain', () => {
    const b = rect(50, 50, 20);
    const s1 = at(57, 46, b);
    const s2 = at(46, 57, b);
    expect(s2.pan).toBeCloseTo(-s1.pan, 10);
    expect(s2.gain).toBeCloseTo(s1.gain, 10);
  });

  it('pan grows with screen-right offset and clamps at the ceiling', () => {
    const b = rect(0, 0, 20);
    let prev = 0;
    for (const off of [2, 5, 9, 13]) {
      const p = at(off, -off, b).pan;
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
    expect(at(60, -60, b).pan).toBe(PAN_CEIL);
    expect(at(-60, 60, b).pan).toBe(-PAN_CEIL);
  });

  it('gain falls monotonically with distance and reaches silence', () => {
    const b = rect(0, 0, 20);
    let prev = Infinity;
    for (const off of [0, 4, 8, 12, 16, 20]) {
      const g = at(off, -off, b).gain;
      expect(g).toBeLessThan(prev);
      prev = g;
    }
    const far = at(80, -80, b);
    expect(far.gain).toBe(0);
    expect(far.audible).toBe(false);
  });

  it('screen edges stay audible; the AABB corners beyond them are not', () => {
    const b = rect(0, 0, 20);
    // Screen-edge along the pan axis: right ≈ ext (d ≈ 1 normalized).
    const edge = at(14, -14, b);
    expect(edge.gain).toBeGreaterThan(MIN_AUDIBLE);
    // The bounds rect is the AABB of a rotated footprint: its world-space
    // corners lie off screen (d² = 2), and off screen is silent.
    expect(at(20, 20, b).audible).toBe(false);
    expect(at(20, -20, b).audible).toBe(false);
  });

  it('zooming out shrinks pan deflection for the same world offset', () => {
    const near = at(4, 0, rect(0, 0, 6));
    const far = at(4, 0, rect(0, 0, 26));
    expect(Math.abs(far.pan)).toBeLessThan(Math.abs(near.pan));
  });

  it('zoomed out, the same screen position is quieter — a hilltop murmur', () => {
    // Identical normalized screen offset, different zooms: the zoom term
    // is what fades individual sources as the valley shrinks on screen.
    const near = at(1.2, 0, rect(0, 0, 6));
    const far = at(5.2, 0, rect(0, 0, 26));
    expect(far.gain).toBeLessThan(near.gain);
    expect(at(0, 0, rect(0, 0, 26)).gain).toBeLessThan(at(0, 0, rect(0, 0, 6)).gain);
  });

  it('a degenerate rect is silent, not NaN', () => {
    const s = at(5, 5, rect(5, 5, 0));
    expect(s.audible).toBe(false);
    expect(s.gain).toBe(0);
    expect(s.pan).toBe(0);
  });
});
