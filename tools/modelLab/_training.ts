/**
 * Scratch page: the training cue on the three buildings that train.
 *
 * Not a mock at any level — it stands real `BuildingSnap`s in a real
 * `BuildingSync` and lets it run, so what is on the screen is the whole
 * chain the match draws: the decor `assets.ts` dresses each model with, the
 * rig `buildingSync` harvests off it, the level it eases, and the chimney
 * smoke it stands on the brazier's flue. Change the cue and this changes
 * with it; break the wiring and this goes dark.
 *
 *   pnpm dev   # then /tools/modelLab/_training.html
 *
 * `?cold=1` empties the queues — the other half of the judgement, since the
 * cue has to read as a DIFFERENCE and not merely as decoration. `?pair=1`
 * stands each building beside a cold copy of itself, which is that
 * comparison in one frame. `?t=<seconds>` freezes the clock at a moment
 * (the whole cue is periodic, so this is repeatable) instead of running it;
 * `?warm=<seconds>` runs it up before the freeze, because the level EASES
 * and a cold start caught at t=0 shows nothing. `?hide=spill|pane` drops
 * one layer of the glow. `?only=barracks|range|castle` blows one up, and
 * `?yaw`/`?zoom`/`?fy`/`?w`/`?h`/`?gap` frame the shot as on every other
 * page here — and turn the camera before judging this one, since the
 * windows on the far side are lit too.
 */
import * as THREE from 'three';
import type {BuildingSnap} from '../../src/protocol/messages';
import * as StaffingState from '../../src/protocol/staffingStateEnum.ts';
import {loadGlbAssets} from '../../src/render/assets';
import {BuildingSync} from '../../src/render/buildingSync';
import {HeightField} from '../../src/render/heightField';
import * as BuildingState from '../../src/sim/buildingStateEnum.ts';
import {buildingDef} from '../../src/sim/defs/buildings';
import * as BuildingTypeId from '../../src/sim/defs/buildingTypeIdEnum.ts';
import * as UnitTypeId from '../../src/sim/defs/unitTypeIdEnum.ts';
import {makeLights, makeRenderer, PITCH} from './scene';

const params = new URLSearchParams(location.search);
const num = (name: string, fallback: number): number => {
  const v = Number(params.get(name) ?? NaN);
  return Number.isFinite(v) ? v : fallback;
};

await loadGlbAssets();

const W = num('w', 1400);
const H = num('h', 560);
const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const renderer = makeRenderer(canvas);
renderer.setClearColor(0xa9c691, 1);
renderer.setSize(W, H, false);

const scene = new THREE.Scene();
makeLights(scene);

/** Flat ground the buildings stand on: this page is about what a building
 * wears, not about the terrain under it. */
const SIZE = 64;
const heights = new HeightField(new Float32Array(SIZE * SIZE), SIZE);
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshStandardMaterial({color: 0x55a02a, roughness: 1}),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const BY_NAME = {
  barracks: BuildingTypeId.barracks,
  range: BuildingTypeId.archeryRange,
  castle: BuildingTypeId.storehouse,
};
const only = params.get('only') as keyof typeof BY_NAME | null;
const TYPES = only
  ? [BY_NAME[only]]
  : [
      BuildingTypeId.barracks,
      BuildingTypeId.archeryRange,
      BuildingTypeId.storehouse,
    ];
const pair = params.get('pair') === '1';
const cold = params.get('cold') === '1';

/** What each building is busy with, in the sim's own words: a started
 * course at the two halls, a serf hire at the castle. */
function busy(type: number): Partial<BuildingSnap> {
  if (type === BuildingTypeId.storehouse) {
    return {hireQueue: 1, hireProgress01: 0.4};
  }
  const unit =
    type === BuildingTypeId.archeryRange
      ? UnitTypeId.archer
      : UnitTypeId.knight;
  return {
    trainQueue: [
      {unit, started: true, progress01: 0.45},
      {unit, started: false},
    ],
  };
}

const GAP = num('gap', 5.4);
const MID = SIZE / 2;
const snaps: BuildingSnap[] = [];
let slot = 0;
const slots = TYPES.length * (pair ? 2 : 1);
for (const type of TYPES) {
  for (const running of pair ? [false, !cold] : [!cold]) {
    const def = buildingDef(type);
    const t = (slot - (slots - 1) / 2) * GAP;
    slot++;
    // Laid out along the camera's screen-horizontal, so a row of buildings
    // reads as a row rather than as a diagonal marching away.
    const x = Math.round(MID + t * Math.SQRT1_2 - def.w / 2);
    const y = Math.round(MID - t * Math.SQRT1_2 - def.h / 2);
    snaps.push({
      id: slot,
      type,
      owner: 0,
      x,
      y,
      w: def.w,
      h: def.h,
      hp: def.hp,
      maxHp: def.hp,
      state: BuildingState.built,
      staffing: StaffingState.staffed,
      stock: {},
      inputs: {},
      inbound: {},
      reservedOut: {},
      ...(running ? busy(type) : {}),
    });
  }
}

const buildings = new BuildingSync(scene, heights);
buildings.update(snaps);

const yaw = (num('yaw', 45) * Math.PI) / 180;
const HALF_H = num('zoom', only ? 2.4 : 3.1);
const HALF_W = (HALF_H * W) / H;
const camera = new THREE.OrthographicCamera(
  -HALF_W,
  HALF_W,
  HALF_H,
  -HALF_H,
  0.1,
  200,
);
const FOCUS_Y = num('fy', 1.5);
camera.position.set(
  MID + Math.sin(yaw) * 60 * Math.cos(PITCH),
  FOCUS_Y + Math.sin(PITCH) * 60,
  MID + Math.cos(yaw) * 60 * Math.cos(PITCH),
);
camera.lookAt(MID, FOCUS_Y, MID);

/** Run the cue up to speed before anything is looked at: the level eases,
 * and it starts dark. */
const warm = num('warm', 6);
const STEP = 1 / 60;
for (let i = 0; i < Math.round(warm / STEP); i++) buildings.frame(STEP);

/**
 * `?hide=spill|pane` drops one of the cue's two layers.
 *
 * It is here because it earned its place: the spills were invisible once
 * (hung inside the recess, where the depth test ate them) and later were
 * visible in the wrong place (hung in mid-air beside the castle's towers),
 * and a shot with one layer removed is what told those apart from a pane
 * problem in a single look.
 */
const hide = params.get('hide');
if (hide) {
  const doomed: THREE.Object3D[] = [];
  const name = hide === 'spill' ? 'windowSpill' : 'windowPane';
  scene.traverse(o => {
    if (o.name === name) doomed.push(o);
  });
  for (const o of doomed) o.parent?.remove(o);
}
// How many openings each model gave up, which is the number to watch when
// a void paint is added (see VoidPaint): the range went from four to ten.
let panes = 0;
scene.traverse(o => {
  if (o.name === 'windowPane') panes++;
});
console.log('lit windows: ' + panes);

const frozen = params.get('t');
if (frozen !== null) {
  // Stepped at the frame rate rather than jumped in one dt: the level is
  // integrated, so a single half-second step is not the picture the sixty
  // steps are. That makes `?t` repeatable, which is what lets a series of
  // them be shot frame by frame and cut together.
  for (let i = 0; i < Math.round(Number(frozen) / STEP); i++) {
    buildings.frame(STEP);
  }
  renderer.render(scene, camera);
  console.log('rendered t=' + frozen);
} else {
  let last = performance.now();
  const loop = (): void => {
    const now = performance.now();
    buildings.frame(Math.min(0.05, (now - last) / 1000));
    last = now;
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };
  loop();
  console.log('running');
}
