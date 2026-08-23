/**
 * Stereo position and loudness for a world-space sound, under this game's
 * one unusual constraint: the camera is orthographic and 90 world units
 * out, and the only way it moves is along the ground and about its own
 * look-at point.
 *
 * That rules out the Web Audio PannerNode (and three's PositionalAudio
 * riding on it): with the listener parented to the camera, every unit on
 * screen is ~90 units away, so azimuth barely moves and distance models
 * barely attenuate — near-zero pan, near-uniform loudness. And
 * orthographic zoom, the thing that *feels* like moving closer, changes
 * the world distance to the camera by exactly nothing, so the panner
 * cannot hear it at all. So: plain StereoPanner values, computed here.
 *
 * An orthographic camera collapses the projection to arithmetic: how far
 * right of centre a sound sits on screen is the dot of its ground offset
 * with the screen-right direction on the ground, which the rig hands over
 * once per frame (viewFrame) along with the centre and a half-extent. No
 * trig, no camera matrix, no allocation — this runs per audible unit per
 * frame inside loops that pool everything. Turning the camera turns the
 * basis and nothing here notices.
 */

import { clamp } from '../shared/math';

/** Matches ViewFrame from render/cameraRig — declared structurally so this
 * module (and its tests) never touch a file that imports three. `ext` is
 * the half-extent the falloff and the zoom fade are tuned against; the rig
 * holds it yaw-invariant (see CameraRig.viewFrame). */
export interface ViewFrame {
  cx: number;
  cz: number;
  rx: number;
  rz: number;
  ext: number;
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
 * Fill `out` with pan/gain for a source at world (x, z) under view `v`.
 * Writes into the caller's object — called per unit per frame.
 */
export function spatialize(x: number, z: number, v: ViewFrame, out: Spatial): Spatial {
  const ext = v.ext;
  if (ext <= 0) {
    out.pan = 0;
    out.gain = 0;
    out.audible = false;
    return out;
  }
  const dx = x - v.cx;
  const dz = z - v.cz;
  // The offset in the screen's ground basis: right is the rig's, and
  // screen-vertical is its perpendicular (rz, -rx) — the sign is moot,
  // only its square is used. At 45° this is the old right = (dx - dz)/√2.
  const right = dx * v.rx + dz * v.rz;
  const fwd = dx * v.rz - dz * v.rx;
  out.pan = clamp(right / (ext * PAN_EDGE), -1, 1) * PAN_CEIL;
  const d2 = (right * right + fwd * fwd) / (ext * ext);
  const zoomGain = clamp(ZOOM_REF / ext, ZOOM_FLOOR, 1);
  out.gain = clamp(1 - d2 * FALLOFF, 0, 1) * zoomGain;
  out.audible = out.gain > MIN_AUDIBLE;
  return out;
}
