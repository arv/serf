import * as THREE from 'three';
import type {HeightField} from '../render/heightField';

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
  ndc.set(
    (px / canvas.clientWidth) * 2 - 1,
    -(py / canvas.clientHeight) * 2 + 1,
    -1,
  );
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
): {x: number; z: number} | null {
  const t = groundT(camera, canvas, px, py, heights);
  if (t < 0) return null;
  return {x: origin.x + dir.x * t, z: origin.z + dir.z * t};
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
  /**
   * How far along the ray this building is met *as it is drawn*, or -1
   * where the ray passes through its box and touches nothing — the pick's
   * narrow phase, and the whole of what keeps a click on the silhouette
   * rather than on the box around it. The ray is the one the walk below
   * runs: `origin` + `dir` * t, with dir a unit vector, so the answer is
   * directly comparable with the walk's own t.
   *
   * Optional. Without it a pick is the box hit it always was, which is
   * what a renderer-less probe (a test, or the boot before the scene is
   * wired in) answers with.
   */
  silhouetteT?(id: number, origin: THREE.Vector3, dir: THREE.Vector3): number;
  /**
   * A building drawn over this ground from off its own plot, or -1 — a
   * fishery's jetty runs a couple of tiles out over open water, and the
   * tiles it is drawn on belong to no building as far as the map is
   * concerned. The broad phase asks this beside idAt so that what a
   * building reaches out over gets a candidate at all.
   *
   * Optional, and offered with silhouetteT or not at all: a candidate
   * nothing can trace is a box hung over open water, which is the very
   * thing the silhouette is here to take away.
   */
  drawnAt?(x: number, z: number): number;
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
 * Every building the ray could possibly be meeting, nearest the camera
 * first — reused frame to frame, because a pick runs every time the
 * pointer moves. A handful at the very most: the buildings whose footprint
 * the ray crosses under their own roofline.
 */
const candidates: number[] = [];
/** Where each of those was first met, as a distance along the ray: the
 * probe that found its box, which is within a step of where the box really
 * begins. What lets the tracing below stop early. */
const entries: number[] = [];

/**
 * Take a building the walk has found over a probe, unless the ray is over
 * the top of it there, or it is already down.
 */
function consider(id: number, t: number, probe: BuildingProbe): void {
  if (id < 0) return;
  // Nothing is drawn above its own roofline, so a ray already over it is
  // past this building whatever else it meets.
  if (origin.y + dir.y * t > probe.baseOf(id) + probe.heightOf(id) + HEADROOM) {
    return;
  }
  // Consecutive probes land on the same building all the way up a wall,
  // and a ray can leave a footprint and come back to it over a courtyard.
  if (candidates.includes(id)) return;
  candidates.push(id);
  entries.push(t);
}

/**
 * The building under a screen point, or -1 — its silhouette where the
 * renderer can trace one, the footprint's whole box where it cannot.
 * Clicking a castle's towers picks the castle, where a ground hit alone
 * would read through the model and land on whatever tile lies behind it.
 *
 * Two phases, because the exact test is the expensive one. The broad phase
 * climbs the ray back toward the camera in world-height steps and collects
 * the boxes it passes through, near to far. The narrow phase then asks the
 * renderer where each of those buildings is actually *drawn* across the ray
 * and takes the nearest real hit — so the sky between a keep's towers
 * belongs to the cottage standing behind it, and the sky over a cottage's
 * ridge belongs to nobody. A probe with no silhouette to offer keeps the
 * old answer: the first box the walk landed in.
 *
 * The ground hit itself is the last word and the oldest rule unchanged —
 * the tile you clicked, whatever is drawn over it.
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
  candidates.length = 0;
  entries.length = 0;
  for (let i = steps; i > 0; i--) {
    const t = ground - i * dt;
    const x = origin.x + dir.x * t;
    const z = origin.z + dir.z * t;
    // What stands on this tile, and what is merely drawn over it from off
    // its own plot — a jetty, an eave. Both are asked at every probe: the
    // two can be different buildings over one patch of ground.
    consider(probe.idAt(x, z), t, probe);
    if (probe.drawnAt) consider(probe.drawnAt(x, z), t, probe);
  }
  if (candidates.length > 0) {
    if (!probe.silhouetteT) return candidates[0]!;
    // Box order is not model order: a keep's box is entered long before a
    // cottage's, and the keep is still the thing further along the ray
    // when the ray goes between its towers. So every candidate is traced
    // and the nearest real hit wins, rather than the first box.
    let best = -1;
    let bestT = Number.POSITIVE_INFINITY;
    for (let i = 0; i < candidates.length; i++) {
      // Tracing a model is the expensive half of a pick, so stop as soon as
      // the rest cannot win. A building is drawn only over ground the walk
      // counts as its own — its footprint and what drawnAt adds to it — so
      // a candidate cannot be met before the probe that turned it up, bar
      // the one step of sampling slack behind that probe. Everything left
      // was turned up later still.
      if (best >= 0 && bestT <= entries[i]! - dt) break;
      const id = candidates[i]!;
      const t = probe.silhouetteT(id, origin, dir);
      // Anything past the ground hit is inside the hill — a model's buried
      // skirt, or the underside of a shell the ray went in over the roof
      // of. The camera shows terrain at those pixels, so the pointer reads
      // terrain there too. A step of slack: the ground hit is a refined
      // guess, and a wall meets the ray a hair either side of the plate it
      // stands on.
      if (t < 0 || t > ground + dt) continue;
      if (t < bestT) {
        bestT = t;
        best = id;
      }
    }
    if (best >= 0) return best;
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
  out?: {x: number; y: number},
): {x: number; y: number} {
  world.set(x, y, z).project(camera);
  const o = out ?? {x: 0, y: 0};
  o.x = ((world.x + 1) / 2) * canvas.clientWidth;
  o.y = ((1 - world.y) / 2) * canvas.clientHeight;
  return o;
}
