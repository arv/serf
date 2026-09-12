import * as THREE from 'three';
import {factionTint} from './factionPalette';
import {vermillion} from './palette';

/**
 * The colored edge a unit wears while a building stands between it and the
 * camera.
 *
 * A valley this dense hides people constantly: the storehouse eats the
 * serfs queueing at its door, a mill swallows the carrier walking behind
 * it, and a raid coming round the back of the barracks is a raid you find
 * out about from the damage alert. The fix is the one every RTS with tall
 * scenery arrives at — draw the hidden man again, as an outline, over the
 * thing hiding him.
 *
 * It is an outline and not a filled ghost on purpose: a silhouette painted
 * solid over a wall reads as a man standing *in front of* the wall, and at
 * a glance you cannot tell the two apart. An edge reads as what it is — a
 * man you cannot see, whose shape you are being told.
 *
 * How it is drawn, per hidden unit, after the world and before the
 * overlays:
 *
 *  1. **Mask.** The body again, with color writes off and no depth test at
 *     all, stamping one stencil bit over the whole of where it stands on
 *     the screen.
 *  2. **Hull.** The body once more, back faces only, every vertex pushed
 *     out along its normal by a few screen pixels, drawn where the depth
 *     test is inverted (`GreaterDepth`: pass only where something nearer
 *     has already been drawn) and the stencil test *skips* the bit the
 *     mask wrote. What survives is the ring of pushed-out body that falls
 *     outside the body and behind the wall: the outline, and only around
 *     the part of him the wall has taken.
 *
 * Both passes share the character's own geometry and skeleton — the twins
 * hang off the meshes they copy, so they inherit the pose, the transform
 * and the visibility of the original for free, and cost no skinning work
 * on the CPU.
 *
 * Every hidden unit writes the same bit, and three draws all the masks
 * before any of the hulls, so what the hulls test against is the union of
 * the hidden silhouettes rather than each man's own. A crowd behind a keep
 * therefore wears one edge around the group instead of a tangle of edges
 * crossing each other — deliberate, and the reason this is two passes and
 * not three. The alternative is a stencil bit per unit (eight, and there
 * are more men than that) or an unmask pass after each hull, which is half
 * as many units per frame for internal boundaries that read as noise. What
 * it costs is the count: eight men shoulder to shoulder read as a crowd,
 * not as eight.
 *
 * Which units get one is decided on the CPU (`occludedBy`), not by the
 * depth buffer: the depth buffer cannot tell a building from a crag or an
 * oak, and an outline for every man behind every tree is noise. Because
 * the test is a ray against building boxes, and a box contains the model
 * inside it, it errs toward drawing — a wasted pair of draws that the
 * depth test then rejects everywhere, never a missing outline.
 */

/** The one stencil bit this pass owns: set by the mask over a body, read
 * by the hull to cut its own middle out. Nothing else in the renderer
 * touches the stencil buffer, so one bit is the whole budget it needs. */
const BODY_BIT = 0x01;

/** Both passes ride after the opaque world (renderOrder 0) and before the
 * overlays that sit over everything — the hp bars at 10, which draw with
 * no depth test and would otherwise have a hull painted across them.
 * Three sorts the opaque queue by renderOrder first, which is what puts
 * the outline between the two and what guarantees the mask has written
 * its bit before the hull tests it. */
const MASK_ORDER = 8;
const HULL_ORDER = 9;

/** How wide the edge is drawn, in device pixels. Wide enough to survive a
 * zoomed-out valley, narrow enough that a man does not become a blob. */
const OUTLINE_PX = 3.0;

/** Drawing-buffer height in device pixels — what turns a width in pixels
 * into a push in world units. One object shared by every outline material,
 * so the renderer sets it once per resize. */
const viewportHeight = {value: 900};

/** Tell the outline pass how tall the drawing buffer is, in device pixels.
 * Called by GameRenderer whenever it sizes the canvas. */
export function setOutlineViewportHeight(px: number): void {
  viewportHeight.value = Math.max(1, px);
}

/**
 * Push every vertex out along its own normal by a fixed number of *screen*
 * pixels rather than a fixed number of world units, so the edge is the
 * same weight at every zoom the rig offers. The push happens in view space,
 * after skinning, where "one pixel" is a single divide: under the match's
 * orthographic rig it is constant, and under the menu's perspective lens it
 * grows with depth, which the `isOrthographic` branch covers.
 *
 * `outlineNormal`, not `normal`: see smoothNormals. A back face pointing
 * straight away from the camera has no screen-space normal to push along;
 * it is left where it is, safely inside the body, where the mask's stencil
 * bit will discard it anyway.
 */
const HULL_VERTEX = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>

attribute vec3 outlineNormal;
uniform float uWidthPx;
uniform float uViewportH;

void main() {
  #include <beginnormal_vertex>
  objectNormal = outlineNormal;
  #include <begin_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <skinning_vertex>

  vec4 mv = modelViewMatrix * vec4( transformed, 1.0 );
  float w = isOrthographic ? 1.0 : - mv.z;
  float unitsPerPixel = 2.0 * w / ( projectionMatrix[1][1] * uViewportH );
  vec2 n = ( normalMatrix * objectNormal ).xy;
  float len = length( n );
  if ( len > 1e-5 ) mv.xy += ( n / len ) * uWidthPx * unitsPerPixel;
  gl_Position = projectionMatrix * mv;
}
`;

/**
 * Flat color, and deliberately none of the scene's grade: no fog, no tone
 * mapping, no output transform. The edge is a thing the game is telling
 * you, not a thing standing in the valley, and it says it in the faction's
 * own color rather than in whatever ACES makes of it at this exposure.
 * Which is why the color below is uploaded unconverted (see hullMaterial).
 */
const HULL_FRAGMENT = /* glsl */ `
uniform vec3 uColor;

void main() {
  gl_FragColor = vec4( uColor, 1.0 );
}
`;

/** Shared by every unit: the mask writes no color, so one is enough. */
const maskMaterial = new THREE.MeshBasicMaterial({
  colorWrite: false,
  depthWrite: false,
  // No depth test at all: the bit marks where the body *is* on screen,
  // whether it is hidden there or not. Marking only the hidden part
  // instead would leave the visible part of a man unmarked — and the hull
  // would then paint his own face green, which is what an early cut of
  // this did. Both sides, so a shape whose front faces are turned away (a
  // cape, a skirt) is still marked all through.
  depthTest: false,
  side: THREE.DoubleSide,
  stencilWrite: true,
  stencilRef: BODY_BIT,
  stencilFunc: THREE.AlwaysStencilFunc,
  stencilZPass: THREE.ReplaceStencilOp,
});

const hullMaterials = new Map<number, THREE.ShaderMaterial>();

function hullMaterial(color: number): THREE.ShaderMaterial {
  let m = hullMaterials.get(color);
  if (m) return m;
  m = new THREE.ShaderMaterial({
    vertexShader: HULL_VERTEX,
    fragmentShader: HULL_FRAGMENT,
    uniforms: {
      // Linear-sRGB rather than sRGB: with no output transform in the
      // fragment shader, whatever is uploaded here is what lands in the
      // framebuffer, so the raw channels of the hex are what put the
      // faction's exact color on the screen.
      uColor: {
        value: new THREE.Color().setHex(color, THREE.LinearSRGBColorSpace),
      },
      uWidthPx: {value: OUTLINE_PX},
      uViewportH: viewportHeight,
    },
    // The expanded shell, seen from inside: front faces would cover the
    // body's own pixels, back faces are the ring around it.
    side: THREE.BackSide,
    depthFunc: THREE.GreaterDepth,
    depthWrite: false,
    // stencilWrite is what turns the stencil *test* on at all in three;
    // the write mask below is what keeps this pass from changing anything.
    stencilWrite: true,
    stencilWriteMask: 0x00,
    stencilRef: BODY_BIT,
    stencilFuncMask: BODY_BIT,
    stencilFunc: THREE.NotEqualStencilFunc,
    fog: false,
  });
  hullMaterials.set(color, m);
  return m;
}

/** The two extra draws hung on one unit, switched as a pair. */
export interface XrayOutline {
  setVisible(on: boolean): void;
}

/** An outline that is never drawn — for a unit with no meshes to copy. */
const NO_OUTLINE: XrayOutline = {setVisible: () => undefined};

/**
 * Hang a mask/hull pair off every mesh in a character, in the owner's
 * color, and hand back the switch. Starts hidden: `SceneSync` turns it on
 * for the frames the unit spends behind a building.
 */
export function attachXrayOutline(
  root: THREE.Object3D,
  owner: number,
): XrayOutline {
  // The seat's own color where there is one. Bandits do NOT get their
  // stock grey here, the way a ring under one of them does: grey on a
  // stone wall is an outline nobody sees, and the man behind the wall you
  // most need telling about is the one coming to burn it. They get the
  // alarm red instead.
  const hull = hullMaterial(factionTint(owner) ?? vermillion);
  // Collected before anything is added: traversing while parenting new
  // meshes into the tree would copy the copies.
  const sources: THREE.Mesh[] = [];
  root.traverse(o => {
    if (o instanceof THREE.Mesh) sources.push(o);
  });
  if (sources.length === 0) return NO_OUTLINE;
  const twins: THREE.Object3D[] = [];
  for (const src of sources) {
    smoothNormals(src.geometry);
    twins.push(
      twin(src, maskMaterial, MASK_ORDER),
      twin(src, hull, HULL_ORDER),
    );
  }
  for (const t of twins) t.visible = false;
  return {
    setVisible(on: boolean): void {
      for (const t of twins) t.visible = on;
    },
  };
}

/**
 * A second draw of one mesh, parented to the mesh itself: same geometry,
 * same skeleton, same world transform, and hidden along with it whenever
 * the wardrobe hides the original (a stowed tool, a body a spec drops).
 */
function twin(
  src: THREE.Mesh,
  material: THREE.Material,
  order: number,
): THREE.Object3D {
  let mesh: THREE.Mesh;
  if (src instanceof THREE.SkinnedMesh) {
    const skinned = new THREE.SkinnedMesh(src.geometry, material);
    skinned.bindMode = src.bindMode;
    skinned.bind(src.skeleton, src.bindMatrix);
    mesh = skinned;
  } else {
    mesh = new THREE.Mesh(src.geometry, material);
  }
  mesh.renderOrder = order;
  mesh.frustumCulled = src.frustumCulled;
  // Never a caster: the outline is a thing the camera is told, and the sun
  // knows nothing about it.
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  src.add(mesh);
  return mesh;
}

/**
 * The normals the hull is pushed out along: the mesh's own, averaged over
 * every vertex that shares a position.
 *
 * The shading normals cannot do this job. A pack character is hard-edged —
 * every crease splits its vertices so each face can carry its own normal —
 * and a shell pushed out along *those* comes apart at every crease, into
 * as many loose plates as the model has faces. Drawn, that is not an
 * outline but a bowl of scribbles, one rim per plate. Averaging the
 * normals of the vertices standing at each position sews the shell back
 * into one surface, which grows the way a silhouette has to.
 *
 * Written onto the geometry itself (shared by every unit wearing that
 * body, so it is computed once) and read by nothing else: an attribute no
 * other shader declares costs those shaders nothing.
 *
 * Two normals meeting back to back — the two sides of a cape — cancel to
 * nothing; those vertices keep the normal they came with.
 */
function smoothNormals(geo: THREE.BufferGeometry): void {
  if (geo.getAttribute('outlineNormal')) return;
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const out = new Float32Array(pos.count * 3);
  if (!nrm) {
    geo.setAttribute('outlineNormal', new THREE.BufferAttribute(out, 3));
    return;
  }
  // Positions are compared at a tenth of a millimetre of model space —
  // finer than any seam the packs author, coarser than float noise.
  const key = (i: number): string =>
    `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(
      pos.getZ(i) * 1e4,
    )}`;
  const sums = new Map<string, THREE.Vector3>();
  const keys: string[] = [];
  for (let i = 0; i < pos.count; i++) {
    const k = key(i);
    keys.push(k);
    const acc = sums.get(k);
    if (acc)
      acc.set(acc.x + nrm.getX(i), acc.y + nrm.getY(i), acc.z + nrm.getZ(i));
    else sums.set(k, new THREE.Vector3(nrm.getX(i), nrm.getY(i), nrm.getZ(i)));
  }
  for (let i = 0; i < pos.count; i++) {
    const acc = sums.get(keys[i]!)!;
    const len = acc.length();
    const useOwn = len < 1e-6;
    out[i * 3] = useOwn ? nrm.getX(i) : acc.x / len;
    out[i * 3 + 1] = useOwn ? nrm.getY(i) : acc.y / len;
    out[i * 3 + 2] = useOwn ? nrm.getZ(i) : acc.z / len;
  }
  geo.setAttribute('outlineNormal', new THREE.BufferAttribute(out, 3));
}

/**
 * One building, as the occlusion test sees it: the world-space box its
 * model stands in. Roofs overhang footprints, so the horizontal extent is
 * padded a little — the test may only ever be too generous.
 */
export interface OccluderBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Ground the building stands on, and the top of its model. */
  baseY: number;
  topY: number;
}

/** Never count the ground a unit is standing on as the thing hiding it. */
const RAY_START = 0.05;

/**
 * Is a unit standing at (x, z) on ground `baseY`, `height` tall, hidden
 * behind any of these buildings from a camera looking along `dir`?
 *
 * `dir` points from the world *toward* the camera, and is the same vector
 * for every unit: the match rig is orthographic, so there is no eye point
 * to aim at, only a direction of view.
 *
 * The unit is a vertical segment rather than a point — a man whose head
 * clears a roof is still hidden from the knees down — which is a ray from
 * his feet against each box grown downward by his height.
 */
export function occludedBy(
  boxes: readonly OccluderBox[],
  x: number,
  baseY: number,
  z: number,
  height: number,
  dir: THREE.Vector3,
): boolean {
  for (const b of boxes) {
    if (
      hitsBox(
        x,
        baseY,
        z,
        dir,
        b.minX,
        b.maxX,
        b.baseY - height,
        b.topY,
        b.minZ,
        b.maxZ,
      )
    ) {
      return true;
    }
  }
  return false;
}

/** Slab test: does the ray from (ox, oy, oz) along `dir` enter the box? */
function hitsBox(
  ox: number,
  oy: number,
  oz: number,
  dir: THREE.Vector3,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number,
): boolean {
  let tMin = RAY_START;
  let tMax = Infinity;
  // Each axis in turn; a ray parallel to a slab either starts inside it or
  // can never be in it.
  if (dir.x !== 0) {
    const a = (minX - ox) / dir.x;
    const b = (maxX - ox) / dir.x;
    tMin = Math.max(tMin, Math.min(a, b));
    tMax = Math.min(tMax, Math.max(a, b));
  } else if (ox < minX || ox > maxX) return false;
  if (dir.y !== 0) {
    const a = (minY - oy) / dir.y;
    const b = (maxY - oy) / dir.y;
    tMin = Math.max(tMin, Math.min(a, b));
    tMax = Math.min(tMax, Math.max(a, b));
  } else if (oy < minY || oy > maxY) return false;
  if (dir.z !== 0) {
    const a = (minZ - oz) / dir.z;
    const b = (maxZ - oz) / dir.z;
    tMin = Math.max(tMin, Math.min(a, b));
    tMax = Math.min(tMax, Math.max(a, b));
  } else if (oz < minZ || oz > maxZ) return false;
  return tMax >= tMin;
}
