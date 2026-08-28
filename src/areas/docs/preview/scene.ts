import * as THREE from 'three';
import {makeGroundTexture} from '../../../render/groundTexture';
import {vnoise} from '../../../render/noise';
import {
  grassGold,
  grassLush,
  grassOlive,
  trampledEarth,
} from '../../../render/palette';
import {hash2} from '../../../shared/math';

/**
 * The wiki's little diorama stage: the game's light and grade over a disc
 * of turf, seen through the same orthographic 45°/35° rig the match camera
 * uses, so a building reads here exactly as it reads in a village.
 *
 * Adapted from tools/modelLab/scene.ts rather than imported: the lab is a
 * dev tool under its own tsconfig, and app code depending on tool code is
 * the wrong direction — the ~80 lines are the cheaper coupling.
 */

export const YAW = Math.PI / 4;
export const PITCH = (35 * Math.PI) / 180;

/** The terrain's meadow ramp, built once (see terrainMesh's COL). */
const MEADOW = {
  lush: new THREE.Color(grassLush),
  olive: new THREE.Color(grassOlive),
  gold: new THREE.Color(grassGold),
};

/**
 * World units to a repeat of the speckle. The terrain uses 4 across a whole
 * map; a card is three metres of that seen close up, so the blades want to
 * be finer here or they read as blotches.
 */
const TEXTURE_UNITS = 2;

let sharedGround: THREE.Texture | null = null;
/** The game's own ground speckle — one canvas for every plate on the page.
 * Density is baked into each plate's UVs instead of the texture's repeat,
 * so plates of different sizes can share this one texture. */
function groundTexture(): THREE.Texture {
  if (!sharedGround) {
    sharedGround = makeGroundTexture(TEXTURE_UNITS);
    // makeGroundTexture bakes a map-sized repeat into the texture; the
    // plates carry their density in their UVs instead, and leaving both in
    // play multiplied them into a speckle twice the intended size.
    sharedGround.repeat.set(1, 1);
  }
  return sharedGround;
}

export function makeRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  // preserveDrawingBuffer: the hub blits this canvas into each card's 2D
  // canvas right after rendering, and without it the buffer may already be
  // cleared by the time drawImage reads it.
  const r = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  r.setClearColor(0x000000, 0);
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFShadowMap;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1.32;
  return r;
}

export function makeLights(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight(0xcfe4f7, 0x7f9a50, 1.05));
  const sun = new THREE.DirectionalLight(0xfff1cf, 2.7);
  sun.position.set(-4, 7, 5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const half = 4.5;
  sun.shadow.camera.left = -half;
  sun.shadow.camera.right = half;
  sun.shadow.camera.top = half;
  sun.shadow.camera.bottom = -half;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 24;
  sun.shadow.bias = -0.0008;
  scene.add(sun, sun.target);
}

/**
 * A slab of turf cut out of the valley: the same meadow the terrain paints
 * — lush through olive to sun-dried gold — under the same speckle map, on
 * a soil edge so it reads as ground lifted from the world rather than a
 * green decal. `seed` varies the patch so a grid of cards does not repeat.
 */
export function makePlate(radius: number, seed = 0): THREE.Group {
  const g = new THREE.Group();
  // A subdivided disc rather than a fan: the meadow is painted per vertex,
  // and a disc whose only vertices are its rim has nothing to paint into.
  const geo = new THREE.RingGeometry(0, radius, 64, 6);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position!;
  const uv = geo.attributes.uv!;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + seed;
    const z = pos.getZ(i) - seed;
    // Two octaves at plate scale: a patch or two across the turf, plus a
    // finer wobble. The map's own noise is tuned to a 64-tile world, and
    // sampled over three metres of it a single octave comes out flat.
    const broad = vnoise(seed + 7, x, z, 2.2);
    const fine = vnoise(seed + 31, x, z, 0.7);
    // Weighted to keep the meadow lush: the ramp runs to sun-dried gold,
    // and a plate that wanders up into it reads as dead grass rather than
    // the valley in high summer.
    const m = broad * 0.5 + fine * 0.22;
    if (m < 0.52) c.copy(MEADOW.lush).lerp(MEADOW.olive, m / 0.52);
    else c.copy(MEADOW.olive).lerp(MEADOW.gold, (m - 0.52) / 0.48);
    // The terrain's per-vertex speck, so the surface never reads as a
    // smooth gradient.
    const speck = 0.92 + hash2(i, 977 + seed) * 0.16;
    colors[i * 3] = c.r * speck;
    colors[i * 3 + 1] = c.g * speck;
    colors[i * 3 + 2] = c.b * speck;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  // Ring UVs span the bounding square; scaling them to world units gives
  // every plate the same blade density regardless of its radius.
  const density = (radius * 2) / TEXTURE_UNITS;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * density, uv.getY(i) * density);
  }
  const disc = new THREE.Mesh(
    geo,
    // Lambert, like the terrain: the whole scene is keyed to it.
    new THREE.MeshLambertMaterial({vertexColors: true, map: groundTexture()}),
  );
  disc.receiveShadow = true;
  g.add(disc);
  const skirt = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius * 0.985, 0.14, 64, 1, true),
    new THREE.MeshLambertMaterial({
      color: trampledEarth,
      side: THREE.DoubleSide,
    }),
  );
  skirt.position.y = -0.07;
  g.add(skirt);
  return g;
}

export interface Framing {
  /** Half the view height that frames the composition. */
  radius: number;
  center: THREE.Vector3;
}

/**
 * How big the view must be to hold `model` on a plate of `plateR`. At
 * 45/35 a composition's screen height is roughly its ground span plus most
 * of its height, so tall things (the windmill) frame by the same rule as
 * flat ones; the plate is a floor so the turf never crops mid-card.
 */
export function frameFor(model: THREE.Object3D, plateR: number): Framing {
  const bb = new THREE.Box3().setFromObject(model);
  const center = new THREE.Vector3();
  bb.getCenter(center);
  const size = new THREE.Vector3();
  bb.getSize(size);
  const span = Math.max(size.x, size.z);
  const view =
    Math.max(span * 1.45, span * 0.95 + size.y * 1.05, plateR * 1.92) + 0.35;
  center.y = size.y * 0.42;
  return {radius: view / 2, center};
}

/** Place an orthographic camera on the game's rig angles, framing `f`. */
export function frame(
  cam: THREE.OrthographicCamera,
  f: Framing,
  yaw: number,
  aspect: number,
): void {
  const view = f.radius * 2;
  cam.left = (-view * aspect) / 2;
  cam.right = (view * aspect) / 2;
  cam.top = view / 2;
  cam.bottom = -view / 2;
  cam.near = 0.1;
  cam.far = 60;
  const dist = 18;
  cam.position.set(
    f.center.x + Math.sin(yaw) * Math.cos(PITCH) * dist,
    f.center.y + Math.sin(PITCH) * dist,
    f.center.z + Math.cos(yaw) * Math.cos(PITCH) * dist,
  );
  cam.lookAt(f.center);
  cam.updateProjectionMatrix();
}
