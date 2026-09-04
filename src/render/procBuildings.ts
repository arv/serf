import * as THREE from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {hash2} from '../shared/math';
import type {PieceFactory} from './assets';

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
  /**
   * ROW then COL of the atlas' 8x4 grid — the opposite order to the
   * `col,row` strings PACK_PIECES uses in assets.ts. Two files talking
   * about the same grid in two orders is a swap waiting to happen, so the
   * tuple is labelled rather than left to the reader.
   */
  cell: [row: number, col: number];
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
  stone: {cell: [0, 2], from: 0.54, to: 0.92},
  /** Worked earth, for the farm's plot. (3,7) is off the buildings' own
   * six-cell diet, deliberately: a field is ground, not architecture, and
   * the pack's grounds — its dirt hexes — live on exactly these warm
   * taupes. */
  soil: {cell: [3, 7], from: 0.34, to: 0.72},
  /** The turned beds the rows stand in, a darker slice of the same earth. */
  soilDark: {cell: [3, 7], from: 0.58, to: 0.9},
  /** Standing wheat: the gold ramp the pack paints its grain in — light
   * heads over stalks falling into their own shadow. The loaves below
   * take the same cell, which is the joke of the bread chain. */
  wheat: {cell: [1, 3], from: 0.16, to: 0.78},
  /** Cut hay in the barn, straw-beige. */
  hay: {cell: [2, 3], from: 0.2, to: 0.65},
  /** Gilding: the bright top of the same gold ramp the wheat is painted
   * in, taken above the slice the grain takes so a gilded figure and a
   * standing crop cannot be confused for one material. Its own span is a
   * whole man, so the ramp reads as light gathering on the head and
   * shoulders and draining into the boots. */
  gilt: {cell: [1, 3], from: 0.3, to: 1.0},
  /** The corner footings, a step lighter so they read as separate stones. */
  stonePale: {cell: [0, 2], from: 0.4, to: 0.72},
  /** The oven mass: the light half of the same ramp. It used to be a warm
   * limestone, which is what made it read as a different pack's asset —
   * the two masses have to part on value, not on hue. */
  oven: {cell: [0, 2], from: 0.3, to: 0.68},
  /** Its copings, banding back into the dark half. */
  ovenDark: {cell: [0, 2], from: 0.6, to: 0.86},
  slate: {cell: [0, 3], from: 0.3, to: 0.72},
  /** The void behind an opening. */
  shadow: {cell: [0, 3], from: 0.55, to: 0.9},
  /** The dominant timber. */
  timber: {cell: [0, 6], from: 0.22, to: 0.8},
  /** The lighter timber, which the pack spends sparingly. */
  timberLight: {cell: [0, 5], from: 0.25, to: 0.7},
  /** Plaster panels. */
  plaster: {cell: [0, 1], from: 0.3, to: 0.72},
  /** The roof. Cell (3,3) is the slot splitTeamColorGroups repaints per
   * owner, and 0.34..0.86 is the slice home_A's own roof takes. */
  roof: {cell: [3, 3], from: 0.34, to: 0.86},
  ember: {cell: [3, 4], from: 0.2, to: 0.6},
  loaf: {cell: [1, 3], from: 0.2, to: 0.7},
  flour: {cell: [1, 5], from: 0.2, to: 0.6},
} as const satisfies Record<string, Paint>;

/**
 * The pack's own texture and material, handed in by assets.ts once the pack
 * is loaded. Every surface of a built building draws from it, so a built
 * building is the same draw as a loaded one.
 */
let atlas: THREE.Material | null = null;

/**
 * What a surface draws with if the pack never loaded. One instance for the
 * whole building, like the atlas material it stands in for — building it
 * per mesh would spend sixty materials on a path that only runs when the
 * models are already missing. It is untextured, so the building comes out
 * flat white; that is the honest look for "the pack is not here", and
 * loadGlbAssets turns a real failure into a visible error anyway.
 */
const fallback = new THREE.MeshStandardMaterial({metalness: 0, roughness: 0.5});

function mesh(geo: THREE.BufferGeometry, paint: Paint): THREE.Mesh {
  const m = new THREE.Mesh(geo, atlas ?? fallback);
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
  rot?: {x?: number; y?: number; z?: number},
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
  root.traverse(o => {
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
function frustumGeo(
  wb: number,
  db: number,
  wt: number,
  dt: number,
  h: number,
): THREE.BufferGeometry {
  const b = [wb / 2, db / 2];
  const t = [wt / 2, dt / 2];
  const v = [
    [-b[0]!, 0, b[1]!],
    [b[0]!, 0, b[1]!],
    [b[0]!, 0, -b[1]!],
    [-b[0]!, 0, -b[1]!],
    [-t[0]!, h, t[1]!],
    [t[0]!, h, t[1]!],
    [t[0]!, h, -t[1]!],
    [-t[0]!, h, -t[1]!],
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
function surroundGeo(
  open: number,
  legH: number,
  band: number,
  depth: number,
): THREE.BufferGeometry {
  const ring = archPath(open + band * 2, legH);
  ring.holes.push(new THREE.Path(archPath(open, legH).getPoints(8)));
  return new THREE.ExtrudeGeometry(ring, {
    depth,
    bevelEnabled: false,
    curveSegments: 5,
  });
}

/** A triangular prism, for a gable end. */
function gableGeo(w: number, h: number, t: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(w / 2, 0);
  s.lineTo(0, h);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, {depth: t, bevelEnabled: false});
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
 * with the oven built against that gable as a battered chimney breast that
 * carries its flue clear of the ridge — and the arch cut into the foot of
 * it, loaves showing on the hearthstone inside.
 *
 * Why we model this rather than dress a pack shell. The pack's blacksmith
 * *is* a domed stone oven with a flue, so any oven bolted onto a house
 * gives the village two buildings with one silhouette; and the only shells
 * nobody was using are two more houses and a market stall. Building it
 * lets the oven be a third of the whole building instead of a prop on its
 * flank. It does NOT license a material of its own: the oven is masonry
 * from the same cool grey ramp as the walls, a lighter slice of it, because
 * a warm stone here was exactly what made the building read as another
 * pack's asset.
 *
 * The arch is the tell and everything is arranged to protect it — it faces
 * +z, which is the way a building faces, it is the full height of the oven
 * mass, and the only saturated color on the building is the loaves sitting
 * in it.
 */
export function makeBakehouse(
  piece: PieceFactory,
  packMaterial: THREE.Material | null,
): THREE.Group {
  atlas = packMaterial;
  const g = new THREE.Group();
  house(g, piece);
  oven(g);
  applyRamps(g);
  return g;
}

function house(g: THREE.Group, piece: PieceFactory): void {
  // One footing block at each base corner, and nothing else on the wall.
  //
  // That is the pack's whole vocabulary for masonry on a house: its walls
  // carry no marks at all, and each corner carries one big stone standing
  // proud on both faces. Scattering small stones across the course instead
  // reads as damage at village zoom, which is what the eye is best at
  // picking out.
  //
  // Measured off building_home_A: 0.12 across and 0.08 tall once the model
  // is normalized — wide and low, sitting just proud of the plinth. A cube
  // of the same width is half again too tall, and reads as a boulder parked
  // against the corner rather than as the stone the corner stands on.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      box(
        g,
        0.15,
        0.09,
        0.15,
        KAY.stone,
        HX + sx * (HW / 2 - 0.06),
        0.045,
        HZ + sz * (HD / 2 - 0.06),
      );
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
  box(
    g,
    HW - 0.09,
    EAVE - COURSE,
    HD - 0.09,
    KAY.plaster,
    HX,
    (EAVE + COURSE) / 2,
    HZ,
  );

  // Timber frame: corner posts, a sill rail on the stone, a top plate under
  // the eave. No braces — at this size they turned the plaster into noise.
  const midY = (EAVE + COURSE) / 2;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      box(
        g,
        0.13,
        EAVE - COURSE,
        0.13,
        KAY.timber,
        HX + sx * (HW / 2 - 0.065),
        midY,
        HZ + sz * (HD / 2 - 0.065),
      );
    }
  }
  // An intermediate post in each face that has room for one. A pack wall is
  // divided into panels by its frame — measured on home_A the timber covers
  // about half the elevation, against a quarter here with corner posts
  // alone, which is why these walls read as painted boxes beside his.
  for (const sx of [-1, 1]) {
    box(
      g,
      0.11,
      EAVE - COURSE,
      0.11,
      KAY.timber,
      HX + sx * (HW / 2 - 0.055),
      midY,
      HZ - 0.04,
    );
  }

  box(g, HW - 0.05, 0.08, HD - 0.05, KAY.timber, HX, COURSE + 0.032, HZ);
  box(g, HW - 0.04, 0.075, HD - 0.04, KAY.timber, HX, EAVE - 0.042, HZ);

  // Gable ends. The ridge runs along z, so these face front and back and
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

  // Roof: two slopes to a ridge, each laid as several slabs, with every
  // slab and board PARENTED to the slope it belongs to. Positioning the
  // pieces in world space is what made the corners look broken — each was
  // placed by its own arithmetic, so boards floated a hair off the slope
  // with daylight under them. As children they inherit one rotation and
  // cannot drift relative to each other.
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
  const STRIPS: {frac: number; dy: number; dlen: number}[] = [
    {frac: 0.36, dy: 0, dlen: 0},
    {frac: 0.3, dy: 0.026, dlen: 0.035},
    {frac: 0.34, dy: 0.009, dlen: -0.022},
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
      const slab = mesh(
        new THREE.BoxGeometry(SLOPE + st.dlen, 0.07, d),
        KAY.roof,
      );
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
      verge.position.set(
        (sx * (eaveOver - RIDGE_OVER)) / 2,
        0.025,
        sz * (ROOF_D / 2 + BOARD / 2),
      );
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
function window(
  g: THREE.Group,
  x: number,
  y: number,
  z: number,
  turn: number,
): void {
  const holder = new THREE.Group();
  holder.position.set(x, y, z);
  holder.rotation.y = turn;
  g.add(holder);
  const win = mesh(
    new THREE.ExtrudeGeometry(archPath(0.14, 0.09), {
      depth: 0.06,
      bevelEnabled: false,
      curveSegments: 5,
    }),
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

  // The flue's mouth, as a named empty on the cap — buildingSync stands a
  // smoke column on it while the oven works, the way the mill's sails hang
  // off 'millFan'. The Smith's pack model carries the same mark (assets.ts
  // adds it at load). An empty, not a mesh: it must survive normalize and
  // the team-color split untouched and add nothing to the model's bounds.
  const flue = new THREE.Group();
  flue.name = 'smokeFlue';
  flue.position.set(OX, 1.185, OZ);
  g.add(flue);

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

// --- The farmstead ---------------------------------------------------------

/**
 * The wheat farm: an open field the resident actually mows.
 *
 * It replaced the pack's farm_plot.glb, which was one waist-high slab of
 * wheat filling the whole footprint — scenery a farmer could only stand
 * beside. This is the same plot turned into a place of work: a soil pad,
 * five raised rows of standing wheat with lanes wide enough to walk, a
 * post-and-rail fence that leaves the front open, and a low open-fronted
 * hay barn in the back corner wearing the team color on its roof. The
 * field is most of the composition on purpose — the field is what says
 * farm; the barn only has to say building.
 *
 * The lanes are load-bearing: sceneSync walks the farmer along them,
 * scythe swinging, while a batch runs. Where he walks is authored HERE,
 * as named empties ('mowGate', 'mowPath0'..N in visiting order), and
 * buildingSync measures their world positions once the building stands —
 * so the circuit can never drift from the rows the way a table of
 * coordinates in another file would.
 */

/** Pad: the worked plot, a hair inside the unit square. */
const PAD_TOP = 0.02;
/** Barn body: center and extents, back-west corner of the plot. Sized a
 * head under a house on purpose — the field is the farm; the barn only
 * has to say building (and carry the team roof). The ridge runs along z,
 * so the open bay is a gable end presented to the field and the camera
 * reads gable-plus-slope the way it reads every pack house, instead of
 * one whole slope face-on (which read as a leaning sign). */
const BNX = -0.28;
const BNZ = -0.33;
const BNW = 0.34;
const BND = 0.3;
const BN_EAVE = 0.17;
const BN_SPAN = BNW / 2 + 0.035; // roof half-span, Kay's 45 degrees
const BN_RISE = BN_SPAN;
const BN_SLOPE = Math.hypot(BN_SPAN, BN_RISE);

/** Front-field wheat rows (z), and the pair tucked back-east. */
const ROWS_FRONT = [-0.04, 0.12, 0.28];
const ROWS_BACK = [-0.22, -0.38];
/** Row extents along x. */
const ROW_X0 = -0.34;
const ROW_X1 = 0.34;
const BACK_X0 = 0.04;
const BACK_X1 = 0.34;

/**
 * The mowing circuit: one lane on the walker's side of each front row,
 * serpentine, turning on the headlands just past the row ends. Visited in
 * order and then walked back (sceneSync ping-pongs it). The last lane
 * runs the front of the barn, so the round ends at the door he'd carry
 * the sheaves through.
 *
 * The turns sit a clear step INSIDE the flank fences (rails at 0.475),
 * not against them: at 0.44 the farmer stood into the fence at every
 * turn, hat through the rail. The rows give up the same margin, so the
 * headland he turns on stays a walked strip and not a hedge.
 */
const MOW_LANES = [0.36, 0.2, 0.04, -0.12];
const MOW_TURN_X = 0.38;

export function makeFarmstead(
  _piece: PieceFactory,
  packMaterial: THREE.Material | null,
): THREE.Group {
  atlas = packMaterial;
  const g = new THREE.Group();
  field(g);
  barn(g);
  fences(g);
  marks(g);
  applyRamps(g);
  return g;
}

/** The plot, its beds, and the standing wheat. */
function field(g: THREE.Group): void {
  // The pad leans in as it rises like every pack mass, one finger high:
  // a worked plot sits IN the grass, not on a plinth.
  const pad = mesh(frustumGeo(1.0, 1.0, 0.965, 0.965, PAD_TOP), KAY.soil);
  g.add(pad);

  // A turned bed under each row, darker earth standing off the pad.
  const beds: THREE.BufferGeometry[] = [];
  const bed = (x0: number, x1: number, z: number): void => {
    const geo = new THREE.BoxGeometry(x1 - x0 + 0.06, 0.016, 0.11);
    geo.translate((x0 + x1) / 2, PAD_TOP + 0.008, z);
    beds.push(geo);
  };
  for (const z of ROWS_FRONT) bed(ROW_X0, ROW_X1, z);
  for (const z of ROWS_BACK) bed(BACK_X0, BACK_X1, z);
  g.add(mesh(mergeGeometries(beds), KAY.soilDark));

  // Standing wheat, in the pack's own grain language: Kay's grain tile
  // (Medieval Hexagon building_grain) is one continuous slab of gold
  // with a ragged, chipped rim, its flat top broken by a few taller
  // tufts, over a visible band of earth. Each row here is that tile in
  // miniature: overlapping frustums close ranks into one running slab —
  // the height barely wavers, the SIDES do (per-clump depth jitter is
  // what chips the rim) — and sparse thin nubs stand proud of the top
  // the way his do. Merged to one mesh: a field is one draw, not sixty.
  // Knee-high on the villager; the ramp falls the gold into its own base
  // shadow, so a man in the lane beside it reads as IN the crop.
  const tufts: THREE.BufferGeometry[] = [];
  let n = 0;
  const row = (x0: number, x1: number, z: number): void => {
    const COUNT = Math.round((x1 - x0) / 0.095);
    const pitch = (x1 - x0) / COUNT;
    for (let i = 0; i < COUNT; i++) {
      n++;
      const h = 0.075 + hash2(n, 29) * 0.012;
      // Overlapped into one slab: only the chipped flanks say where one
      // clump ends, never the crowns.
      const w = pitch * 1.12;
      const d = 0.062 + hash2(n, 41) * 0.026;
      const geo = frustumGeo(w * 0.66, d * 0.62, w, d, h);
      geo.rotateY((hash2(n, 31) - 0.5) * 0.1);
      geo.translate(
        x0 + pitch * (i + 0.5),
        PAD_TOP + 0.012,
        z + (hash2(n, 37) - 0.5) * 0.014,
      );
      tufts.push(geo);
      // Kay's tell: every few paces a taller tuft breaks the slab's top.
      if (hash2(n, 43) < 0.3) {
        const nub = new THREE.BoxGeometry(0.022, 0.05, 0.022).toNonIndexed();
        // The frustums carry no uv (applyRamps writes them); a merge of
        // mismatched attribute sets returns nothing at all.
        nub.deleteAttribute('uv');
        nub.translate(
          x0 + pitch * (i + 0.5) + (hash2(n, 47) - 0.5) * pitch * 0.5,
          PAD_TOP + 0.012 + h,
          z + (hash2(n, 53) - 0.5) * 0.05,
        );
        tufts.push(nub);
      }
    }
  };
  for (const z of ROWS_FRONT) row(ROW_X0, ROW_X1, z);
  for (const z of ROWS_BACK) row(BACK_X0, BACK_X1, z);
  g.add(mesh(mergeGeometries(tufts), KAY.wheat));
}

/**
 * The hay barn: an open-fronted timber shelter — plank walls down the
 * flanks and across the back, the front a bay standing open under its
 * gable with the cut hay showing inside, under a team-colored roof at
 * Kay's 45 degrees. Low on purpose: a barn is the field's outbuilding,
 * not a second house.
 */
function barn(g: THREE.Group): void {
  // Corner posts carry the roof; the walls hang between them.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      box(
        g,
        0.06,
        BN_EAVE,
        0.06,
        KAY.timber,
        BNX + sx * (BNW / 2 - 0.03),
        PAD_TOP + BN_EAVE / 2,
        BNZ + sz * (BND / 2 - 0.03),
      );
    }
  }
  // Plank walls under the flank eaves and across the back, to the wall
  // plate; the front bay stays open — the hay inside is the story, and a
  // shut box would be a shed.
  const WALL_H = BN_EAVE - 0.03;
  box(
    g,
    BNW - 0.09,
    WALL_H,
    0.035,
    KAY.timber,
    BNX,
    PAD_TOP + WALL_H / 2,
    BNZ - BND / 2 + 0.028,
  );
  for (const sx of [-1, 1]) {
    box(
      g,
      0.035,
      WALL_H,
      BND - 0.09,
      KAY.timber,
      BNX + sx * (BNW / 2 - 0.028),
      PAD_TOP + WALL_H / 2,
      BNZ,
    );
  }

  // The winter's hay, mounded out of the bay's shadow into the light.
  const hayA = mesh(new THREE.BoxGeometry(0.16, 0.105, 0.13), KAY.hay);
  hayA.position.set(BNX - 0.04, PAD_TOP + 0.052, BNZ + 0.01);
  hayA.rotation.y = 0.18;
  const hayB = mesh(new THREE.BoxGeometry(0.12, 0.07, 0.1), KAY.hay);
  hayB.position.set(BNX + 0.08, PAD_TOP + 0.035, BNZ + 0.06);
  hayB.rotation.y = -0.3;
  g.add(hayA, hayB);

  // Gable ends over the eave line, plank like the walls (a plastered
  // gable would out-dress the field it stands in). The front one crowns
  // the open bay, and a tie beam runs under it post to post — without
  // the beam the triangle floated on air and the bay read as a gap in
  // the building rather than a doorway through it.
  for (const sz of [-1, 1]) {
    const tri = mesh(gableGeo(BNW, BN_RISE, 0.04), KAY.timber);
    tri.position.set(BNX, PAD_TOP + BN_EAVE, BNZ + sz * (BND / 2 - 0.02));
    g.add(tri);
  }
  box(
    g,
    BNW - 0.02,
    0.045,
    0.045,
    KAY.timber,
    BNX,
    PAD_TOP + BN_EAVE - 0.022,
    BNZ + BND / 2 - 0.03,
  );

  // The roof: each slope laid as three strips at slightly different
  // heights and lengths — the bakehouse's own treatment, at barn scale.
  // It started as one slab per slope ("a barn earns no kinked strips")
  // and read as exactly what that is: a flat green board leaning on
  // posts. Kay's roofs are never a plane (see the STRIPS note over the
  // bakehouse), and the kinked seams are what make this one read as laid
  // too. Rake boards down the gable edges, a ridge beam capping the
  // pair. Cell (3,3) — the team slot — so a rival's farm reads at a
  // glance.
  const ROOF_D = BND + 0.08;
  const STRIPS: {frac: number; dy: number; dlen: number}[] = [
    {frac: 0.36, dy: 0, dlen: 0},
    {frac: 0.3, dy: 0.014, dlen: 0.02},
    {frac: 0.34, dy: 0.005, dlen: -0.012},
  ];
  for (const sx of [-1, 1]) {
    const panel = new THREE.Group();
    panel.position.set(
      BNX + (sx * BN_SPAN) / 2,
      PAD_TOP + BN_EAVE + BN_RISE / 2,
      BNZ,
    );
    panel.rotation.z = -sx * (Math.PI / 4);
    g.add(panel);
    let z = -ROOF_D / 2;
    for (const st of STRIPS) {
      const d = ROOF_D * st.frac;
      const slab = mesh(
        new THREE.BoxGeometry(BN_SLOPE + st.dlen, 0.035, d),
        KAY.roof,
      );
      slab.position.set((sx * st.dlen) / 2, st.dy, z + d / 2);
      panel.add(slab);
      z += d;
    }
    for (const sz of [-1, 1]) {
      const verge = mesh(
        new THREE.BoxGeometry(BN_SLOPE + 0.04, 0.05, 0.034),
        KAY.timber,
      );
      verge.position.set(sx * 0.008, 0.01, sz * (ROOF_D / 2 + 0.014));
      panel.add(verge);
    }
  }
  box(
    g,
    0.065,
    0.05,
    ROOF_D + 0.05,
    KAY.timber,
    BNX,
    PAD_TOP + BN_EAVE + BN_RISE + 0.016,
    BNZ,
  );
}

/**
 * Post-and-rail along the flanks and the back, merged to two meshes. The
 * front edge carries no fence at all: it is the working edge — the gate
 * mark stands in the middle of it, the stock piles land on it, and the
 * farmer walks in over it.
 */
function fences(g: THREE.Group): void {
  const posts: THREE.BufferGeometry[] = [];
  const rails: THREE.BufferGeometry[] = [];
  const run = (x0: number, z0: number, x1: number, z1: number): void => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const segs = Math.max(1, Math.round(len / 0.155));
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const p = new THREE.BoxGeometry(0.03, 0.135, 0.03);
      p.translate(x0 + (x1 - x0) * t, PAD_TOP + 0.0675, z0 + (z1 - z0) * t);
      posts.push(p);
    }
    const r = new THREE.BoxGeometry(len, 0.028, 0.022);
    r.rotateY(-Math.atan2(z1 - z0, x1 - x0));
    r.translate((x0 + x1) / 2, PAD_TOP + 0.112, (z0 + z1) / 2);
    rails.push(r);
  };
  for (const sx of [-1, 1]) run(sx * 0.475, -0.46, sx * 0.475, 0.46);
  // Back edge only east of the barn — its own wall holds the west end.
  run(-0.09, -0.475, 0.46, -0.475);
  g.add(mesh(mergeGeometries(posts), KAY.timber));
  g.add(mesh(mergeGeometries(rails), KAY.timberLight));
}

/** The walk's waypoints: empties buildingSync finds by name. */
function marks(g: THREE.Group): void {
  const mark = (name: string, x: number, z: number): void => {
    const m = new THREE.Group();
    m.name = name;
    m.position.set(x, PAD_TOP, z);
    g.add(m);
  };
  mark('mowGate', 0, 0.5);
  let i = 0;
  for (const [li, z] of MOW_LANES.entries()) {
    // Serpentine: even lanes run west-to-east, odd ones back.
    const xs =
      li % 2 === 0 ? [-MOW_TURN_X, MOW_TURN_X] : [MOW_TURN_X, -MOW_TURN_X];
    for (const x of xs) mark(`mowPath${i++}`, x, z);
  }
}

// --- The monument -------------------------------------------------------

/**
 * Heights of the pedestal's courses, bottom to top, in the authored space
 * `normalize` fits to the unit square. A monument is a stack of few, big,
 * square masses — the one shape rule in this file that a building without
 * a roof can still keep — and every one of them is battered, which is what
 * makes a stack of stone read as carrying its own weight rather than as
 * boxes set down on each other (see frustumGeo).
 */
const MON_STEP_A = 0.075;
const MON_STEP_B = 0.065;
const MON_DIE = 0.6;
const MON_CORNICE = 0.07;
const MON_SOCLE = 0.035;
/** The figure, and what the whole thing comes to. */
const MON_FIGURE = 1.05;
const MON_PEDESTAL =
  MON_STEP_A + MON_STEP_B + MON_DIE + MON_CORNICE + MON_SOCLE;

/**
 * The monument: a serf cast in gold on a battered stone pedestal.
 *
 * The pack has no monument and nothing that could stand in for one — the
 * shells it leaves unspoken for are a second house, a market stall, an
 * archery range and a watermill, and the two masses grand enough to read
 * as a wonder (the castle, the church) are already the storehouse and the
 * abbey. A second building wearing either silhouette is the mistake the
 * bakehouse note above spends a paragraph on. So the pedestal is ours.
 *
 * The figure is not. It is the serf himself — the same body, the same carry
 * pose, the same load the haulers carry — baked out of the rig by statue.ts
 * and handed in here as plain geometry. That is the whole idea: the village
 * raises a monument to the man who carries everything, and the man on it is
 * recognizably one of the men walking past it. He costs what he costs: this
 * is the character's own mesh, so the monument carries a villager's triangle
 * budget rather than a building's.
 *
 * Gold is the one paint on it that is not stone, and it comes out of the
 * atlas like everything else: cell (1,3) is the gold ramp the pack paints
 * its grain in, and the figure takes the deep end of it — light gathering
 * on the head and shoulders, bronzing into the boots, which is what gilding
 * does under a sun. The brighter gold two cells over was tried and dropped:
 * (3,2) is where the pack paints the fourth seat's team colour (the gold
 * #f9aa4e in factionPalette is that cell), and a figure painted there is a
 * faction claim on any map with a gold banner in it.
 *
 * `statue` is a parameter rather than a call because the figure comes from
 * the character pack, which loads on its own schedule beside the building
 * pack — assets.ts must not wait on it. Null (characters not up yet, or a
 * failed load) raises the pedestal alone, which is an honest half-finished
 * monument rather than an empty screen.
 */
export function makeMonument(
  packMaterial: THREE.Material | null,
  statue: THREE.BufferGeometry | null,
): THREE.Group {
  atlas = packMaterial;
  const g = new THREE.Group();
  pedestal(g);
  if (statue) {
    const figure = mesh(statue.clone(), KAY.gilt);
    figure.scale.setScalar(MON_FIGURE);
    figure.position.y = MON_PEDESTAL;
    g.add(figure);
  }
  applyRamps(g);
  return g;
}

/** The stone under him: two steps, a battered die, a cornice, a socle. */
function pedestal(g: THREE.Group): void {
  let y = 0;
  const course = (
    wb: number,
    wt: number,
    h: number,
    paint: Paint,
  ): THREE.Mesh => {
    const m = mesh(frustumGeo(wb, wb, wt, wt, h), paint);
    m.position.y = y;
    y += h;
    g.add(m);
    return m;
  };
  // The steps: the widest thing here, and the only part of the monument a
  // villager walking past it comes level with. Light stone under dark, so
  // the stack darkens downward the way a rain-washed plinth does.
  course(1.0, 0.965, MON_STEP_A, KAY.stone);
  course(0.8, 0.775, MON_STEP_B, KAY.stonePale);
  // The die, and all the height. Its batter is slight in the numbers —
  // 0.58 across at the foot to 0.50 at the neck, over 0.6 of rise — and
  // the only one that reads, because it is the one mass tall enough to
  // show a lean at all.
  course(0.58, 0.5, MON_DIE, KAY.stone);
  // The cornice flares the other way — out and up, overhanging the die it
  // caps. A moulding that leans in like the courses under it reads as one
  // more block; leaning out is what makes it a lid.
  course(0.54, 0.64, MON_CORNICE, KAY.stonePale);
  // The socle the boots stand on, a step back in from the cornice.
  course(0.44, 0.42, MON_SOCLE, KAY.stone);
  blazon(g);
}

/**
 * The owner's blazon on the front of the die: a plain panel standing proud
 * of the stone, painted into cell (3,3) — the slot splitTeamColorGroups
 * repaints per faction, the same one that carries a roof. Without it two
 * seats' monuments are the same grey object; with it, a rival's monument
 * announces itself across the valley, which is what a monument is for.
 */
function blazon(g: THREE.Group): void {
  const W = 0.19;
  const H = 0.24;
  const D = 0.02;
  // A heater shield: square shoulders, straight flanks, a point. The pack
  // draws heraldry exactly once — the knight's shield_badge — and this is
  // that outline, cut as a shape rather than borrowed as a prop, because a
  // built building has no prop factory to reach for.
  const outline = new THREE.Shape();
  outline.moveTo(-W / 2, H / 2);
  outline.lineTo(W / 2, H / 2);
  outline.lineTo(W / 2, H * 0.06);
  outline.quadraticCurveTo(W / 2, -H / 2 + H * 0.08, 0, -H / 2);
  outline.quadraticCurveTo(-W / 2, -H / 2 + H * 0.08, -W / 2, H * 0.06);
  outline.closePath();
  const shield = mesh(
    new THREE.ExtrudeGeometry(outline, {
      depth: D,
      bevelEnabled: false,
      curveSegments: 6,
    }),
    KAY.roof,
  );

  // Set on a panel of lighter stone, so the colour reads as a shield hung
  // on the die and not as paint spilled down it.
  const panel = mesh(
    new THREE.BoxGeometry(W + 0.08, H + 0.09, D * 1.5),
    KAY.stonePale,
  );
  // The panel stands 0.015 proud of the die and the shield another 0.02
  // proud of the panel — the depth this file's timber has, on the two
  // pieces that need to read as hung on the stone rather than painted on
  // it. Flush, they were a decal.
  shield.position.z = D * 0.75;
  const holder = new THREE.Group();
  holder.add(panel, shield);

  // Centred on the die's height and leaning with it: the face falls 0.04
  // in z over 0.6 of rise, and a flat plate hung on a leaning wall gaps at
  // one end unless it leans too.
  holder.rotation.x = -Math.atan2(0.04, MON_DIE);
  holder.position.set(
    0,
    MON_STEP_A + MON_STEP_B + MON_DIE / 2,
    // Half-span of the die's face at that height, so the panel stands on
    // the stone rather than sinking into it.
    0.29 - 0.04 * 0.5,
  );
  g.add(holder);
}
