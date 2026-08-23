import * as THREE from 'three';
import type { HeightField } from '../render/heightField';

const ndc = new THREE.Vector3();
const origin = new THREE.Vector3();
const dir = new THREE.Vector3();

/**
 * Analytic picking — no Raycaster. Ground positions come from intersecting
 * the camera ray with the terrain: a y=0 plane hit refined against the
 * height field (a few fixed-point steps converge fast on gentle hills).
 * Unit picking projects unit positions to screen space instead.
 *
 * `lift` raises the sampled surface by that many world units, keeping it
 * parallel to the ground — the slab probe screenToBuilding walks up a
 * building's own height.
 */
export function screenToGround(
  camera: THREE.Camera,
  canvas: HTMLCanvasElement,
  px: number,
  py: number,
  heights?: HeightField,
  lift = 0,
): { x: number; z: number } | null {
  ndc.set((px / canvas.clientWidth) * 2 - 1, -(py / canvas.clientHeight) * 2 + 1, -1);
  origin.copy(ndc).unproject(camera);
  ndc.z = 1;
  dir.copy(ndc).unproject(camera).sub(origin).normalize();
  if (Math.abs(dir.y) < 1e-6) return null;
  let t = (lift - origin.y) / dir.y;
  if (t < 0) return null;
  if (heights) {
    for (let i = 0; i < 4; i++) {
      const hx = origin.x + dir.x * t;
      const hz = origin.z + dir.z * t;
      t = (heights.at(hx, hz) + lift - origin.y) / dir.y;
    }
  }
  return { x: origin.x + dir.x * t, z: origin.z + dir.z * t };
}

/**
 * How tall the things standing on the map are drawn — the renderer's own
 * measurements, since only it has the models. Structural, so BuildingSync
 * satisfies it without the renderer having to know about picking.
 */
export interface BuildingHeights {
  /** How tall this building is drawn above its own ground, in world units.
   * 0 for a building the renderer cannot measure, which reduces its pick to
   * the footprint it stands on. */
  heightOf(id: number): number;
  /** The tallest of them, so the walk starts just over the roofline instead
   * of at some constant that a taller model would quietly outgrow. */
  tallest(): number;
}

/** What screenToBuilding needs to know about what is standing where. */
export interface BuildingProbe extends BuildingHeights {
  /** Building occupying the tile under world (x, z), or -1 for bare ground. */
  idAt(x: number, z: number): number;
}

/**
 * Vertical spacing of the slab probes, in world units. Small enough that no
 * building is stepped clean over: at the rig's 35° pitch a step of this size
 * slides the sample ~0.36 tiles across the ground, and the smallest thing
 * that can be standing there is a whole tile wide.
 */
const PROBE_STEP = 0.25;

/**
 * A footprint's own headroom, in world units. A roof tapers to a ridge and
 * a tower to a spire, so the topmost pixels of a model sit inside a box
 * that is a touch taller than the model — and a click a hair over the
 * ridge is, to the eye, a click on the building.
 */
const HEADROOM = 0.2;

/**
 * The building under a screen point, or -1 — the footprint's whole box, not
 * just the plate it stands on. Clicking a castle's towers picks the castle,
 * where a ground-plane hit alone would read through the model and land on
 * whatever tile lies behind it.
 *
 * The walk goes top down, which is near-to-far along the ray: the first box
 * it lands in is the one nearest the camera, so a building never picks
 * through one standing in front of it.
 */
export function screenToBuilding(
  camera: THREE.Camera,
  canvas: HTMLCanvasElement,
  px: number,
  py: number,
  heights: HeightField,
  probe: BuildingProbe,
): number {
  const top = probe.tallest() + HEADROOM;
  for (let lift = Math.ceil(top / PROBE_STEP) * PROBE_STEP; lift >= 0; lift -= PROBE_STEP) {
    const p = screenToGround(camera, canvas, px, py, heights, lift);
    if (!p) continue;
    const id = probe.idAt(p.x, p.z);
    if (id >= 0 && probe.heightOf(id) + HEADROOM >= lift) return id;
  }
  return -1;
}

const world = new THREE.Vector3();

/** Project a world position to canvas pixels. Pass `out` to skip the
 * per-call allocation in tight per-unit scans. */
export function worldToScreen(
  camera: THREE.Camera,
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
  z: number,
  out?: { x: number; y: number },
): { x: number; y: number } {
  world.set(x, y, z).project(camera);
  const o = out ?? { x: 0, y: 0 };
  o.x = ((world.x + 1) / 2) * canvas.clientWidth;
  o.y = ((1 - world.y) / 2) * canvas.clientHeight;
  return o;
}
