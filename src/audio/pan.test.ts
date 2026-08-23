import { describe, expect, it } from 'vitest';
import { CAMERA_YAW } from '../render/cameraRig';
import { MIN_AUDIBLE, PAN_CEIL, type Spatial, type ViewFrame, spatialize } from './pan';

/** The full diamond: the yaw the stereo field was tuned on, where world
 * +x -z is screen-right and dx === dz is straight up the screen. */
const ISO = Math.PI / 4;

/** A frame centred at (cx, cz) with half-extent `ext`, looking down the
 * diamond unless told otherwise — the screen-right vector is the one
 * CameraRig.viewFrame derives from its yaw. */
const rect = (cx: number, cz: number, ext: number, yaw = ISO): ViewFrame => ({
  cx,
  cz,
  rx: Math.cos(yaw),
  rz: -Math.sin(yaw),
  ext,
});

const at = (x: number, z: number, b: ViewFrame): Spatial =>
  spatialize(x, z, b, { pan: 0, gain: 0, audible: false });

describe('spatialize', () => {
  it('pans in the basis it is handed, not a hard-coded 45°', () => {
    // Squared to the grid (yaw 0): world +x is screen-right, world z is
    // screen-vertical and carries no stereo at all. Turned, the same
    // world offset is foreshortened by the cosine of the turn — on the
    // diamond, √½; on the rig's own boot line, whatever that cosine is.
    const square = rect(50, 50, 20, 0);
    expect(at(60, 50, square).pan).toBeGreaterThan(0);
    expect(at(40, 50, square).pan).toBeLessThan(0);
    expect(at(50, 60, square).pan).toBe(0);
    const right = at(60, 50, square).pan;
    expect(at(60, 50, rect(50, 50, 20)).pan).toBeCloseTo(right * Math.SQRT1_2, 10);
    expect(at(60, 50, rect(50, 50, 20, CAMERA_YAW)).pan).toBeCloseTo(right * Math.cos(CAMERA_YAW), 10);
    // A quarter turn on from the diamond is its mirror: world +x -z, the
    // diamond's screen-right, is now straight up the screen.
    expect(at(55, 45, rect(50, 50, 20, ISO + Math.PI / 2)).pan).toBeCloseTo(0, 10);
  });

  it('gain hears the same valley whichever way the camera faces', () => {
    // The extent is the rig's to hold yaw-invariant; given the same one, a
    // source at the same screen distance is exactly as loud at any yaw.
    for (const yaw of [0, CAMERA_YAW, ISO, 1.1, Math.PI]) {
      const b = rect(0, 0, 20, yaw);
      const sx = 9 * Math.cos(yaw);
      const sz = -9 * Math.sin(yaw);
      expect(at(sx, sz, b).gain).toBeCloseTo(at(9, 0, rect(0, 0, 20, 0)).gain, 10);
      expect(at(0, 0, b).gain).toBeCloseTo(1, 5);
    }
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
    // Along screen-vertical (dx === dz) there is no stereo offset at all
    // (to the ulp cos(π/4) and sin(π/4) differ by).
    expect(at(56, 56, b).pan).toBeCloseTo(0, 12);
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

  it('a degenerate frame is silent, not NaN', () => {
    const s = at(5, 5, rect(5, 5, 0));
    expect(s.audible).toBe(false);
    expect(s.gain).toBe(0);
    expect(s.pan).toBe(0);
  });
});
