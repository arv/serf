/**
 * Stereo position and loudness for a world-space sound, under this game's
 * one unusual constraint: the camera is orthographic, 90 world units out,
 * and never rotates.
 *
 * That rules out the Web Audio PannerNode (and three's PositionalAudio
 * riding on it): with the listener parented to the camera, every unit on
 * screen is ~90 units away, so azimuth barely moves and distance models
 * barely attenuate — near-zero pan, near-uniform loudness. And
 * orthographic zoom, the thing that *feels* like moving closer, changes
 * the world distance to the camera by exactly nothing, so the panner
 * cannot hear it at all. So: plain StereoPanner values, computed here.
 *
 * The fixed 45° yaw (cameraRig's CAMERA_YAW — pan.test.ts pins the two
 * together) collapses the projection to arithmetic: screen-right is
 * proportional to (dx - dz). No trig, no camera matrix, no allocation —
 * this runs per audible unit per frame inside loops that pool everything.
 *
 * Everything is derived from the rig's public viewBounds() rect, which the
 * frame loop already computes: its centre is the look-at point, its
 * half-extent tracks zoom. The derivation assumes the rect is square
 * (true by construction today); pan.test.ts asserts that too, so an
 * anisotropic change fails loudly instead of skewing the stereo field.
 */

import { clamp } from '../shared/math';

/** Matches ViewBounds from render/cameraRig — declared structurally so this
 * module (and its tests) never touch a file that imports three. */
export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Spatial {
  pan: number;
  gain: number;
  audible: boolean;
}

/** Never fully one ear: hard-panned sounds vanish on headphones. */
export const PAN_CEIL = 0.9;
/** Fraction of the half-extent that maps to full pan deflection. */
const PAN_EDGE = 0.85;
/** Quadratic falloff steepness; 0.65 leaves the view edge audible (~0.35)
 * and silences a little beyond the corner. */
const FALLOFF = 0.65;
/**
 * Half-extent at the "reference" zoom: closer in, sounds play at full
 * design gain; further out, each source fades toward a floor and the
 * scheduler's crowd-collapse turns many quiet strikes into one murmur —
 * which is what a valley heard from a hilltop should be.
 */
const ZOOM_REF = 20;
const ZOOM_FLOOR = 0.35;

export const MIN_AUDIBLE = 0.02;

/**
 * Fill `out` with pan/gain for a source at world (x, z) under view `b`.
 * Writes into the caller's object — called per unit per frame.
 */
export function spatialize(x: number, z: number, b: Rect, out: Spatial): Spatial {
  const ext = (b.maxX - b.minX) / 2;
  if (ext <= 0) {
    out.pan = 0;
    out.gain = 0;
    out.audible = false;
    return out;
  }
  const dx = x - (b.minX + b.maxX) / 2;
  const dz = z - (b.minZ + b.maxZ) / 2;
  // Screen basis for a fixed 45° yaw: right = (dx - dz)/√2, up = -(dx + dz)/√2.
  const right = (dx - dz) * Math.SQRT1_2;
  const fwd = (dx + dz) * Math.SQRT1_2;
  out.pan = clamp(right / (ext * PAN_EDGE), -1, 1) * PAN_CEIL;
  const d2 = (right * right + fwd * fwd) / (ext * ext);
  const zoomGain = clamp(ZOOM_REF / ext, ZOOM_FLOOR, 1);
  out.gain = clamp(1 - d2 * FALLOFF, 0, 1) * zoomGain;
  out.audible = out.gain > MIN_AUDIBLE;
  return out;
}
