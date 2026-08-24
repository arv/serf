import * as THREE from 'three';
import type { PieceFactory } from './assets';

/**
 * Whole buildings we model ourselves, for slots no KayKit pack has a model
 * of. Distinct from procParts.ts, which dresses a pack shell — everything
 * here *is* the shell.
 *
 * The rules a building here has to follow to stand next to the pack's own
 * without looking like a mod. Each one is measured off the pack, and each
 * was got wrong here first:
 *
 * - **Draw with the pack's texture, not with colours picked out of it.**
 *   `hexagons_medieval.png` looks like an 8x4 grid of flat swatches and is
 *   not: every cell is a nine-stop vertical gradient, and the pack rides it
 *   — 631 of building_home_A's 1011 triangles have UVs that *span* a ramp
 *   rather than sitting on one stop, so a soft light-to-dark falloff is
 *   baked into every wall, post and roof slope it draws. A building painted
 *   in flat per-colour materials cannot be made to match by choosing better
 *   hexes; it is the difference between a pack asset and a primitive. See
 *   applyRamps.
 * - **Spend area where the pack spends it.** Measured across the fourteen
 *   pack buildings: (0,6) timber 25-66% of surface, (0,2) masonry 15-90%,
 *   (3,3) team roof 3-28%, (0,1) plaster 4-20%, (0,3) slate 0.6-17%, (0,5)
 *   light timber 0.4-5.4%. Nothing else clears 2% on any of them. This file
 *   once spent 46% of its skin on cells no pack building opens at all.
 * - **Kay's proportion rule: eave height = roof half-span = roof rise**,
 *   with the roof at 45 degrees — 84-91% of every pack roof's area is at
 *   exactly 45. More than half a pack house's height is roof.
 * - **Big shapes, few of them, and a plan that is square.** A pack house
 *   runs 1.07-1.17 tall for its span on a near-square footprint; two masses
 *   side by side stretch the span and flatten both numbers.
 * - **Timber stands proud of a recessed infill** by about 0.04 of the span.
 *   Flush trim reads as a painted stripe.
 *
 * Everything is authored feet-on-zero, front to +z (the direction a
 * building faces — see Building.facing), in a space roughly one unit
 * across. `normalize` in assets.ts fits the result to the unit square, so
 * only the *proportions* here matter, not the absolute numbers.
 */

/**
 * Where on the atlas a surface is painted: which cell, and which slice of
 * that cell's ramp.
 *
 * `from` is the value the TOP of the element takes and `to` the value its
 * BOTTOM takes, as a fraction down the cell (0 = the cell's lightest row,
 * 1 = its darkest). Two masses read apart by taking different slices of the
 * SAME ramp — which is how the pack itself gets a light stone and a dark
 * stone out of one cell — rather than by reaching for a colour the pack
 * never uses.
 */
interface Paint {
  cell: [number, number];
  from?: number;
  to?: number;
}

/**
 * The pack's vocabulary, as cells and ramp slices rather than colours.
 *
 * Measured shares of surface area across the fourteen pack buildings: cell
 * (0,6) timber 25-66%, (0,2) masonry 15-90%, (3,3) team roof 3-28%, (0,1)
 * plaster 4-20%, (0,3) slate 0.6-17%, (0,5) light timber 0.4-5.4%. Nothing
 * else clears 2% anywhere. Cells (2,5), (3,5) and (3,6) — the warm creams
 * this file used to be built from — are spent by NO pack building at all.
 */
const KAY = {
  /** House masonry: the dark half of the grey ramp. */
  stone: { cell: [0, 2], from: 0.54, to: 0.92 },
  /** The corner footings, a step lighter so they read as separate stones. */
  stonePale: { cell: [0, 2], from: 0.4, to: 0.72 },
  /** The oven mass: the light half of the same ramp. It used to be a warm
   * limestone, which is what made it read as a different pack's asset —
   * the two masses have to part on value, not on hue. */
  oven: { cell: [0, 2], from: 0.3, to: 0.68 },
  /** Its copings, banding back into the dark half. */
  ovenDark: { cell: [0, 2], from: 0.6, to: 0.86 },
  slate: { cell: [0, 3], from: 0.3, to: 0.72 },
  /** The void behind an opening. */
  shadow: { cell: [0, 3], from: 0.55, to: 0.9 },
  /** The dominant timber. */
  timber: { cell: [0, 6], from: 0.22, to: 0.8 },
  /** The lighter timber, which the pack spends sparingly. */
  timberLight: { cell: [0, 5], from: 0.25, to: 0.7 },
  /** Plaster panels. */
  plaster: { cell: [0, 1], from: 0.3, to: 0.72 },
  /** The roof. Cell (3,3) is the slot splitTeamColorGroups repaints per
   * owner, and 0.34..0.86 is the slice home_A's own roof takes. */
  roof: { cell: [3, 3], from: 0.34, to: 0.86 },
  ember: { cell: [3, 4], from: 0.2, to: 0.6 },
  loaf: { cell: [1, 3], from: 0.2, to: 0.7 },
  flour: { cell: [1, 5], from: 0.2, to: 0.6 },
} as const satisfies Record<string, Paint>;

/**
 * The pack's own texture and material, handed in by assets.ts once the pack
 * is loaded. Every surface of a built building draws from it, so a built
 * building is the same draw as a loaded one.
 */
let atlas: THREE.Material | null = null;

function mesh(geo: THREE.BufferGeometry, paint: Paint): THREE.Mesh {
  const m = new THREE.Mesh(geo, atlas ?? new THREE.MeshStandardMaterial());
  m.userData.paint = paint;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** A box, positioned by its center. */
function box(
  g: THREE.Group,
  w: number,
  h: number,
  d: number,
  paint: Paint,
  x: number,
  y: number,
  z: number,
  rot?: { x?: number; y?: number; z?: number },
): THREE.Mesh {
  const m = mesh(new THREE.BoxGeometry(w, h, d), paint);
  m.position.set(x, y, z);
  if (rot) m.rotation.set(rot.x ?? 0, rot.y ?? 0, rot.z ?? 0);
  g.add(m);
  return m;
}

/**
 * Write every built surface's UVs into its atlas cell, ramped down world Y.
 *
 * This is the whole reason a hand-built building can sit beside Kay's. The
 * atlas is not a swatch grid of flat colours — every cell is a nine-stop
 * vertical gradient, and the pack uses it as one: 631 of home_A's 1011
 * triangles have UVs that *span* the ramp rather than sitting on one stop,
 * so a soft light-to-dark falloff is baked into every wall, post and roof
 * slope. A building painted in flat per-colour materials has none of that,
 * and no amount of picking the right hex fixes it — it is the difference
 * between a pack asset and a primitive.
 *
 * Ramping on world Y rather than on each mesh's own axes means rotated
 * pieces need no special case: a roof slope falls light at the ridge to
 * dark at the eave because that is what its world height does.
 */
function applyRamps(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const paint = o.userData.paint as Paint | undefined;
    if (!paint) return; // a pack piece, already carrying its own UVs
    const geo = o.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position');
    const ys = new Float32Array(pos.count);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      ys[i] = v.y;
      lo = Math.min(lo, v.y);
      hi = Math.max(hi, v.y);
    }
    const [row, col] = paint.cell;
    const from = paint.from ?? 0.28;
    const to = paint.to ?? 0.82;
    const span = hi - lo;
    const u = (col + 0.5) / 8;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      // A flat piece — a coping, a sill — has no height to ramp over and
      // takes the middle of its slice, which is what the pack does with the
      // same shapes.
      const t = span > 1e-4 ? (ys[i]! - lo) / span : 0.5;
      uv[i * 2] = u;
      uv[i * 2 + 1] = (row + from + (1 - t) * (to - from)) / 4;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  });
}

/**
 * A rectangular frustum: `wb`x`db` at the bottom, `wt`x`dt` at the top, `h`
 * tall, centered on the origin in x/z with its base on y=0.
 *
 * This is the shape the whole building leans on. A medieval stack is
 * *battered* — it leans in as it rises, so the mass looks like it is
 * carrying its own weight — and a stack of plain boxes does not read that
 * way at any zoom. Eight corners and twelve triangles, which is cheaper
 * than the box it replaces was going to be anyway.
 */
function frustumGeo(wb: number, db: number, wt: number, dt: number, h: number): THREE.BufferGeometry {
  const b = [wb / 2, db / 2];
  const t = [wt / 2, dt / 2];
  const v = [
    [-b[0]!, 0, b[1]!], [b[0]!, 0, b[1]!], [b[0]!, 0, -b[1]!], [-b[0]!, 0, -b[1]!],
    [-t[0]!, h, t[1]!], [t[0]!, h, t[1]!], [t[0]!, h, -t[1]!], [-t[0]!, h, -t[1]!],
  ];
  const faces = [
    [0, 1, 5, 4], // +z
    [1, 2, 6, 5], // +x
    [2, 3, 7, 6], // -z
    [3, 0, 4, 7], // -x
    [4, 5, 6, 7], // top
    [3, 2, 1, 0], // bottom
  ];
  const pos: number[] = [];
  for (const f of faces) {
    const [a, bb, c, d] = f as [number, number, number, number];
    for (const i of [a, bb, c, a, c, d]) pos.push(...(v[i] as number[]));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

/** The outline of a round-headed opening: `w` across, `legH` to the
 * springing, capped by a semicircle. */
function archPath(w: number, legH: number): THREE.Shape {
  const r = w / 2;
  const s = new THREE.Shape();
  s.moveTo(-r, 0);
  s.lineTo(-r, legH);
  s.absarc(0, legH, r, Math.PI, 0, true);
  s.lineTo(r, 0);
  s.closePath();
  return s;
}

/**
 * The ring of stone (or timber) around a round-headed opening: the
 * opening's outline with the opening itself punched out of it, extruded so
 * it stands proud of the wall. One piece, so the arch stays a true
 * half-round instead of a stack of little blocks pretending to be one.
 */
function surroundGeo(open: number, legH: number, band: number, depth: number): THREE.BufferGeometry {
  const ring = archPath(open + band * 2, legH);
  ring.holes.push(new THREE.Path(archPath(open, legH).getPoints(8)));
  return new THREE.ExtrudeGeometry(ring, { depth, bevelEnabled: false, curveSegments: 5 });
}

/** A triangular prism, for a gable end. */
function gableGeo(w: number, h: number, t: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(w / 2, 0);
  s.lineTo(0, h);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false });
  geo.translate(0, 0, -t / 2);
  return geo;
}

// --- The bakehouse ---------------------------------------------------------

/** House body: center, and half-extents. */
const HX = 0.14;
const HZ = -0.06;
const HW = 0.8;
const HD = 0.74;

/**
 * The datum the door sits on, the top of the stone course, the eave, the
 * ridge.
 *
 * The eave height is not a taste call. Measured off building_home_A, Kay
 * builds a house to one rule: **eave height = roof half-span = roof rise**,
 * all three the same number, with the roof at 45 degrees (84-91% of every
 * pack roof's area sits at exactly 45). That puts more than half a pack
 * house's height in its roof. This building used to carry an eave at 1.5x
 * its roof half-span — nearly two storeys of wall under a shallow-looking
 * cap — which is most of why its proportions read wrong beside the house.
 */
const SILL = 0.02;
const COURSE = 0.14;
const EAVE = 0.505;
const RIDGE = 1.01;
/** Roof oversail: 0.107 of the span on a pack house, against the 0.05 this
 * building used to have. A pack roof caps its walls; this one sat on them. */
const OVER = 0.105;

/** Half the roof's run. The ridge runs front-to-back (along z), so the
 * gable ends face +z and -z and the front one is the face the camera reads
 * — which is where the oven has to be. */
const SPAN = HW / 2 + OVER;
const RISE = RIDGE - EAVE;
const PITCH = Math.atan2(RISE, SPAN);
const SLOPE = Math.hypot(SPAN, RISE);

/**
 * The oven, as a chimney breast standing against the front gable rather
 * than as a second building beside it.
 *
 * Measured: with the oven alongside, the plan came out 1.28:1 and the whole
 * thing 0.87 high for its span, against a pack house's near-square plan and
 * 1.09-1.17. Sliding the mass onto the gable — where a chimney breast
 * belongs anyway — squares the plan and lifts the height in one move,
 * because the span it was stretching is the span everything else divides by.
 */
const OX = -0.37;
const OZ = 0.22;

/**
 * The bakehouse: a small timber-framed house under a team-colored gable,
 * with the oven built against its front corner as a battered limestone mass
 * that carries its own flue clear of the ridge — and the arch cut into the
 * foot of it, loaves showing on the hearthstone inside.
 *
 * Why we model this rather than dress a pack shell. The pack's blacksmith
 * *is* a domed stone oven with a flue, so any oven bolted onto a house
 * gives the village two buildings with one silhouette; and the only shells
 * nobody was using are two more houses and a market stall. Building it
 * settles both: the oven can be a third of the whole building instead of a
 * prop on its flank, and it can be the one thing on the street made of
 * warm limestone rather than the pack's cool grey.
 *
 * The arch is the tell and everything is arranged to protect it — it faces
 * +z, which is the way a building faces, it is the full height of the oven
 * mass, and the only saturated color on the building is the loaves sitting
 * in it.
 */
export function makeBakehouse(piece: PieceFactory, packMaterial: THREE.Material | null): THREE.Group {
  atlas = packMaterial;
  const g = new THREE.Group();
  house(g, piece);
  oven(g);
  applyRamps(g);
  return g;
}

function house(g: THREE.Group, piece: PieceFactory): void {

  // One footing block at each base corner, and nothing else on the wall.
  // Measured off building_home_A: 0.12 across and 0.08 tall once the model
  // is normalized — wide and low, sitting just proud of the plinth. A cube
  // of the same width is half again too tall and reads as a boulder parked
  // against the corner rather than as the stone the corner stands on. This is the pack's whole vocabulary for masonry on a house: its
  // walls carry no marks at all, and the corners carry one big stone that
  // stands proud on both faces. Scattering small stones across the course
  // instead reads as damage at village zoom, which is what the eye is
  // actually good at picking out.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      box(g, 0.15, 0.09, 0.15, KAY.stone, HX + sx * (HW / 2 - 0.06), 0.045, HZ + sz * (HD / 2 - 0.06));
    }
  }

  // Walls: stone to hip height, plaster above.
  // The stone course runs straight to the ground. It used to stand on an
  // oversailing plinth with a coping on it, which at this camera pitch read
  // as a thin flange skirting the building — the pack's house has no plinth
  // at all: its wall meets the grass and the corner blocks are the only
  // thing that projects.
  // The stone course used to oversail the timber frame above it, so the
  // plaster — and every window and door hung on it — sat in a recess behind
  // its own plinth and read as floating off the building. The wall has to
  // step OUTWARD as it comes forward: plaster innermost, stone a little
  // proud of it, timber proudest of all.
  box(g, HW - 0.055, COURSE, HD - 0.055, KAY.stonePale, HX, COURSE / 2, HZ);
  box(g, HW - 0.09, EAVE - COURSE, HD - 0.09, KAY.plaster, HX, (EAVE + COURSE) / 2, HZ);

  // Timber frame: corner posts, a sill rail on the stone, a top plate under
  // the eave. No braces — at this size they turned the plaster into noise.
  const midY = (EAVE + COURSE) / 2;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      box(g, 0.13, EAVE - COURSE, 0.13, KAY.timber, HX + sx * (HW / 2 - 0.065), midY, HZ + sz * (HD / 2 - 0.065));
    }
  }
  // An intermediate post in each face that has room for one. A pack wall is
  // divided into panels by its frame — measured on home_A the timber covers
  // about half the elevation, against a quarter here with corner posts
  // alone, which is why these walls read as painted boxes beside his.
  for (const sx of [-1, 1]) {
    box(g, 0.11, EAVE - COURSE, 0.11, KAY.timber, HX + sx * (HW / 2 - 0.055), midY, HZ - 0.04);
  }

  box(g, HW - 0.05, 0.08, HD - 0.05, KAY.timber, HX, COURSE + 0.032, HZ);
  box(g, HW - 0.04, 0.075, HD - 0.04, KAY.timber, HX, EAVE - 0.042, HZ);

  // Gable ends. The ridge runs along x, so these face front and back and
  // the front one is what the camera is looking at.
  for (const sz of [-1, 1]) {
    const tri = mesh(gableGeo(HW, RISE, 0.055), KAY.plaster);
    tri.position.set(HX, EAVE, HZ + sz * (HD / 2 - 0.028));
    g.add(tri);
  }
  for (const sz of [-1, 1]) {
    // A tie beam across the foot of the gable and a king post from it to the
    // apex — a truss, which is what the pack draws in a gable. The pair this
    // replaced sat halfway up the triangle spanning nothing, and read as a
    // brace someone had left leaning there.
    const zf = HZ + sz * (HD / 2 + 0.005);
    // The gable narrows as it rises, so the tie has to be cut to the width
    // of the triangle at the height it crosses — at a fifth of the rise the
    // triangle is 0.8 of the wall, and a tie any wider hangs out in the air
    // past the rake.
    box(g, HW * 0.72, 0.045, 0.032, KAY.timber, HX, EAVE + RISE * 0.2, zf);
    box(g, 0.05, RISE * 0.8, 0.032, KAY.timber, HX, EAVE + RISE * 0.6, zf);
  }

  // Roof: two slabs to a ridge, with the trim PARENTED to the slab it
  // edges. Hanging the boards in world space is what made the corners look
  // broken: each was positioned by its own arithmetic, so the bargeboards
  // floated a hair off the slope with daylight under them, the fascia
  // stopped short of the rake instead of meeting it, and the two rakes
  // crossed in mid-air at the ridge. As children they inherit the slope
  // exactly and cannot drift.
  const ROOF_D = HD + 2 * OVER;

  /**
   * Each slope is laid as three slabs rather than one, at slightly
   * different heights and lengths.
   *
   * Kay's roof is not a plane. Measured on home_A, each slope carries two
   * distinct normals — the main 45-degree face over 70% of it, plus a
   * shallower 41.4-degree section sitting 0.034 of the span proud of it —
   * so the surface kinks and the seams show as lines down the slope. That
   * is what makes a KayKit roof look laid rather than extruded, and a
   * single flat slab cannot have it at any size.
   */
  const STRIPS: { frac: number; dy: number; dlen: number }[] = [
    { frac: 0.36, dy: 0, dlen: 0 },
    { frac: 0.3, dy: 0.026, dlen: 0.035 },
    { frac: 0.34, dy: 0.009, dlen: -0.022 },
  ];

  for (const sx of [-1, 1]) {
    // The slope is a frame now, so the slabs and the boards on them all
    // inherit one rotation and cannot drift out of plane relative to
    // each other.
    const panel = new THREE.Group();
    panel.position.set(HX + (sx * SPAN) / 2, EAVE + RISE / 2, HZ);
    panel.rotation.z = -sx * PITCH;
    g.add(panel);

    let z = -ROOF_D / 2;
    for (const st of STRIPS) {
      const d = ROOF_D * st.frac;
      const slab = mesh(new THREE.BoxGeometry(SLOPE + st.dlen, 0.07, d), KAY.roof);
      slab.position.set((sx * st.dlen) / 2, st.dy, z + d / 2);
      panel.add(slab);
      z += d;
    }

    // A bargeboard down each rake, and NOTHING along the eave.
    //
    // This is the shape of the pack's own roof: Kay puts no board there at
    // all, his eave is the bare edge of the slab, and the only timber on
    // the slope runs down the two rakes. That leaves no eave corner to
    // join — which is why his corners read and three attempts at a tidy
    // one here did not.
    const BOARD = 0.075;
    const RIDGE_OVER = 0.02;
    for (const sz of [-1, 1]) {
      // Kay's rakes are uneven too — 0.135 of the span below the eave on
      // one, 0.017 on the other. Copying that ratio outright did not
      // survive here: one rake's plane lands within a hair of the oven's
      // front face, and the other faces a wall the camera sees broadside at
      // half its yaws, where a board that long reads as a plank leaning on
      // the house. Keep the unevenness, take a third of the length.
      const drop = (sz < 0 ? 0.05 : 0.017) * SPAN * 2;
      const eaveOver = drop * Math.SQRT2; // the roof is at 45 degrees
      const verge = mesh(
        new THREE.BoxGeometry(SLOPE + eaveOver + RIDGE_OVER, 0.12, BOARD),
        KAY.timber,
      );
      verge.position.set((sx * (eaveOver - RIDGE_OVER)) / 2, 0.025, sz * (ROOF_D / 2 + BOARD / 2));
      panel.add(verge);
    }
  }
  // The ridge, capping where the four rake boards come together.
  box(g, 0.11, 0.09, ROOF_D + 0.19, KAY.timber, HX, RIDGE + 0.035, HZ);

  // The door stays on the gable, which is where Kay puts his and the only
  // wall a 45-degree roof does not overhang. It had been jammed between the
  // oven and the corner post, running up into the wall plate as well — the
  // fix is the room the breast just gave up, not a smaller door.
  //
  // Measured off building_home_A: Kay's cut door is 0.410 of the span wide
  // and 0.369 tall, aspect 1.11, and its head reaches 93% of his eave. This
  // one lands at 0.30 of the span — under his ratio, because his gable
  // carries nothing else, but it now stands clear of the post by its own
  // width's worth of plaster and its head clears the plate.
  const dz = HZ + HD / 2;
  const dx = HX + 0.01;
  // It arrives face-on z=0 and stands a little proud of the wall plane,
  // because the leaf is recessed behind its own frame and has to clear the
  // sill rail that oversails the plaster it hangs on.
  // Sized to the wall, not to caution. Kay's door head reaches 93% of his
  // eave; 0.36 here put ours at 71% and it read like a hatch. 0.42 brings
  // the head to the underside of the wall plate — 83% of the eave, the most
  // this gable can take with a plate across it — with the case clearing the
  // breast on one side and the corner post on the other by a whisker each,
  // which is exactly how tight Kay hangs his.
  const door = piece('door', 0.42);
  if (door) {
    // Kay's door is a shallow relief cut off a FLAT wall: case, reveal and
    // leaf are all in the thickness of the piece. Hung out in front of a
    // recessed plaster panel it had daylight behind it and read as a
    // cutout, and patching that gap only hid the door. Seat its back on the
    // plaster instead — measured, not guessed — and it sits in the wall the
    // way it sits in his.
    door.position.set(dx, 0, dz);
    const bb = new THREE.Box3().setFromObject(door);
    door.position.z += HZ + (HD - 0.09) / 2 - bb.min.z;
    g.add(door);
  }
  // One low step.
  box(g, 0.36, 0.045, 0.12, KAY.ovenDark, dx, 0.022, dz + 0.075);

  // One shuttered window on the long side, which is the only face left with
  // nothing on it.
  // Openings on every face that is not the oven's. The two on the long
  // side, and one on the back — which was a blank panel from behind, and
  // the pack puts a window in every wall it draws.
  const wx = HX + HW / 2;
  for (const wz of [HZ - 0.19, HZ + 0.11]) window(g, wx, 0.24, wz, Math.PI / 2);
  window(g, HX, 0.24, HZ - HD / 2, Math.PI);
}

/** A round-headed window: a dark reveal set into the wall, a timber
 * surround proud of it, a sill under it. `turn` faces it out of its wall. */
function window(g: THREE.Group, x: number, y: number, z: number, turn: number): void {
  const holder = new THREE.Group();
  holder.position.set(x, y, z);
  holder.rotation.y = turn;
  g.add(holder);
  const win = mesh(
    new THREE.ExtrudeGeometry(archPath(0.14, 0.09), { depth: 0.06, bevelEnabled: false, curveSegments: 5 }),
    KAY.shadow,
  );
  win.position.set(0, 0, -0.055);
  holder.add(win);
  const frame = mesh(surroundGeo(0.14, 0.09, 0.035, 0.03), KAY.timber);
  frame.position.set(0, 0, -0.005);
  holder.add(frame);
  const sill = mesh(new THREE.BoxGeometry(0.24, 0.035, 0.04), KAY.ovenDark);
  sill.position.set(0, -0.015, 0.005);
  holder.add(sill);
}

function oven(g: THREE.Group): void {
  // Three stages, each battered and each stepped in from the one below, so
  // the mass tapers the whole way up and finishes above the house ridge.
  const stages: [number, number, number, number, number, number][] = [
    // wBottom, dBottom, wTop, dTop, height, base y
    [0.54, 0.44, 0.47, 0.38, 0.5, 0],
    [0.41, 0.35, 0.36, 0.3, 0.3, 0.5],
    [0.26, 0.22, 0.24, 0.2, 0.32, 0.8],
  ];
  for (const [wb, db, wt, dt, h, y0] of stages) {
    const m = mesh(frustumGeo(wb, db, wt, dt, h), KAY.oven);
    m.position.set(OX, y0, OZ);
    g.add(m);
  }
  // The same footings on the oven's two front corners, in the house's stone.
  for (const sx of [-1, 1]) {
    box(g, 0.13, 0.08, 0.13, KAY.stone, OX + sx * 0.25, 0.04, OZ + 0.17);
  }

  // Copings on the setbacks and a cap on top: what keeps stacked masses
  // reading as masonry instead of as a pile of blocks.
  box(g, 0.52, 0.03, 0.42, KAY.ovenDark, OX, 0.5, OZ);
  box(g, 0.4, 0.028, 0.33, KAY.ovenDark, OX, 0.8, OZ);
  box(g, 0.3, 0.038, 0.26, KAY.stonePale, OX, 1.12, OZ);
  box(g, 0.19, 0.045, 0.16, KAY.slate, OX, 1.162, OZ);

  // --- The arch. Everything above exists to hold this up.
  const zf = OZ + 0.21; // the front face of the bottom stage, near its foot
  const OPEN = 0.32;
  const LEG = 0.1;
  const BASE = 0.13;

  // Voussoirs: a ring of pale stone standing proud of the wall. Built as
  // the opening's outline with the opening punched out of it, so the ring
  // is one piece and the arch stays a true half-round.
  const surround = mesh(surroundGeo(OPEN, LEG, 0.06, 0.07), KAY.stonePale);
  surround.position.set(OX, BASE, zf);
  g.add(surround);

  // The oven chamber behind it, and the hearthstone across the floor of it.
  const voidGeo = new THREE.ExtrudeGeometry(archPath(OPEN, LEG), {
    depth: 0.2,
    bevelEnabled: false,
    curveSegments: 5,
  });
  const chamber = mesh(voidGeo, KAY.shadow);
  chamber.position.set(OX, BASE, zf - 0.24);
  g.add(chamber);
  // The hearthstone runs out through the mouth, so the baking sits in the
  // arch rather than behind it — at this camera pitch anything set back
  // inside the chamber is in shadow and might as well not be modelled.
  box(g, OPEN, 0.032, 0.16, KAY.oven, OX, BASE + 0.014, zf - 0.005);
  // The fire, banked to one side the way a baker keeps it.
  box(g, 0.1, 0.03, 0.06, KAY.ember, OX - 0.1, BASE + 0.045, zf - 0.03);

  // The day's baking, on the hearthstone. Three loaves is the whole point
  // of the building: the only saturated color on it, framed by the palest
  // stone on it, at the height the camera looks straight into.
  for (const [lx, lz] of [
    [-0.085, 0.005],
    [0.005, -0.04],
    [0.09, 0.01],
  ] as const) {
    const l = mesh(new THREE.SphereGeometry(0.045, 9, 5), KAY.loaf);
    l.scale.set(1.25, 0.66, 0.82);
    l.position.set(OX + lx, BASE + 0.055, zf + 0.02 + lz);
    l.rotation.y = lx * 5;
    g.add(l);
    const slash = mesh(new THREE.BoxGeometry(0.011, 0.01, 0.038), KAY.flour);
    slash.position.set(OX + lx, BASE + 0.085, zf + 0.02 + lz);
    slash.rotation.y = lx * 5;
    g.add(slash);
  }

  // Below the hearth: the ash door, and the apron the peel is worked across.
  box(g, 0.22, 0.09, 0.04, KAY.slate, OX, 0.07, zf + 0.035);
  box(g, 0.26, 0.03, 0.05, KAY.ovenDark, OX, 0.135, zf + 0.04);
  box(g, 0.44, 0.03, 0.15, KAY.stone, OX, 0.015, zf + 0.1);

}
