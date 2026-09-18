/**
 * Scratch page: the fisherman, rod out.
 *
 * The one thing no test can check is which way the rod points once the
 * Fishing_Idle clip has posed the hand that holds it. So this page stands
 * the same makeCharacter / setWorkTool / playAnimation the renderer does,
 * and turns the man through four quarter turns — the rod's aim is a
 * three-dimensional claim and a single yaw cannot settle it. The camera is
 * the game's own 45/35 rig.
 *
 *   pnpm dev   # then /tools/modelLab/_angler.html
 *
 * ?t=<0..1>  scrubs the clip; ?yaws=<n> how many turns across the strip;
 * ?rx=/?ry=/?rz= override the rod's own fix-up rotation live, which is how
 * the numbers in fishingPoleProp get read off a screenshot rather than
 * guessed. w/h/zoom/fy size and frame the shot, as on the other pages.
 */
import * as THREE from 'three';
import {WORK} from '../../src/protocol/sabLayout';
import * as AnimKey from '../../src/render/animKeyEnum.ts';
import {loadGlbAssets} from '../../src/render/assets';
import {
  loadCharacterAssets,
  makeCharacter,
  playAnimation,
  ROD_AIM,
  setWorkTool,
} from '../../src/render/characters';
import * as UnitTypeId from '../../src/sim/defs/unitTypeIdEnum.ts';
import {makeLights, makeRenderer, YAW, PITCH} from './scene';

const params = new URLSearchParams(location.search);
const t = Number(params.get('t') ?? '0');
const YAWS = Number(params.get('yaws') ?? '4');
/** Turn every figure this many degrees off square, on top of its own place
 * in the strip. A rod aimed straight at the camera is a dot, so the single
 * figure wants turning before it can be judged at all. */
const SPIN = (Number(params.get('spin') ?? '0') * Math.PI) / 180;

await Promise.all([loadGlbAssets(), loadCharacterAssets()]);

const W = Number(params.get('w') ?? '1400');
const H = Number(params.get('h') ?? '520');
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

/** Live knobs on the rod's fix-up wrap — the group fishingPoleProp returns.
 * Passing none leaves src exactly as written, which is what makes this page
 * usable as a before shot.
 *
 * `?raw=1` is the other end of the scale: it strips BOTH the holder's hold
 * and the wrap back to identity, which hangs the rod in the hand socket the
 * way the pack authored it — the reading the Fishing_Idle clip was animated
 * around, and the one every fix-up here is measured against.
 */
function tuneRod(tool: THREE.Object3D | undefined): THREE.Object3D | null {
  const wrap = tool?.children[0];
  if (!tool || !wrap) return null;
  if (params.get('raw') === '1') {
    tool.rotation.set(0, 0, 0);
    tool.position.set(0, 0, 0);
    wrap.rotation.set(0, 0, 0);
    return wrap.children[0] ?? null;
  }
  const rx = params.get('rx');
  const ry = params.get('ry');
  const rz = params.get('rz');
  if (rx !== null) wrap.rotation.x = Number(rx);
  if (ry !== null) wrap.rotation.y = Number(ry);
  if (rz !== null) wrap.rotation.z = Number(rz);
  // `?roll=<deg>` spins the rod about its OWN shaft, which is the one knob
  // the aim cannot set: setFromUnitVectors takes the shortest way onto
  // ROD_AIM and whatever roll falls out of that is arbitrary. This is what
  // decides which way the reel hangs and which side of the pole the line
  // runs down, so it is read off a screenshot like the rest.
  const roll = params.get('roll');
  const tilt = wrap.children[0] ?? null;
  if (roll !== null && tilt) {
    const spin = new THREE.Quaternion().setFromAxisAngle(
      ROD_AIM,
      (Number(roll) * Math.PI) / 180,
    );
    tilt.quaternion.premultiply(spin);
  }
  // Whatever the knobs moved, the line has to be dropped again afterwards —
  // and only once the clip has posed the arm, which is why this hands the
  // node back rather than doing it here. A knob-free load returns null and
  // nothing is re-hung: that shot has to be exactly what ships.
  return rx !== null || ry !== null || rz !== null || roll !== null
    ? tilt
    : null;
}

/** Drop the line plumb again after a knob has moved the rod, so a roll is
 * read off a rod whose line still falls the way the shipped one does.
 *
 * Two things differ from the same step in `fishingPoleProp`, and both bite.
 * Down is the WORLD's here, not `ROD_PLUMB` — that constant is world-down
 * expressed in the bare socket frame, which is the frame the shipped code
 * resolves in because the rod it is building has no parent yet. And this
 * must run AFTER the mixer has posed the arm: called against the bind pose
 * it cancels a rotation the clip is about to replace, and the float ends up
 * in the sky. */
function rehangLine(tilt: THREE.Object3D): void {
  const line = tilt.getObjectByName('fishing_rod_line');
  if (!line?.parent) return;
  tilt.updateMatrixWorld(true);
  const parent = new THREE.Quaternion();
  line.parent.getWorldQuaternion(parent);
  // The line falls down its own -y and we want it down the world's, and
  // those are the same axis — so the node simply wants whatever rotation it
  // has inherited cancelled.
  line.quaternion.copy(parent.invert());
}

const made: {group: THREE.Group; visual: unknown}[] = [];

/** One angler turned `spin` off square, at screen-x `x`. */
function angler(x: number, spin: number): void {
  const m = makeCharacter(UnitTypeId.worker, 0, 0);
  if (!m) throw new Error('characters not loaded');
  made.push(m);
  const made_ = m;
  made_.group.position.set(x * Math.cos(YAW), 0, -x * Math.sin(YAW));
  made_.group.rotation.y = YAW + spin;
  scene.add(made_.group);
  if (!made_.visual) return;
  setWorkTool(made_.visual, WORK.fish);
  playAnimation(made_.visual, AnimKey.fish, 0);
  const tuned = tuneRod(made_.visual.toolCustom);
  const action = made_.visual.actions.get(AnimKey.fish);
  if (action) action.time = t * action.getClip().duration;
  made_.visual.mixer.update(0);
  if (tuned) rehangLine(tuned);
}

for (let i = 0; i < YAWS; i++) {
  angler((i - (YAWS - 1) / 2) * 1.3, SPIN + (i * Math.PI * 2) / YAWS);
}

// The made figures, for measuring an aim from the console rather than
// squinting at a screenshot: which way the shaft actually points is a
// number, and this page exists to get it right.
(window as unknown as {ANGLERS: unknown[]}).ANGLERS = made;

const HALF_H = Number(params.get('zoom') ?? '1.15');
const HALF_W = (HALF_H * W) / H;
const camera = new THREE.OrthographicCamera(
  -HALF_W,
  HALF_W,
  HALF_H,
  -HALF_H,
  0.1,
  100,
);
const FOCUS_Y = Number(params.get('fy') ?? '0.75');
camera.position.set(
  Math.sin(YAW) * 12 * Math.cos(PITCH),
  FOCUS_Y + Math.sin(PITCH) * 12,
  Math.cos(YAW) * 12 * Math.cos(PITCH),
);
camera.lookAt(0, FOCUS_Y, 0);
renderer.render(scene, camera);
(window as unknown as {ANGLER_READY: boolean}).ANGLER_READY = true;
console.log('rendered t=' + t + ' yaws=' + YAWS);
