/**
 * Scratch page: the guard tower's roof, manned two ways.
 *
 * Not a mock — it calls the same makeGlbBuilding / makeCharacter /
 * playAnimation the renderer does, and places the figures on the model's
 * own towerPost marks exactly the way BuildingSync.#syncGarrison does, so
 * what reads here is what reads on a roof in a match.
 *
 * ?t=<0..1> scrubs every clip to that fraction of its length, which is how
 * the filmstrip is shot.
 */
import * as THREE from 'three';
import { loadGlbAssets, makeGlbBuilding } from '../../src/render/assets';
import { loadCharacterAssets, makeCharacter, playAnimation } from '../../src/render/characters';
import { UNIT_DEFS } from '../../src/sim/defs/units';
import { makeLights, makeRenderer, YAW, PITCH } from './scene';
import { UnitTypeId } from '../../src/sim/defs/units';
import { BuildingTypeId } from '../../src/sim/defs/buildings';
import { AnimKey } from '../../src/render/characters';

const params = new URLSearchParams(location.search);
const t = Number(params.get('t') ?? '0');

await Promise.all([loadGlbAssets(), loadCharacterAssets()]);

const W = Number(params.get('w') ?? '1200');
const H = Number(params.get('h') ?? '620');
const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const renderer = makeRenderer(canvas);
renderer.setClearColor(0xa9c691, 1);
renderer.setSize(W, H, false);

const scene = new THREE.Scene();
makeLights(scene);
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
  new THREE.MeshStandardMaterial({ color: 0x55a02a, roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const SCRATCH = new THREE.Vector3();
const mixers: THREE.AnimationMixer[] = [];

/** One tower, manned by `kind`, at world offset x. Mirrors #syncGarrison. */
function tower(kindCode: number, clip: AnimKey.throwing | AnimKey.shoot, x: number): void {
  const root = new THREE.Group();
  root.position.x = x;
  scene.add(root);
  const model = makeGlbBuilding(BuildingTypeId.guardTower, 0);
  if (!model) throw new Error('no guardTower model');
  root.add(model);

  // The roof marks the pack ships, by name — same harvest the renderer does.
  const posts: THREE.Object3D[] = [];
  model.traverse((o) => {
    if (o.name.startsWith('towerPost')) posts.push(o);
  });
  if (posts.length === 0) throw new Error('no towerPost marks on the model');

  for (let i = 0; i < posts.length; i++) {
    const made = makeCharacter(kindCode, 0, 0);
    if (!made) throw new Error('characters not loaded');
    posts[i]!.getWorldPosition(SCRATCH);
    root.worldToLocal(SCRATCH);
    made.group.position.copy(SCRATCH);
    made.group.rotation.y = Math.atan2(SCRATCH.x, SCRATCH.z);
    root.add(made.group);
    if (made.visual) {
      playAnimation(made.visual, clip, i * 0.37);
      // Scrub to the requested phase of the clip rather than letting it run.
      const action = made.visual.actions.get(clip);
      if (action) action.time = t * action.getClip().duration;
      made.visual.mixer.update(0);
      mixers.push(made.visual.mixer);
    }
  }
}

/** One figure, turned to face the camera, scrubbed to phase `phase`. */
function figure(kindCode: number, clip: AnimKey.throwing | AnimKey.shoot, x: number, phase: number): void {
  const made = makeCharacter(kindCode, 0, 0);
  if (!made) throw new Error('characters not loaded');
  // Along the camera's screen-horizontal, not world X: under a 45-degree
  // yaw the world axes run diagonally across the frame.
  made.group.position.set(x * Math.cos(YAW), 0, -x * Math.sin(YAW));
  // Square to the camera: on a roof they face outward, which is right in a
  // match and useless for judging a motion.
  made.group.rotation.y = YAW;
  scene.add(made.group);
  if (!made.visual) return;
  playAnimation(made.visual, clip, 0);
  const action = made.visual.actions.get(clip);
  if (action) action.time = phase * action.getClip().duration;
  made.visual.mixer.update(0);
}

const strip = params.get('strip');
if (strip) {
  // The clip laid out left to right, one figure per phase.
  // ?strip=shoot lays out the archer, anything else the levy. The URL is
  // still words — it is typed by hand.
  const shooting = strip === 'shoot';
  const clip = shooting ? AnimKey.shoot : AnimKey.throwing;
  const kind = shooting ? UnitTypeId.archer : UnitTypeId.serf;
  const N = 6;
  for (let i = 0; i < N; i++) figure(kind, clip, (i - (N - 1) / 2) * 0.92, i / N);
} else {
  tower(UnitTypeId.serf, AnimKey.throwing, -1.5);
  tower(UnitTypeId.archer, AnimKey.shoot, 1.5);
}

// Framed on the two roofs rather than the towers: the stonework is not
// what is under review, the men standing on it are.
const HALF_H = Number(params.get('zoom') ?? (params.get('strip') ? '0.82' : '1.5'));
const HALF_W = (HALF_H * W) / H;
const camera = new THREE.OrthographicCamera(-HALF_W, HALF_W, HALF_H, -HALF_H, 0.1, 100);
const FOCUS_Y = Number(params.get('fy') ?? (params.get('strip') ? '0.62' : '3.15'));
camera.position.set(
  Math.sin(YAW) * 12 * Math.cos(PITCH),
  FOCUS_Y + Math.sin(PITCH) * 12,
  Math.cos(YAW) * 12 * Math.cos(PITCH),
);
camera.lookAt(0, FOCUS_Y, 0);
renderer.render(scene, camera);
(window as unknown as { LEVY_READY: boolean }).LEVY_READY = true;
console.log('rendered t=' + t + ' mixers=' + mixers.length);
