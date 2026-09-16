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
 * One cue, and it adds no geometry to the silhouette: the openings the pack
 * already modelled are found in the mesh and lit from inside. Each window
 * gets two surfaces —
 *
 *   pane   the opening itself, filled with warm light.
 *   spill  a soft halo lying ON the wall around it, additive, which is what
 *          makes it read as light rather than as a painted yellow rectangle.
 *          Light leaves a window and lands on the stone; a pane on its own
 *          does not, and looked like a sticker.
 *
 * Both are wall-aligned rather than camera-facing. A halo that turned to
 * face the camera would be a lamp hanging in the air in front of the
 * building; this one is the mark the lamp leaves on the masonry, and it
 * foreshortens with the wall it is on exactly as it should.
 *
 * Why not a real light. THREE's forward renderer would take a point light
 * per window — twenty-three on the castle alone, times every castle on the
 * map — and they would light the ground, the neighbours and each other.
 * This is the same trick a stylised renderer usually plays: paint the
 * result of the light instead of casting it.
 *
 * What was cut, and why it is worth writing down. The first version put a
 * brazier, a muster banner and a drill pell in the yard, built here out of
 * flat Lambert primitives. procBuildings.ts opens with the reason that
 * cannot work — the pack paints every surface from a nine-stop gradient
 * atlas, and "a building painted in flat per-colour materials cannot be
 * made to match by choosing better hexes; it is the difference between a
 * pack asset and a primitive". It was, and they read as props from another
 * game standing in a KayKit yard. The second version stood a smoke column
 * on each roof, which was worse in a quieter way: these models have no
 * chimney, so the column rose out of bare slate. Anything added back here
 * either comes off the model's own geometry, like the panes do, or goes
 * through procBuildings' own paint.
 */

/**
 * A mesh that is light rather than matter: unlit, unshadowed, and starting
 * invisible. The level (see `setTrainingLevel`) is carried on its opacity.
 *
 * `depthWrite: false` because these sit a hair proud of the wall they
 * light: writing depth would let one punch a hole in what is behind it.
 */
function glow(
  geo: THREE.BufferGeometry,
  color: number,
  map?: THREE.Texture,
  additive = false,
): THREE.Mesh {
  const m = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      color,
      map,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      // Additive over a dark wall is what makes the stone glow rather than
      // be painted over; the tone mapper carries the top end.
      toneMapped: true,
    }),
  );
  m.visible = false;
  return m;
}

/** How wide the spill is, as a multiple of the opening it leaves. */
const SPILL_SPREAD = 2.2;

/** And how strong, against the pane's own. */
const SPILL_STRENGTH = 0.8;

/**
 * The deepest a recess is allowed to be, in model units.
 *
 * The wall in front of an opening is the FURTHEST parallel surface that
 * overlaps it — the outermost course of the frame — and without a ceiling
 * on that, some windows found something else entirely: a balcony floor or
 * the tower in front of them, facing the same way and overlapping, at 0.3
 * and 0.44 and 0.7 out. Their spills were hung there, hanging in mid-air
 * beside the building, and that is what the bright slivers on the castle's
 * towers were. Measured recesses run 0.056 to 0.107 across the three
 * models, so anything past this is not a window's own wall.
 */
const WALL_MAX = 0.12;

/** The least a spill may be shrunk to, as a multiple of its window: even
 * an opening with no wall to speak of around it keeps a rim of light, or
 * the pane goes back to being a sticker. */
const SPILL_FLOOR = 1.15;

/** How far off a wall's plane a surface may sit and still count as that
 * wall, in model units. Wide enough to take the pack's own bevels, narrow
 * enough to reject the jamb of the next window along. */
const COPLANAR = 0.02;

/**
 * The two directions across a wall, given the way it faces: `u` along it and
 * `w` up it. Written into the vectors passed in.
 *
 * `up` crossed with the normal, except on a wall that faces up or down —
 * which no window does (PANE_MAX_TILT), so the degenerate case is a guard
 * rather than a branch anyone reaches.
 */
function tangents(
  normal: THREE.Vector3,
  u: THREE.Vector3,
  w: THREE.Vector3,
): void {
  u.set(0, 1, 0).cross(normal);
  if (u.lengthSq() < 1e-6) u.set(1, 0, 0);
  u.normalize();
  w.copy(normal).cross(u).normalize();
}

/** The spill's falloff texture, built on first need and shared by every
 * window in the game — it is one gradient, not a per-window one.
 *
 * A DataTexture rather than a canvas: this module is imported by tests and
 * by the bake page, neither of which has a DOM to draw a gradient in, and a
 * falloff is four lines of arithmetic anyway.
 */
let spillTexture: THREE.Texture | undefined;

function spillMap(): THREE.Texture {
  if (spillTexture) return spillTexture;
  const N = 64;
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      // Distance from the middle, 0 at the window and 1 at the rim.
      const dx = (x + 0.5) / N - 0.5;
      const dy = (y + 0.5) / N - 0.5;
      const d = Math.min(1, Math.hypot(dx, dy) * 2);
      // Squared falloff, which is roughly how light drops off and, more to
      // the point, keeps the halo from ending in a visible disc edge.
      const a = (1 - d) * (1 - d);
      const i = (y * N + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  spillTexture = tex;
  return tex;
}

// ——— Lit windows ———

/**
 * One paint a model backs its openings with: the atlas cell, as `[row,
 * col]` of the 8x4 grid (procBuildings' order), and optionally a model-space
 * floor below which that paint is NOT an opening.
 *
 * The floor exists because a cell is a colour, not a meaning. Cell (0,3) is
 * the dark slate every pack building's window and door recess wears, and
 * nothing else on the barracks or the castle is painted in it. The archery
 * range is the awkward one: its tower's upper window band is painted from
 * (1,6) instead, and so are the sides of the straw bales down in its
 * shooting lane. Six windows at model y 1.199, five bale faces at 0.222 —
 * so the range asks for (1,6) with a floor under it, and the bales stay
 * dark. Measured off the model; remeasure if it is ever swapped.
 */
export interface VoidPaint {
  cell: [row: number, col: number];
  minY?: number;
}

/** What a building's openings are painted in, when it says nothing else:
 * the dark slate recess every pack model uses. */
const DEFAULT_VOIDS: VoidPaint[] = [{cell: [0, 3]}];

/** How far proud of the void the pane sits, in model units — enough to
 * clear it at every depth precision we draw at, small enough that the
 * recess still shades it from the side. */
const PANE_STANDOFF = 0.008;

/**
 * How far proud of the WALL the spill sits, once the wall has been found.
 *
 * The spill cannot use the pane's standoff. An opening is recessed into the
 * masonry — about 0.06 of a model on the two pack buildings measured — and
 * the spill is wider than the opening it leaves, so hung off the void plate
 * its edges are inside the stone and the depth test eats them. That is
 * exactly what happened: twenty-six spills, all lit, none visible. So each
 * one is pushed out to its own wall's face (#wallOffset) and then this much
 * further.
 */
const SPILL_STANDOFF = 0.004;

/** What to assume a recess is, for a void whose wall cannot be found —
 * measured off the barracks and the castle, which agree to within a
 * hundredth. A spill a shade proud of the stone reads; one inside it does
 * not exist. */
const RECESS_FALLBACK = 0.066;

/** How much of the void the pane covers. Short of all of it, so the frame
 * the pack modelled around the opening still reads as a frame. */
const PANE_FILL = 0.82;

/** Voids flatter than this in y are a roof or a floor, not a window. */
const PANE_MAX_TILT = 0.4;

/**
 * Walk every triangle of a model, handing back its three corners and its
 * facing in the model's own space. Shared by the two passes that follow the
 * paint pass: finding the wall around each opening, and measuring how far
 * that wall runs before it ends.
 *
 * Corners rather than a centroid, which is what the first cut used and got
 * wrong: a pack wall is a handful of big quads, and the centroid of the
 * quad a window is cut into can sit halfway across the building from it. On
 * a centroid test those walls were never found at all, so the windows in
 * them kept an unclamped spill — the bright slivers hanging off the
 * castle's towers were exactly those.
 */
function eachTriangle(
  scene: THREE.Object3D,
  fn: (
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    normal: THREE.Vector3,
  ) => void,
): void {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  scene.traverse(o => {
    if (!(o instanceof THREE.Mesh)) return;
    const geo = o.geometry as THREE.BufferGeometry;
    const index = geo.getIndex();
    const pos = geo.getAttribute('position');
    const nor = geo.getAttribute('normal');
    if (!index || !nor) return;
    for (let i = 0; i < index.count; i += 3) {
      const i0 = index.getX(i);
      a.fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld);
      b.fromBufferAttribute(pos, index.getX(i + 1)).applyMatrix4(o.matrixWorld);
      c.fromBufferAttribute(pos, index.getX(i + 2)).applyMatrix4(o.matrixWorld);
      nrm.fromBufferAttribute(nor, i0).transformDirection(o.matrixWorld);
      fn(a, b, c, nrm);
    }
  });
}

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
export function makeWindowGlows(
  scene: THREE.Object3D,
  paints: readonly VoidPaint[] = DEFAULT_VOIDS,
): THREE.Group | null {
  /** One opening, accumulated: its triangles' bounds and facing. */
  interface Void {
    box: THREE.Box3;
    normal: THREE.Vector3;
    n: number;
    /** How far the masonry around it stands proud of its plate — filled by
     * the second pass below, 0 until then. */
    wall: number;
    /** How far that masonry then runs from the opening's own centre — left,
     * right, down and up, kept apart rather than as one number.
     *
     * A window is rarely in the middle of the face it is cut into, and a
     * single symmetric reach takes the generous side: the wall runs three
     * units to the right of it, so the spill is allowed three units to the
     * LEFT too, off the edge of the tower and into the air. Which is what
     * the last sliver on the castle turned out to be. Both sides are kept
     * and the spill takes the smaller.
     *
     * Filled by the second pass; 0 until then, read as "unknown", which
     * leaves the spill at its authored size. */
    reach: {left: number; right: number; down: number; up: number};
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
    /** Which paint this vertex wears, or null when it is not an opening's. */
    const paintOf = (i: number): VoidPaint | null => {
      const row = Math.floor(uv.getY(i) * 4);
      const col = Math.floor(uv.getX(i) * 8);
      return paints.find(p => p.cell[0] === row && p.cell[1] === col) ?? null;
    };
    for (let i = 0; i < index.count; i += 3) {
      const i0 = index.getX(i);
      const i1 = index.getX(i + 1);
      const i2 = index.getX(i + 2);
      const paint = paintOf(i0);
      if (!paint || paintOf(i1) !== paint || paintOf(i2) !== paint) continue;
      a.fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(o.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(o.matrixWorld);
      nrm.fromBufferAttribute(nor, i0).transformDirection(o.matrixWorld);
      // A void's backing is a wall plate; anything lying flat is the dark
      // slate doing its other job, on a roof or under an eave.
      if (Math.abs(nrm.y) > PANE_MAX_TILT) continue;
      // ...and anything below this paint's floor is not an opening at all
      // (see VoidPaint).
      if (paint.minY !== undefined) {
        const lowest = Math.min(a.y, b.y, c.y);
        if (lowest < paint.minY) continue;
      }
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
          wall: 0,
          reach: {left: 0, right: 0, down: 0, up: 0},
        });
      }
    }
  });
  if (voids.length === 0) return null;

  // Second pass: how far out of each void its own wall stands, and how far
  // that wall runs before it ends.
  //
  // The first is what the spill is hung off: an opening is recessed into the
  // masonry — about 0.066 of a model on the two pack buildings measured —
  // and a spill wider than the opening, hung off the void plate, has its
  // edges inside the stone where the depth test eats them.
  //
  // The second is what it is clamped to. A window near a corner would
  // otherwise hang its spill off the edge of the building, where nothing
  // occludes it, and it is seen side-on as a bright sliver floating beside
  // the silhouette — which is what the castle's towers did, a tower face
  // being barely wider than the window in it.
  //
  // Both come off the same walk. A triangle counts for a void when it faces
  // the way the void does, stands in front of it, and its own extent
  // overlaps the patch the spill will cover.
  const rel = new THREE.Vector3();
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  const u = new THREE.Vector3();
  const w2 = new THREE.Vector3();
  for (const pass of [0, 1]) {
    eachTriangle(scene, (ca, cb, cc, nrm2) => {
      for (const v of voids) {
        if (v.normal.dot(nrm2) < 0.9) continue;
        if (pass === 1 && v.wall <= 0) continue;
        v.box.getCenter(centre);
        v.box.getSize(size);
        tangents(v.normal, u, w2);
        // The triangle in this wall's own frame: how far in front of the
        // void it stands, and the span it covers across and up.
        let along = -Infinity;
        let uLo = Infinity;
        let uHi = -Infinity;
        let vLo = Infinity;
        let vHi = -Infinity;
        for (const corner of [ca, cb, cc]) {
          rel.copy(corner).sub(centre);
          along = Math.max(along, rel.dot(v.normal));
          const du = rel.dot(u);
          const dv = rel.dot(w2);
          uLo = Math.min(uLo, du);
          uHi = Math.max(uHi, du);
          vLo = Math.min(vLo, dv);
          vHi = Math.max(vHi, dv);
        }
        // Does the triangle cover any of the patch the spill will? Its own
        // SPAN against the patch, not the distance to its nearest corner,
        // which was the first cut and is wrong in the one case that
        // matters: a pack wall is a couple of big quads, and the quad a
        // window is cut into has all three of its corners far away from it.
        // Judged that way its wall was never found, and the window kept an
        // unclamped spill.
        const reachU = Math.hypot(size.x, size.z) * SPILL_SPREAD;
        const reachV = size.y * SPILL_SPREAD;
        if (uHi < -reachU || uLo > reachU) continue;
        if (vHi < -reachV || vLo > reachV) continue;
        if (pass === 0) {
          // In front of the plate, and near enough to be this window's own
          // wall rather than something across the yard (WALL_MAX).
          if (along <= 0 || along > WALL_MAX) continue;
          v.wall = Math.max(v.wall, along);
        } else {
          // Only the wall's own face, not the jamb behind it or a string
          // course in front.
          if (Math.abs(along - v.wall) > COPLANAR) continue;
          // How far the face reaches on each side — its own far corners,
          // not its middle.
          v.reach.left = Math.max(v.reach.left, -uLo);
          v.reach.right = Math.max(v.reach.right, uHi);
          v.reach.down = Math.max(v.reach.down, -vLo);
          v.reach.up = Math.max(v.reach.up, vHi);
        }
      }
    });
  }

  const g = new THREE.Group();
  g.name = 'windowGlow';
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
    const facing = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      v.normal.clone().normalize(),
    );
    // A per-window seed, so the windows breathe out of step: one lamp
    // guttering behind every window of a keep at once is a lighthouse.
    const seed = (i * 0.618) % 1;

    // The light landing on the stone, under the pane so the pane always
    // wins where they overlap. Sized off the opening, so a door spills
    // wider than an arrow slit without anything being told which is which.
    // Authored size, clamped to the masonry that is actually there to catch
    // the light, floored so every window keeps a rim of it. The narrow side
    // of the wall is what bounds it: light spilling past the edge of the
    // tower it is on has nothing to land on.
    const across = Math.min(v.reach.left, v.reach.right);
    const upright = Math.min(v.reach.down, v.reach.up);
    const spillW = Math.max(
      w * SPILL_FLOOR,
      Math.min(w * SPILL_SPREAD, across * 2),
    );
    const spillH = Math.max(
      h * SPILL_FLOOR,
      Math.min(h * SPILL_SPREAD, upright * 2),
    );
    const spill = glow(
      new THREE.PlaneGeometry(spillW, spillH),
      lantern,
      spillMap(),
      true,
    );
    spill.name = 'windowSpill';
    spill.position
      .copy(center)
      .addScaledVector(
        v.normal,
        (v.wall > 0 ? v.wall : RECESS_FALLBACK) + SPILL_STANDOFF,
      );
    spill.quaternion.copy(facing);
    spill.userData.seed = seed;
    g.add(spill);

    const pane = glow(new THREE.PlaneGeometry(w, h), lantern);
    pane.name = 'windowPane';
    pane.position.copy(center).addScaledVector(v.normal, PANE_STANDOFF);
    pane.quaternion.copy(facing);
    pane.userData.seed = seed;
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
  spills: THREE.Mesh[];
}

/** Harvest the cue off a built model, or null when it carries none. */
export function harvestTrainingRig(model: THREE.Object3D): TrainingRig | null {
  const panes: THREE.Mesh[] = [];
  const spills: THREE.Mesh[] = [];
  model.traverse(o => {
    if (!(o instanceof THREE.Mesh)) return;
    if (o.name === 'windowPane') panes.push(o);
    else if (o.name === 'windowSpill') spills.push(o);
  });
  return panes.length > 0 ? {panes, spills} : null;
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
  for (const lamp of [...rig.panes, ...rig.spills]) {
    const clone = (lamp.material as THREE.Material).clone();
    lamp.material = clone;
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
    (pane.material as THREE.MeshBasicMaterial).opacity =
      level * flicker(t, seed);
  }
  for (const spill of rig.spills) {
    spill.visible = lit;
    if (!lit) continue;
    const seed = (spill.userData.seed as number) ?? 0;
    // Held well under the pane's. The spill is the stone catching the
    // light, not a second lamp, and additive blending is generous: what
    // reads as a glow at a third reads as fog at one.
    (spill.material as THREE.MeshBasicMaterial).opacity =
      level * flicker(t, seed) * SPILL_STRENGTH;
  }
}

/**
 * One window's guttering: what is behind it is a fire or a tallow candle,
 * not a bulb.
 *
 * Four sines at frequencies with no common multiple, which is the cheapest
 * thing that does not read as a pattern: the beat between them never
 * repeats inside a match, so the light gutters, jumps and settles instead
 * of pulsing. The fast pair is the flame itself; the slow one is the draught
 * moving through the hall, which is what gives a candle its long dim
 * moments. Seeded per window, so no two lamps in a keep gutter together.
 *
 * Roughly 0.55..1: deep enough to be alive, never near out. A window that
 * actually went dark would read as the course stopping, which is the one
 * thing this whole cue is supposed to mean.
 */
function flicker(t: number, seed: number): number {
  const s = seed * 24.7;
  const f =
    0.78 +
    0.1 * Math.sin(t * 8.9 + s) +
    0.07 * Math.sin(t * 14.3 + s * 1.7) +
    0.05 * Math.sin(t * 23.1 + s * 2.9) +
    0.09 * Math.sin(t * 1.7 + s * 0.6);
  return Math.max(0.5, Math.min(1, f));
}
