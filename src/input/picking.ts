import * as THREE from 'three';
import type { HeightField } from '../render/heightField';

const ndc = new THREE.Vector3();
const origin = new THREE.Vector3();
const dir = new THREE.Vector3();

/**
 * Analytic picking — no Raycaster. The camera ray, as a distance along it:
 * a y=0 plane hit refined against the height field (a few fixed-point steps
 * converge fast on gentle hills). Negative for a ray that never comes down
 * to the ground at all. The ray itself is left in `origin`/`dir`, which is
 * what screenToBuilding walks back up.
 */
function groundT(
  camera: THREE.Camera,
  canvas: HTMLCanvasElement,
  px: number,
  py: number,
  heights?: HeightField,
): number {
  ndc.set((px / canvas.clientWidth) * 2 - 1, -(py / canvas.clientHeight) * 2 + 1, -1);
  origin.copy(ndc).unproject(camera);
  ndc.z = 1;
  dir.copy(ndc).unproject(camera).sub(origin).normalize();
  if (Math.abs(dir.y) < 1e-6) return -1;
  let t = -origin.y / dir.y;
  if (t < 0) return -1;
  if (heights) {
    for (let i = 0; i < 4; i++) {
      const hx = origin.x + dir.x * t;
      const hz = origin.z + dir.z * t;
      t = (heights.at(hx, hz) - origin.y) / dir.y;
    }
  }
  return t;
}

/**
 * Where the camera ray meets the ground. Unit picking projects unit
 * positions to screen space instead.
 */
export function screenToGround(
  camera: THREE.Camera,
  canvas: HTMLCanvasElement,
  px: number,
  py: number,
  heights?: HeightField,
): { x: number; z: number } | null {
  const t = groundT(camera, canvas, px, py, heights);
  if (t < 0) return null;
  return { x: origin.x + dir.x * t, z: origin.z + dir.z * t };
}

/**
 * How tall the things standing on the map are drawn — the renderer's own
 * measurements, since only it has the models. Structural, so BuildingSync
 * satisfies it without the renderer having to know about picking.
 */
export interface BuildingHeights {
  /** How tall this building is drawn above its own base, in world units.
   * 0 for a building the renderer cannot measure, which reduces its pick to
   * the footprint it stands on. */
  heightOf(id: number): number;
  /** The elevation that base sits at. A building stands level on the ground
   * under its center, so on a slope its own footprint runs above it at one
   * end and below it at the other — which is why the walk below compares
   * absolute heights rather than heights over the ground beneath it. */
  baseOf(id: number): number;
  /**
   * The highest roofline standing, as an absolute elevation — where the walk
   * gives up, since nothing is drawn above it. Absolute rather than a height,
   * because the ground under a sample says nothing about how far the roof of
   * a building on a hillside reaches over it. -Infinity when nothing stands,
   * which reduces every pick to its ground hit.
   */
  ceiling(): number;
}

/** What screenToBuilding needs to know about what is standing where. */
export interface BuildingProbe extends BuildingHeights {
  /** Building occupying the tile under world (x, z), or -1 for bare ground. */
  idAt(x: number, z: number): number;
}

/**
 * Vertical spacing of the probes, in world units. Small enough that no
 * building is stepped clean over: at the rig's 35° pitch a step of this size
 * slides the sample ~0.36 tiles across the ground, and the smallest thing
 * that can be standing there is a whole tile wide.
 */
const PROBE_STEP = 0.25;

/**
 * A building's headroom, in world units. A roof tapers to a ridge and a
 * tower to a spire, so the topmost pixels of a model sit inside a box that
 * is a touch taller than the model — and a click a hair over the ridge is,
 * to the eye, a click on the building.
 */
const HEADROOM = 0.2;

/**
 * Probes one pick may take, however high the settlement's highest roof
 * stands over the ground being clicked, or however flatly the ray runs — a
 * backstop, not a working limit: on this map's relief the walk ends in a
 * castle's height in steps, give or take the hill it stands on.
 */
const MAX_PROBES = 64;

/**
 * The building under a screen point, or -1 — the footprint's whole box, not
 * just the plate it stands on. Clicking a castle's towers picks the castle,
 * where a ground hit alone would read through the model and land on
 * whatever tile lies behind it.
 *
 * The walk climbs the ray back toward the camera in world-height steps and
 * then tests top down, which is near-to-far: the first box it lands in is
 * the one nearest the camera, so a building never picks through one standing
 * in front of it. The ground hit itself is the last word and the old rule
 * unchanged — the tile you clicked, whatever is drawn over it.
 */
export function screenToBuilding(
  camera: THREE.Camera,
  canvas: HTMLCanvasElement,
  px: number,
  py: number,
  heights: HeightField,
  probe: BuildingProbe,
): number {
  const ground = groundT(camera, canvas, px, py, heights);
  if (ground < 0) return -1;
  // One PROBE_STEP of rise, as a distance back along the ray.
  const dt = PROBE_STEP / Math.abs(dir.y);
  const ceiling = probe.ceiling() + HEADROOM;
  // Climb until the ray is over every roof there is. The bar is an absolute
  // elevation, not a height over the ground below the sample: a footprint on
  // a hillside overhangs ground well under its own base, and measuring from
  // that ground would call the walk off while the ray was still inside the
  // building.
  let steps = 0;
  while (steps < MAX_PROBES) {
    const t = ground - (steps + 1) * dt;
    if (t < 0 || origin.y + dir.y * t > ceiling) break;
    steps++;
  }
  for (let i = steps; i > 0; i--) {
    const t = ground - i * dt;
    const x = origin.x + dir.x * t;
    const z = origin.z + dir.z * t;
    const id = probe.idAt(x, z);
    if (id >= 0 && origin.y + dir.y * t <= probe.baseOf(id) + probe.heightOf(id) + HEADROOM) {
      return id;
    }
  }
  return probe.idAt(origin.x + dir.x * ground, origin.z + dir.z * ground);
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
