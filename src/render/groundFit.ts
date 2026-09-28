import * as THREE from 'three';
import {buildingDef, type BuildingTypeId} from '../sim/defs/buildings';
import * as BuildingTypeIds from '../sim/defs/buildingTypeIdEnum.ts';
import type {HeightField} from './heightField';

/**
 * Standing a building on ground that is not flat.
 *
 * Every model is authored on a level plane at y = 0, and the terrain under
 * a footprint is anything but: placement allows half a unit of fall across
 * a farm, and puts no limit at all on a mine. Stood rigidly at one height,
 * a building on a slope hangs its downhill side in the air and buries its
 * uphill side — a farm's rows vanish into the hill, a mine's rails run off
 * into space.
 *
 * So the model is bent to the ground, per vertex, in world space, and only
 * ever vertically — a wall stays plumb, a post stays upright. Three rules,
 * picked per part by a `groundFit` tag in userData (the nearest tagged
 * ancestor wins; untagged is the building itself):
 *
 *   drape  the part lies ON the ground and follows it everywhere: a field,
 *          its fences, a mine's track, the clutter in a yard. Each vertex
 *          rises or falls by the ground under it.
 *   foot   a rigid thing standing on its own feet — a headframe, a
 *          wheelbarrow. It is lifted or lowered to the ground at its own
 *          centre, and only its bottom band (BAND) bends, so its legs meet
 *          the slope while its roof stays level.
 *   (none) the building. It stands at the root's height (the ground at
 *          its door, see anchorGround) and its bottom band stretches DOWN
 *          to wherever the ground falls away below that. Where the ground
 *          rises instead the building is simply dug in, which is how a
 *          house on a hillside looks anyway.
 *
 * The bend writes a position attribute of the mesh's own, sharing every
 * other attribute with the template — a template's geometry is never
 * touched. releaseFit frees what a fit allocated.
 */

export const GROUND_FIT = 'groundFit';
export type GroundFitMode = 'drape' | 'foot';

/** A named empty on a template marking where its ground level is read — its
 * door. Absent, the anchor is a little inside the front edge. */
export const GROUND_ANCHOR = 'groundAnchor';

/** Height of the bottom band that bends, world units. Only the base of a
 * wall moves: a vertex this high over the base, or higher, stays put. */
const BAND = 0.4;

/** Longest edge a draped part may have, world units. The terrain mesh
 * samples the height field several times per tile; a long triangle laid
 * over it would cut straight through the dips between its corners. */
const MAX_EDGE = 0.3;

/** Where along the front a building with no anchor reads its ground, as a
 * fraction of its half-depth — about where the pack's front walls stand. */
const DEFAULT_ANCHOR_Z = 0.8;

/** Bends smaller than this leave the template's geometry in place. */
const EPS = 1e-4;

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const V = new THREE.Vector3();
const INV = new THREE.Matrix4();
const BOX = new THREE.Box3();
const MESH_BOX = new THREE.Box3();

/** The template geometry a fitted mesh was bent from. */
const sources = new WeakMap<THREE.Mesh, THREE.BufferGeometry>();
/** Geometries a fit allocated, which releaseFit frees. */
const owned = new WeakSet<THREE.BufferGeometry>();
/** Subdivided copies of template geometry, keyed by the longest edge they
 * were cut to. Shared by every instance, like the templates themselves. */
const tessellated = new WeakMap<
  THREE.BufferGeometry,
  Map<number, THREE.BufferGeometry>
>();

/**
 * The quarter turn (Building.facing's convention: clockwise from "front
 * faces +z") that points a footprint's front at its lowest edge. A mine is
 * a hole in a hill, so its door opens downhill and the mound backs into
 * the slope; ties keep the authored front.
 */
export function downhillFacing(
  heights: HeightField,
  x: number,
  y: number,
  w: number,
  h: number,
): 0 | 1 | 2 | 3 {
  const edge = (ax: number, az: number, bx: number, bz: number): number =>
    (heights.at(ax, az) +
      heights.at((ax + bx) / 2, (az + bz) / 2) +
      heights.at(bx, bz)) /
    3;
  const edges = [
    edge(x, y + h, x + w, y + h), // 0: front, +z
    edge(x + w, y, x + w, y + h), // 1: +x
    edge(x, y, x + w, y), // 2: -z
    edge(x, y, x, y + h), // 3: -x
  ];
  let best = 0;
  for (let i = 1; i < 4; i++) if (edges[i]! < edges[best]! - 1e-3) best = i;
  return best as 0 | 1 | 2 | 3;
}

/**
 * Ground height at the building's door: the level it is stood at. Reads the
 * template's GROUND_ANCHOR mark if it has one, else a point just inside the
 * front edge; either way turned with the model. Only the root's x/z are
 * read, so its y can be anything when this is asked.
 */
export function anchorGround(
  root: THREE.Object3D,
  model: THREE.Object3D,
  halfD: number,
  heights: HeightField,
): number {
  const mark = model.getObjectByName(GROUND_ANCHOR);
  if (mark) {
    root.updateWorldMatrix(true, true);
    mark.getWorldPosition(V);
  } else {
    V.set(0, 0, halfD * DEFAULT_ANCHOR_Z)
      .applyAxisAngle(Y_AXIS, model.rotation.y)
      .add(root.position);
  }
  return heights.at(V.x, V.z);
}

/**
 * Whether a type is stood on the ground this way at all. Not roads (their
 * built form is the terrain itself) nor salvage (nothing but piles), and
 * not shore buildings: their deck is fitted to the water from the plain
 * centre height (pierFit.ts) and that fit owns their look on a bank.
 */
export function fitsGround(type: BuildingTypeId): boolean {
  const def = buildingDef(type);
  return !def.nearWater && !def.isRoad && type !== BuildingTypeIds.salvage;
}

/**
 * Which way a building's model faces. The sim's quarter turn for a shore
 * building; for a mine, its lowest edge (downhillFacing) — the sim has no
 * opinion there, any side of a footprint is a way in, and an adit is dug
 * into a hill from below, not above. A pure function of the terrain, so
 * every client and the placement preview agree without a byte on the wire.
 */
export function modelFacing(
  type: BuildingTypeId,
  x: number,
  y: number,
  w: number,
  h: number,
  simFacing: number | undefined,
  heights: HeightField,
): number {
  if (buildingDef(type).mine) return downhillFacing(heights, x, y, w, h);
  return simFacing ?? 0;
}

/**
 * Stand a building's model on the ground it is over: turned to `facing`,
 * the root raised or lowered to the ground at its door (anchorGround), and
 * the model bent to the slope (fitToGround). The root must already stand
 * at the footprint's centre in x/z; the model is added to it. Types that
 * do not fit (fitsGround) are left exactly as they were.
 */
export function standOnGround(
  type: BuildingTypeId,
  h: number,
  root: THREE.Object3D,
  model: THREE.Object3D,
  facing: number,
  heights: HeightField,
): void {
  if (!fitsGround(type)) return;
  model.rotation.y = (facing * Math.PI) / 2;
  if (model.parent !== root) root.add(model);
  root.position.y = anchorGround(root, model, h / 2, heights);
  fitToGround(model, heights, root.position.y);
}

interface Rule {
  mode: GroundFitMode | 'building';
  /** World y the part's base stands at before the fit. */
  base: number;
  /** Ground height the part is lifted to (foot) — its own centre's. */
  pivot: number;
}

/**
 * Bend `model` to the ground (see the file comment). `baseY` is the world
 * height the model's y = 0 stands at — its root's. Idempotent: every call
 * starts again from the template geometry, so a placement preview can be
 * refitted on every tile the cursor crosses.
 */
export function fitToGround(
  model: THREE.Object3D,
  heights: HeightField,
  baseY: number,
): void {
  model.updateWorldMatrix(true, true);
  const building: Rule = {mode: 'building', base: baseY, pivot: baseY};
  const visit = (o: THREE.Object3D, rule: Rule): void => {
    const tag = o.userData[GROUND_FIT] as GroundFitMode | undefined;
    if (tag === 'drape') rule = {mode: 'drape', base: baseY, pivot: baseY};
    else if (tag === 'foot') {
      sourceBox(o, BOX);
      if (!BOX.isEmpty()) {
        const cx = (BOX.min.x + BOX.max.x) / 2;
        const cz = (BOX.min.z + BOX.max.z) / 2;
        rule = {mode: 'foot', base: BOX.min.y, pivot: heights.at(cx, cz)};
      }
    }
    if (o instanceof THREE.Mesh) fitMesh(o, rule, heights, baseY);
    for (const c of o.children) visit(c, rule);
  };
  visit(model, building);
}

/** Free the geometry a fit gave this subtree, putting the template's back. */
export function releaseFit(model: THREE.Object3D): void {
  model.traverse(o => {
    if (!(o instanceof THREE.Mesh)) return;
    const src = sources.get(o);
    if (src === undefined) return;
    disposeFitted(o.geometry as THREE.BufferGeometry);
    o.geometry = src;
    sources.delete(o);
  });
}

/**
 * Free a geometry a fit allocated — its position buffer and nothing else.
 * Its index and every other attribute are the template's (or the template's
 * cached tessellation), shared with every other instance of the building,
 * and three's dispose frees the GPU buffer of every attribute the geometry
 * holds: left on, they would be deleted out from under every building of
 * the type still standing. So they are taken off first.
 */
function disposeFitted(g: THREE.BufferGeometry): void {
  if (!owned.has(g)) return;
  owned.delete(g);
  g.setIndex(null);
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position') g.deleteAttribute(name);
  }
  g.dispose();
}

/**
 * Stand a small rigid thing — a stack of stock, a pile of ore — on the
 * lowest ground under it. No bending: goods are stacked, and a stack that
 * followed the slope would lean. The lowest point, not the middle, so the
 * downhill edge touches and nothing shows daylight; the uphill edge sits a
 * little into the grass.
 */
export function seatOnGround(obj: THREE.Object3D, heights: HeightField): void {
  obj.updateWorldMatrix(true, true);
  BOX.setFromObject(obj);
  if (BOX.isEmpty()) return;
  const {min, max} = BOX;
  const g = Math.min(
    heights.at(min.x, min.z),
    heights.at(max.x, min.z),
    heights.at(min.x, max.z),
    heights.at(max.x, max.z),
    heights.at((min.x + max.x) / 2, (min.z + max.z) / 2),
  );
  const parentScale = obj.parent ? obj.parent.getWorldScale(V).y : 1;
  obj.position.y += (g - min.y) / parentScale;
}

/** World box of a subtree's TEMPLATE geometry — what it was before any fit,
 * so refitting reads the same pivot every time. */
function sourceBox(o: THREE.Object3D, out: THREE.Box3): void {
  out.makeEmpty();
  const part = new THREE.Box3();
  o.traverse(m => {
    if (!(m instanceof THREE.Mesh)) return;
    const geo = sources.get(m) ?? (m.geometry as THREE.BufferGeometry);
    if (!geo.boundingBox) geo.computeBoundingBox();
    part.copy(geo.boundingBox!).applyMatrix4(m.matrixWorld);
    out.union(part);
  });
}

function fitMesh(
  mesh: THREE.Mesh,
  rule: Rule,
  heights: HeightField,
  baseY: number,
): void {
  const template = sources.get(mesh) ?? (mesh.geometry as THREE.BufferGeometry);
  if (rule.mode === 'building') {
    // Only the bottom band of a building bends: a mesh standing wholly
    // above it (a roof, a chimney, a sign) is drawn from the template
    // without sampling the ground under every one of its vertices.
    if (!template.boundingBox) template.computeBoundingBox();
    MESH_BOX.copy(template.boundingBox!).applyMatrix4(mesh.matrixWorld);
    if (!MESH_BOX.isEmpty() && MESH_BOX.min.y >= rule.base + BAND) {
      disposeFitted(mesh.geometry as THREE.BufferGeometry);
      mesh.geometry = template;
      sources.delete(mesh);
      return;
    }
  }
  const scale = mesh.getWorldScale(V).x;
  const src =
    rule.mode === 'drape' ? tessellate(template, MAX_EDGE / scale) : template;
  const pos = src.getAttribute('position');
  const out = new Float32Array(pos.count * 3);
  INV.copy(mesh.matrixWorld).invert();
  let bent = src !== template;
  for (let i = 0; i < pos.count; i++) {
    V.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    const g = heights.at(V.x, V.z);
    let dy: number;
    if (rule.mode === 'drape') {
      dy = g - baseY;
    } else {
      const w = Math.max(0, 1 - (V.y - rule.base) / BAND);
      const fall = g - rule.pivot;
      dy =
        rule.pivot -
        baseY +
        (rule.mode === 'building' ? Math.min(0, fall) : fall) * w;
    }
    if (Math.abs(dy) > EPS) bent = true;
    V.y += dy;
    V.applyMatrix4(INV);
    out[i * 3] = V.x;
    out[i * 3 + 1] = V.y;
    out[i * 3 + 2] = V.z;
  }
  disposeFitted(mesh.geometry as THREE.BufferGeometry);
  if (!bent) {
    mesh.geometry = template;
    sources.delete(mesh);
    return;
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(src.getIndex());
  for (const [name, attr] of Object.entries(src.attributes)) {
    if (name !== 'position') geo.setAttribute(name, attr);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
  for (const g of src.groups) geo.addGroup(g.start, g.count, g.materialIndex);
  geo.setDrawRange(src.drawRange.start, src.drawRange.count);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  owned.add(geo);
  sources.set(mesh, template);
  mesh.geometry = geo;
}

/**
 * Cut a geometry's triangles until no edge is longer than `maxEdge` (in the
 * geometry's own units), by halving the longest edge — so a draped part
 * has vertices close enough together to follow the ground between them.
 * Every attribute is carried along linearly; material groups survive.
 * Cached per template and edge length.
 */
export function tessellate(
  geo: THREE.BufferGeometry,
  maxEdge: number,
): THREE.BufferGeometry {
  const key = Math.round(maxEdge * 1e4);
  let byEdge = tessellated.get(geo);
  const hit = byEdge?.get(key);
  if (hit) return hit;
  const flat = geo.index ? geo.toNonIndexed() : geo;
  const names = Object.keys(flat.attributes);
  const attrs = names.map(n => flat.getAttribute(n));
  const sizes = attrs.map(a => a.itemSize);
  const pi = names.indexOf('position');
  const outs: number[][] = names.map(() => []);
  const read = (i: number): number[][] =>
    attrs.map((a, k) => {
      const v: number[] = [];
      for (let c = 0; c < sizes[k]!; c++) v.push(a.getComponent(i, c));
      return v;
    });
  const mid = (a: number[][], b: number[][]): number[][] =>
    a.map((va, k) => va.map((x, c) => (x + b[k]![c]!) / 2));
  const len2 = (a: number[][], b: number[][]): number => {
    const p = a[pi]!;
    const q = b[pi]!;
    return (p[0]! - q[0]!) ** 2 + (p[1]! - q[1]!) ** 2 + (p[2]! - q[2]!) ** 2;
  };
  let written = 0;
  const emit = (t: number[][][]): void => {
    for (const v of t) v.forEach((vals, k) => outs[k]!.push(...vals));
    written += 3;
  };
  const max2 = maxEdge * maxEdge;
  const split = (t: number[][][], depth: number): void => {
    const [a, b, c] = t as [number[][], number[][], number[][]];
    const ab = len2(a, b);
    const bc = len2(b, c);
    const ca = len2(c, a);
    const m = Math.max(ab, bc, ca);
    if (m <= max2 || depth > 16) return emit(t);
    if (m === ab) {
      const x = mid(a, b);
      split([a, x, c], depth + 1);
      split([x, b, c], depth + 1);
    } else if (m === bc) {
      const x = mid(b, c);
      split([a, b, x], depth + 1);
      split([a, x, c], depth + 1);
    } else {
      const x = mid(c, a);
      split([a, b, x], depth + 1);
      split([x, b, c], depth + 1);
    }
  };
  const count = flat.getAttribute('position').count;
  const groups =
    flat.groups.length > 0
      ? flat.groups
      : [{start: 0, count, materialIndex: 0}];
  const out = new THREE.BufferGeometry();
  for (const g of groups) {
    const start = written;
    const end = Math.min(g.start + g.count, count);
    for (let i = g.start; i + 2 < end; i += 3) {
      split([read(i), read(i + 1), read(i + 2)], 0);
    }
    if (flat.groups.length > 0)
      out.addGroup(start, written - start, g.materialIndex);
  }
  names.forEach((n, k) => {
    out.setAttribute(
      n,
      new THREE.BufferAttribute(new Float32Array(outs[k]!), sizes[k]!),
    );
  });
  if (flat !== geo) flat.dispose();
  if (!byEdge) tessellated.set(geo, (byEdge = new Map()));
  byEdge.set(key, out);
  return out;
}
