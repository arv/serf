/**
 * Scratch page: the farmstead, worked.
 *
 * Not a mock — it calls the same makeGlbBuilding / makeCharacter /
 * playAnimation the renderer does, and stands the farmers on the model's
 * own mowPath marks exactly the way sceneSync's field walk does, so what
 * reads here is what reads on a farm in a match.
 *
 * ?t=<0..1> scrubs the mowing stroke to that fraction of its length;
 * ?marks=1 draws a bead on every walk mark to eyeball the circuit
 * against the rows; ?rival=1 swaps the seat to red for the team roof.
 * w/h/zoom/fy size and frame the shot, as on the other scratch pages.
 */
import * as THREE from 'three';
import {WORK} from '../../src/protocol/sabLayout';
import * as AnimKey from '../../src/render/animKeyEnum.ts';
import {loadGlbAssets, makeGlbBuilding} from '../../src/render/assets';
import {
  loadCharacterAssets,
  makeCharacter,
  playAnimation,
  setWorkTool,
} from '../../src/render/characters';
import * as BuildingTypeId from '../../src/sim/defs/buildingTypeIdEnum.ts';
import * as UnitTypeId from '../../src/sim/defs/unitTypeIdEnum.ts';
import {makeLights, makeRenderer, YAW, PITCH} from './scene';

const params = new URLSearchParams(location.search);
const t = Number(params.get('t') ?? '0.35');
const owner = params.get('rival') ? 1 : 0;

await Promise.all([loadGlbAssets(), loadCharacterAssets()]);

const W = Number(params.get('w') ?? '1200');
const H = Number(params.get('h') ?? '860');
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

const model = makeGlbBuilding(BuildingTypeId.wheatFarm, owner);
if (!model) throw new Error('no wheatFarm model');
scene.add(model);

// The walk marks, harvested by name the way buildingSync does.
const SCRATCH = new THREE.Vector3();
const path: {i: number; o: THREE.Object3D}[] = [];
let gate: THREE.Object3D | null = null;
model.traverse(o => {
  const m = /^mowPath(\d+)$/.exec(o.name);
  if (m) path.push({i: Number(m[1]), o});
  if (o.name === 'mowGate') gate = o;
});
path.sort((a, b) => a.i - b.i);
// The whole authored circuit, not just "some marks": the compositions
// below stand farmers on specific indices, and a partial harvest would
// throw there with a far less actionable error.
if (!gate || path.length < 8) {
  throw new Error(`expected mowGate + 8 mowPath marks, got ${path.length}`);
}
model.updateWorldMatrix(true, true);

if (params.get('marks') === '1') {
  const bead = new THREE.MeshBasicMaterial({color: 0xe03434});
  for (const {o} of [...path, {i: -1, o: gate}]) {
    o.getWorldPosition(SCRATCH);
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), bead);
    b.position.copy(SCRATCH);
    scene.add(b);
  }
}

/** A farmer standing on mark `at`, aimed at mark `to`, playing `clip`. */
function farmer(
  at: number,
  to: number,
  clip: AnimKey.mow | AnimKey.walk | AnimKey.idle,
  phase: number,
): void {
  const made = makeCharacter(UnitTypeId.worker, 1, owner);
  if (!made) throw new Error('characters not loaded');
  path[at]!.o.getWorldPosition(SCRATCH);
  made.group.position.copy(SCRATCH);
  path[to]!.o.getWorldPosition(SCRATCH);
  made.group.rotation.y = Math.atan2(
    SCRATCH.x - made.group.position.x,
    SCRATCH.z - made.group.position.z,
  );
  scene.add(made.group);
  if (!made.visual) return;
  setWorkTool(made.visual, WORK.mow);
  tunePose(made.visual.defaultTool);
  playAnimation(made.visual, clip, 0);
  const action = made.visual.actions.get(clip);
  if (action) action.time = phase * action.getClip().duration;
  made.visual.mixer.update(0);
}

/** One figure square to the camera at screen-x `x`, scrubbed to `phase` —
 * the filmstrip lane, straight off the levy page. */
function figure(
  clip: AnimKey.mow | AnimKey.walk | AnimKey.idle,
  x: number,
  phase: number,
): void {
  const made = makeCharacter(UnitTypeId.worker, 1, owner);
  if (!made) throw new Error('characters not loaded');
  made.group.position.set(x * Math.cos(YAW), 0, -x * Math.sin(YAW));
  made.group.rotation.y = YAW;
  scene.add(made.group);
  if (!made.visual) return;
  setWorkTool(made.visual, WORK.mow);
  tunePose(made.visual.defaultTool);
  playAnimation(made.visual, clip, 0);
  const action = made.visual.actions.get(clip);
  if (action) action.time = phase * action.getClip().duration;
  made.visual.mixer.update(0);
}

/**
 * Live knobs for the scythe's grip fix-up (packScytheProp): ?sy= slides
 * the grip along the haft, ?rx=/?rz= re-pitch about the fist — the same
 * three numbers the builder hard-codes, overridable per shot so a hold
 * can be tuned from screenshots without touching src between takes.
 */
function tunePose(tool: THREE.Object3D | undefined): void {
  const pivot = tool?.children[0];
  const inner = pivot?.children[0];
  if (!pivot || !inner) return;
  const sy = params.get('sy');
  const rx = params.get('rx');
  const rz = params.get('rz');
  if (sy !== null) inner.position.y = Number(sy);
  if (rx !== null) pivot.rotation.x = Number(rx);
  if (rz !== null) pivot.rotation.z = Number(rz);
}

const strip = params.get('strip');
if (strip) {
  model.visible = false;
  const clip =
    strip === 'walk'
      ? AnimKey.walk
      : strip === 'idle'
        ? AnimKey.idle
        : AnimKey.mow;
  const N = 6;
  for (let i = 0; i < N; i++) figure(clip, (i - (N - 1) / 2) * 0.92, i / N);
} else {
  // One mid-stroke on the front lane, one walking the middle lane, one
  // standing at the last — the three states the field walk cycles
  // through.
  farmer(0, 1, AnimKey.mow, t);
  farmer(3, 2, AnimKey.walk, 0.3);
  farmer(6, 7, AnimKey.idle, 0);
}

const HALF_H = Number(params.get('zoom') ?? (strip ? '0.82' : '2.3'));
const HALF_W = (HALF_H * W) / H;
const camera = new THREE.OrthographicCamera(
  -HALF_W,
  HALF_W,
  HALF_H,
  -HALF_H,
  0.1,
  100,
);
const FOCUS_Y = Number(params.get('fy') ?? (strip ? '0.42' : '0.55'));
camera.position.set(
  Math.sin(YAW) * 12 * Math.cos(PITCH),
  FOCUS_Y + Math.sin(PITCH) * 12,
  Math.cos(YAW) * 12 * Math.cos(PITCH),
);
camera.lookAt(0, FOCUS_Y, 0);
renderer.render(scene, camera);
(window as unknown as {FARM_READY: boolean}).FARM_READY = true;
console.log('rendered t=' + t + ' marks=' + path.length);
