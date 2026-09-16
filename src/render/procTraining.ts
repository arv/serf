import * as THREE from 'three';
import {lantern} from './palette';

/**
 * The training cue: lit windows, on the buildings that make soldiers.
 *
 * Why it exists. A village says what it is doing without being asked — the
 * mill's sails turn while it grinds, the bakehouse smokes while a batch is
 * on the fire, the fishery's shoal swims while a fisherman works it. The
 * three buildings that make SOLDIERS said nothing at all: a barracks with
 * four knights on the fire and a barracks standing cold were the same
 * building, and in a fight that is the one fact worth reading off an
 * opponent's village at a glance.
 *
 * Two cues, and deliberately no more. The windows below, and a smoke column
 * off the hall's own hearth — which is not here at all, because it is the
 * one buildingSync already stands over the bakery and the Smith; all this
 * side needs is the mark, and assets.ts measures that onto each roof.
 *
 * What was cut, and why it is worth writing down. The first version of this
 * put a brazier, a muster banner and a drill pell in the yard, all built
 * here out of flat Lambert primitives. procBuildings.ts opens with the
 * reason that cannot work — the pack paints every surface from a nine-stop
 * gradient atlas, and "a building painted in flat per-colour materials
 * cannot be made to match by choosing better hexes; it is the difference
 * between a pack asset and a primitive". It was, and they read as props
 * from another game standing in a KayKit yard. Anything added back here
 * goes through procBuildings' own paint (applyRamps and the KAY
 * vocabulary), or it does not go in.
 *
 * So what is left is the cue that adds no geometry of its own: the panes
 * are found in the model's existing openings and lit. It costs no
 * silhouette, and it is the only cue that works on a building seen end-on
 * with its yard hidden behind it. It is also the weakest at village zoom,
 * which the smoke column is there to cover.
 */

/**
 * A mesh that is light rather than matter: unlit, unshadowed, and starting
 * invisible. The level (see `setTrainingLevel`) is carried on its opacity.
 *
 * `depthWrite: false` because a pane sits a hair proud of the wall it
 * lights: writing depth would let it punch a hole in what is behind it.
 */
function glow(geo: THREE.BufferGeometry, color: number): THREE.Mesh {
  const m = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    }),
  );
  m.visible = false;
  return m;
}

// ——— Lit windows ———

/**
 * The atlas cell the packs paint the void behind an opening in — the dark
 * slate the window and door recesses of every KayKit building wear.
 * `[row, col]` of the 8x4 grid, in procBuildings' order.
 */
const VOID_CELL: [number, number] = [0, 3];

/** How far proud of the void the pane sits, in model units — enough to
 * clear it at every depth precision we draw at, small enough that the
 * recess still shades it from the side. */
const PANE_STANDOFF = 0.008;

/** How much of the void the pane covers. Short of all of it, so the frame
 * the pack modelled around the opening still reads as a frame. */
const PANE_FILL = 0.82;

/** Voids flatter than this in y are a roof or a floor, not a window. */
const PANE_MAX_TILT = 0.4;

/**
 * Find the window and door voids in a pack model and hang an unlit pane in
 * each one.
 *
 * Reads geometry rather than names because the pack models are one mesh
 * with nothing named inside them — but they are not unstructured: every
 * opening's backing quad is painted from one atlas cell (VOID_CELL), which
 * makes the windows of a building findable by their paint. That is what
 * this walks. Called BEFORE `normalize`, so it works in the model's own
 * units and is scaled into the template along with the walls.
 *
 * Returns null when a model has no openings at all, so a caller can tell
 * "no windows" from "no glow".
 */
export function makeWindowGlows(scene: THREE.Object3D): THREE.Group | null {
  const [vrow, vcol] = VOID_CELL;
  /** One opening, accumulated: its triangles' bounds and facing. */
  interface Void {
    box: THREE.Box3;
    normal: THREE.Vector3;
    n: number;
  }
  const voids: Void[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const mid = new THREE.Vector3();
  scene.updateWorldMatrix(true, true);
  scene.traverse(o => {
    if (!(o instanceof THREE.Mesh)) return;
    const geo = o.geometry as THREE.BufferGeometry;
    const index = geo.getIndex();
    const pos = geo.getAttribute('position');
    const uv = geo.getAttribute('uv');
    const nor = geo.getAttribute('normal');
    if (!index || !uv || !nor) return;
    const inVoid = (i: number): boolean =>
      Math.floor(uv.getY(i) * 4) === vrow &&
      Math.floor(uv.getX(i) * 8) === vcol;
    for (let i = 0; i < index.count; i += 3) {
      const i0 = index.getX(i);
      const i1 = index.getX(i + 1);
      const i2 = index.getX(i + 2);
      if (!inVoid(i0) || !inVoid(i1) || !inVoid(i2)) continue;
      a.fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(o.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(o.matrixWorld);
      nrm.fromBufferAttribute(nor, i0).transformDirection(o.matrixWorld);
      // A void's backing is a wall plate; anything lying flat is the dark
      // slate doing its other job, on a roof or under an eave.
      if (Math.abs(nrm.y) > PANE_MAX_TILT) continue;
      mid
        .copy(a)
        .add(b)
        .add(c)
        .multiplyScalar(1 / 3);
      // Openings are a wall apart; one loose threshold gathers a window's
      // own triangles and splits it from its neighbours. Facing is in it
      // too, so the two sides of a pierced wall stay two windows.
      const hit = voids.find(
        v =>
          v.normal.dot(nrm) > 0.9 &&
          Math.abs(v.box.getCenter(new THREE.Vector3()).x - mid.x) < 0.14 &&
          Math.abs(v.box.getCenter(new THREE.Vector3()).y - mid.y) < 0.22 &&
          Math.abs(v.box.getCenter(new THREE.Vector3()).z - mid.z) < 0.14,
      );
      if (hit) {
        hit.box.expandByPoint(a).expandByPoint(b).expandByPoint(c);
        hit.n++;
      } else {
        voids.push({
          box: new THREE.Box3().setFromPoints([
            a.clone(),
            b.clone(),
            c.clone(),
          ]),
          normal: nrm.clone(),
          n: 1,
        });
      }
    }
  });
  if (voids.length === 0) return null;

  const g = new THREE.Group();
  g.name = 'windowGlow';
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  for (let i = 0; i < voids.length; i++) {
    const v = voids[i]!;
    v.box.getSize(size);
    v.box.getCenter(center);
    // The pane spans the void across the wall and up it. Which of x and z
    // is "across" depends on which way the wall faces, and a wall at 30
    // degrees (the castle's towers) is neither — the hypotenuse of the two
    // is the width in every case, including the square ones.
    const w = Math.hypot(size.x, size.z) * PANE_FILL;
    const h = size.y * PANE_FILL;
    if (w < 1e-3 || h < 1e-3) continue;
    const pane = glow(new THREE.PlaneGeometry(w, h), lantern);
    pane.name = 'windowPane';
    pane.position.copy(center).addScaledVector(v.normal, PANE_STANDOFF);
    pane.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      v.normal.clone().normalize(),
    );
    // A per-window seed, so the panes breathe out of step: one lamp
    // guttering behind every window of a keep at once is a lighthouse.
    pane.userData.seed = (i * 0.618) % 1;
    g.add(pane);
  }
  return g.children.length > 0 ? g : null;
}

/**
 * The node this file hangs on a building that is NOT its wall.
 *
 * buildingSync marks a building's meshes as x-ray occluders — every
 * fragment stamps a stencil bit where it wins the depth test, and a unit
 * standing behind one gets an outline. The glow must never be marked: it is
 * light, not stone. It is drawn transparent and writes no depth, and a
 * marked pane would also have its material swapped for an occluder twin —
 * which is a material `setTrainingLevel` is then no longer setting the
 * opacity of. The cue would simply stop working.
 */
export const TRAINING_NODES: ReadonlySet<string> = new Set(['windowGlow']);

// ——— Driving it ———

/**
 * The lit panes of one building, harvested from its model once. Null on
 * every building that does not train, and on one whose model has no
 * openings at all.
 */
export interface TrainingRig {
  panes: THREE.Mesh[];
}

/** Harvest the cue off a built model, or null when it carries none. */
export function harvestTrainingRig(model: THREE.Object3D): TrainingRig | null {
  const panes: THREE.Mesh[] = [];
  model.traverse(o => {
    if (o.name === 'windowPane' && o instanceof THREE.Mesh) panes.push(o);
  });
  return panes.length > 0 ? {panes} : null;
}

/**
 * Clone every material the rig drives, so one building's windows are its
 * own.
 *
 * Built models share their template's materials — that is what makes a
 * village of forty huts one draw call's worth of state — and the level here
 * rides on opacity, which would otherwise be the same opacity for every
 * barracks on the map. Returns what was cloned, for disposal.
 */
export function ownTrainingMaterials(rig: TrainingRig): THREE.Material[] {
  const owned: THREE.Material[] = [];
  for (const pane of rig.panes) {
    const clone = (pane.material as THREE.Material).clone();
    pane.material = clone;
    owned.push(clone);
  }
  return owned;
}

/**
 * Put the rig at `level` (0 dark, 1 a course in full swing) at time `t`
 * seconds.
 *
 * The level is eased by the caller (buildingSync, the same way the chimney
 * smoke's is) and this is a pure read of it. `t` is a running clock, not a
 * delta — the flicker is periodic, so a building picked up mid-course
 * carries on from where the hall would be rather than restarting its beat.
 */
export function setTrainingLevel(
  rig: TrainingRig,
  level: number,
  t: number,
): void {
  const lit = level > 0.02;
  for (const pane of rig.panes) {
    pane.visible = lit;
    if (!lit) continue;
    const seed = (pane.userData.seed as number) ?? 0;
    // A lamp behind a shutter, not a strobe: the flicker rides high and
    // narrow, so what changes is the life in the light, not whether it is
    // on.
    const flicker = 0.88 + 0.12 * Math.sin(t * 3.1 + seed * 12.9);
    (pane.material as THREE.MeshBasicMaterial).opacity = level * flicker;
  }
}
