/**
 * Scratch page: the monument — a gilded serf on a stone pedestal.
 *
 * Not a mock. It calls the real builder (`makeMonument` in
 * src/render/procBuildings.ts) with the real figure (`makeStatueGeometry`
 * in src/render/statue.ts) and sizes the result exactly the way
 * makeGlbBuilding sizes a building of that footprint, so what stands here
 * is what would stand in a match — with a live serf beside it at his real
 * height, because the only question that matters is how the thing reads
 * next to the people who built it.
 *
 * ?figure=lord swaps the serf for the knight preset; ?kind=<unit kind> puts
 * any other body on the plinth (1 serf, 2 worker, 3 knight, 4 spearman,
 * 5 archer, 6-8 the bandits). ?fp=<2|3> sets the footprint it is sized for.
 * ?pose=<anim key name> and
 * ?phase=<0..1> cut the figure from a different clip and moment;
 * ?load=<carry code> changes what is in his arms (0 = empty).
 * ?serf=0 sends the man beside it home, ?yaw walks the camera round, and
 * w/h/zoom/fy frame the shot as on every other page here.
 */
import * as THREE from 'three';
import * as AnimKey from '../../src/render/animKeyEnum.ts';
import {loadGlbAssets, makeGlbBuilding} from '../../src/render/assets';
import {
  type AnimKey as AnimKeyT,
  loadCharacterAssets,
  makeCharacter,
  playAnimation,
} from '../../src/render/characters';
import {FIGURE_LOREKEEPER} from '../../src/render/characters';
import {TEAM_SWATCH_UV} from '../../src/render/factionPalette';
import {makeMonument} from '../../src/render/procBuildings';
import {
  ABBOT_AT_STUDY,
  LORD_AT_ARMS,
  makeStatueGeometry,
  SERF_AT_REST,
} from '../../src/render/statue';
import type {StatuePose} from '../../src/render/statue';
import * as BuildingTypeId from '../../src/sim/defs/buildingTypeIdEnum.ts';
import * as UnitTypeId from '../../src/sim/defs/unitTypeIdEnum.ts';
import {makeLights, makeRenderer, PITCH, YAW} from './scene';

const params = new URLSearchParams(location.search);
const num = (name: string, fallback: number): number => {
  const v = Number(params.get(name) ?? NaN);
  return Number.isFinite(v) ? v : fallback;
};

await Promise.all([loadGlbAssets(), loadCharacterAssets()]);

const W = num('w', 1000);
const H = num('h', 720);
const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const renderer = makeRenderer(canvas);
renderer.setClearColor(0xa9c691, 1);
renderer.setSize(W, H, false);

const scene = new THREE.Scene();
makeLights(scene);
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
  new THREE.MeshStandardMaterial({color: 0x55a02a, roughness: 1}),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

/**
 * The pack's own material, taken off a loaded building the way assets.ts
 * hands it to a built one. (makeGlbBuilding leaves every mesh with a
 * two-slot material array — plain first, team color second.)
 */
let packMaterial: THREE.Material | null = null;
makeGlbBuilding(BuildingTypeId.house, 0)?.traverse(o => {
  if (packMaterial || !(o instanceof THREE.Mesh)) return;
  packMaterial = Array.isArray(o.material) ? o.material[0]! : o.material;
});

const DEG = (rad: number): number => (rad * 180) / Math.PI;

// ?figure= swaps the whole preset — body and pose travel together, and
// neither the knight's default nor the abbot's is the serf's. `?kind=` still
// overrides the body alone, for putting a pose on someone it was not cut for.
const FIGURES: Record<string, {pose: StatuePose; kind: number}> = {
  lord: {pose: LORD_AT_ARMS, kind: UnitTypeId.knight},
  abbot: {pose: ABBOT_AT_STUDY, kind: FIGURE_LOREKEEPER},
};
const FIGURE = FIGURES[params.get('figure') ?? ''];
const PRESET = FIGURE?.pose ?? SERF_AT_REST;
const KIND = num('kind', FIGURE?.kind ?? UnitTypeId.serf);

const poseName = params.get('pose');
// `Object.hasOwn`, not `in`: the repo's pattern for reading a name against an
// enum module (asUnitTypeId in sim/defs/units.ts, parseAdvice in ai/advice.ts)
// and the one that stays right however the namespace is materialized. A live
// ES module namespace has a null prototype, so `in` happens to be safe on the
// dev server this page runs on — but nothing here should depend on that.
const clip =
  poseName && Object.hasOwn(AnimKey, poseName)
    ? ((AnimKey as unknown as Record<string, AnimKeyT>)[poseName] as AnimKeyT)
    : PRESET.clip;
const statue = makeStatueGeometry(
  {
    clip,
    phase: num('phase', PRESET.phase),
    // A load is a hauler's business: it comes off anybody but the serf
    // unless it is asked for by name.
    load: num('load', KIND === UnitTypeId.serf ? PRESET.load : 0),
    tool: num('tool', PRESET.tool ?? 0),
    // The chin is typed in degrees here and carried in radians everywhere
    // else — this is the one number on the page that gets nudged by eye.
    lift: (num('lift', DEG(PRESET.lift ?? 0)) * Math.PI) / 180,
  },
  // ?kind=<unit kind byte> puts somebody else on the plinth, dressed by
  // the wardrobe exactly as that unit walks around dressed: 1 serf,
  // 2 worker, 3 knight, 4 spearman, 5 archer, and the bandit kinds after
  // them.
  KIND,
);
if (!statue) throw new Error('no statue: characters not loaded');

const model = makeMonument(packMaterial, statue);

/**
 * The mill every building goes through in assets.ts, in the two lines of
 * it that matter here: the footprint fitted to the unit square with the
 * base on the ground, then scaled by the short side of the footprint.
 * (normalize itself is private to assets.ts.)
 */
const FP = num('fp', 2);
const bbox = new THREE.Box3().setFromObject(model);
model.position.set(
  -(bbox.min.x + bbox.max.x) / 2,
  -bbox.min.y,
  -(bbox.min.z + bbox.max.z) / 2,
);
const fit = new THREE.Group();
fit.scale.setScalar(
  (1 / Math.max(bbox.max.x - bbox.min.x, bbox.max.z - bbox.min.z)) * FP * 1.06,
);
fit.add(model);
scene.add(fit);

// A serf standing at the foot of it, at the height the game draws him.
if (params.get('serf') !== '0') {
  const made = makeCharacter(UnitTypeId.serf, 0, 0);
  if (made) {
    made.group.position.set(FP * 0.78, 0, FP * 0.52);
    made.group.rotation.y = YAW + Math.PI;
    scene.add(made.group);
    playAnimation(made.visual, AnimKey.idle, 0.3);
    made.visual.mixer.update(0);
  }
}

// What the team-color split will find when this becomes a building: the
// share of the model's triangles whose UVs land in the slot reserved for
// the owner's colour. Zero means a rival's monument would be grey.
const {u0, u1, v0, v1} = TEAM_SWATCH_UV;
let team = 0;
let total = 0;
model.traverse(o => {
  if (!(o instanceof THREE.Mesh)) return;
  const uv = o.geometry.getAttribute('uv');
  const index = o.geometry.getIndex();
  if (!uv) return;
  const count = index ? index.count : uv.count;
  for (let i = 0; i < count; i += 3) {
    total++;
    let inSlot = true;
    for (let k = 0; k < 3; k++) {
      const vi = index ? index.getX(i + k) : i + k;
      const u = uv.getX(vi);
      const v = uv.getY(vi);
      if (!(u >= u0 && u <= u1 && v >= v0 && v <= v1)) inSlot = false;
    }
    if (inSlot) team++;
  }
});

const size = new THREE.Vector3();
new THREE.Box3().setFromObject(fit).getSize(size);
const HALF_H = num('zoom', size.y * 0.72);
const HALF_W = (HALF_H * W) / H;
const camera = new THREE.OrthographicCamera(
  -HALF_W,
  HALF_W,
  HALF_H,
  -HALF_H,
  0.1,
  100,
);
const CAM_YAW = YAW + (num('yaw', 0) * Math.PI) / 180;
const FOCUS_Y = num('fy', size.y * 0.5);
camera.position.set(
  Math.sin(CAM_YAW) * 20 * Math.cos(PITCH),
  FOCUS_Y + Math.sin(PITCH) * 20,
  Math.cos(CAM_YAW) * 20 * Math.cos(PITCH),
);
camera.lookAt(0, FOCUS_Y, 0);
renderer.render(scene, camera);
console.log(
  `monument: ${size.y.toFixed(2)} tall at ${FP}x${FP} (a serf is 0.85), ` +
    `${team}/${total} triangles in the team slot`,
);
