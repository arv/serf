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
import type {
  AnimKey as AnimKeyType,
  CharacterVisual,
} from '../../src/render/characters';
import {
  loadCharacterAssets,
  makeCharacter,
  playAnimation,
  ROD_AIM,
  ROD_GUIDES,
  ROD_LINE_STRETCH,
  setWorkTool,
  updateRodLine,
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
/**
 * Which clip to stand him in. The rod does not leave his hand when he stops
 * fishing — he paces the deck and walks the catch to the hut still holding
 * it (sceneSync only stows a tool for full hands) — so the walk and the
 * idle are as much a part of "how he holds it" as the fishing pose, and
 * they are where a line hung by a baked constant went visibly wrong.
 */
const CLIPS: Record<string, AnimKeyType> = {
  fish: AnimKey.fish,
  walk: AnimKey.walk,
  jog: AnimKey.jog,
  idle: AnimKey.idle,
  carry: AnimKey.carryIdle,
};
const CLIP = CLIPS[params.get('clip') ?? 'fish'] ?? AnimKey.fish;

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
 * `?raw=1` is the other end of the scale: it undoes everything
 * `fishingPoleProp` did — the hold, the wrap that cancels it, the aim and
 * grip slide on `tilt`, the line's own plumb quaternion and its stretch —
 * and hangs the rod in the hand socket the way the pack ships it. That is
 * the reading Fishing_Idle was animated around, and the one every
 * correction here is measured against, so it has to be the WHOLE way back:
 * a `raw` that left the aim on would be a before shot of the after.
 */
function tuneRod(tool: THREE.Object3D | undefined): THREE.Object3D | null {
  const wrap = tool?.children[0];
  if (!tool || !wrap) return null;
  if (params.get('raw') === '1') {
    tool.rotation.set(0, 0, 0);
    tool.position.set(0, 0, 0);
    wrap.rotation.set(0, 0, 0);
    wrap.position.set(0, 0, 0);
    const bare = wrap.children[0];
    if (bare) {
      bare.quaternion.identity();
      bare.position.set(0, 0, 0);
      const line = bare.getObjectByName('fishing_rod_line');
      if (line) {
        line.quaternion.identity();
        line.scale.y /= ROD_LINE_STRETCH;
        for (const name of ['fishing_rod_floater', 'fishing_rod_hook']) {
          const o = bare.getObjectByName(name);
          if (o) o.scale.y *= ROD_LINE_STRETCH;
        }
      }
    }
    // Nothing to re-hang: a bare rod's line is meant to sit where the pack
    // put it, slant and all.
    return null;
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

const made: {group: THREE.Group; visual: CharacterVisual}[] = [];

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
  playAnimation(made_.visual, CLIP, 0);
  const tuned = tuneRod(made_.visual.toolCustom);
  const action = made_.visual.actions.get(CLIP);
  if (action) action.time = t * action.getClip().duration;
  made_.visual.mixer.update(0);
  // Exactly what sceneSync does every frame, and for the same reason: the
  // line answers to gravity, not to the hand. A page that skipped it would
  // be judging a rod the renderer never draws.
  updateRodLine(made_.visual);
  if (tuned) rehangLine(tuned);
}

for (let i = 0; i < YAWS; i++) {
  angler((i - (YAWS - 1) / 2) * 1.3, SPIN + (i * Math.PI * 2) / YAWS);
}

// The made figures, for poking at from the console.
(window as unknown as {ANGLERS: unknown[]}).ANGLERS = made;

/**
 * What the page is actually for. Squinting at a screenshot settles nothing:
 * a rod aimed at the camera and a rod aimed down the man's nose draw the
 * same, and a fist a finger's width off the haft draws like a fist holding
 * it. So measure the posed world and print it.
 *
 * `aim` is the shaft (grip node to line node) against the man's own forward
 * and right; `fistR`/`fistL` are each handslot's perpendicular distance from
 * the shaft's line, which is the number that says whether he is holding the
 * thing; `guideFace` says which way the guides and reel point.
 *
 * The line is reported twice, and the second one is the one that matters.
 * Its plumb is baked once by `fishingPoleProp`, so it is exact only at the
 * pose it was measured at and leans a little as Fishing_Idle sways the
 * wrist. A single frame would therefore flatter it, so this scans the whole
 * clip and reports the worst frame alongside the current one.
 */
function measure(made_: {group: THREE.Group}): Record<string, number | string> {
  made_.group.updateWorldMatrix(true, true);
  const at = (name: string): THREE.Vector3 => {
    const o = made_.group.getObjectByName(name)!;
    return o.getWorldPosition(new THREE.Vector3());
  };
  const grip = at('fishing_rod');
  const tip = at('fishing_rod_line');
  const shaft = tip.clone().sub(grip).normalize();
  const yaw = made_.group.rotation.y;
  const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  const missBy = (name: string): number => {
    const v = at(name).sub(grip);
    return v.addScaledVector(shaft, -v.dot(shaft)).length();
  };
  const drop = at('fishing_rod_hook').sub(tip);
  const rod = made_.group.getObjectByName('fishing_rod')!;
  // ROD_GUIDES itself, not a copy of its numbers: a second literal here
  // would let the lab go on reporting the old roll after a recalibration
  // moved the renderer's, which is precisely the drift this page exists to
  // catch.
  const guides = ROD_GUIDES.clone().transformDirection(rod.matrixWorld);
  const deg = (r: number): number =>
    Math.round(((r * 180) / Math.PI) * 10) / 10;
  const round = (n: number): number => Math.round(n * 1000) / 1000;
  return {
    aimOffForwardDeg: deg(Math.atan2(shaft.dot(right), shaft.dot(fwd))),
    aimElevationDeg: deg(Math.asin(shaft.y)),
    fistRmiss: round(missBy('handslotr')),
    fistLmiss: round(missBy('handslotl')),
    lineOffPlumbDeg: deg(Math.atan2(Math.hypot(drop.x, drop.z), -drop.y)),
    guideFace: guides.y > 0 ? 'up' : 'down',
  };
}

/**
 * The worst the line leans, in degrees, across every clip he can hold the
 * rod through — and a couple he cannot, as insurance.
 *
 * Sweeping Fishing_Idle alone is what let a standing-up line ship: the
 * line was corrected by a constant measured in the hand socket's frame,
 * true only for the pose it was measured at. Inside Fishing_Idle that read
 * 2.7 degrees and looked safe; on the walk back down the pier the same
 * constant was 56 degrees out, and on a plain idle 73.
 *
 * What the renderer can actually put a rod in is narrower than it looks.
 * `sceneSync` stows the tool whenever the man is carrying (`heldCarry ?
 * TOOL_STOWED : workKind`), so the carry clips never hold one; and the
 * worker's spec sets no `jog`, so `gaitAnimKey` only ever answers `walk`.
 * That leaves three. The other two are swept anyway and named for what
 * they are: the correction should hold for ANY pose, they cost two frames
 * of scrubbing, and if a fisherman is ever taught to jog or to carry his
 * rod home they are already covered.
 */
const FISHERMAN_CLIPS = [AnimKey.fish, AnimKey.walk, AnimKey.idle] as const;
/** Poses no rod-holding fisherman reaches today — stress cases, not
 * evidence about the live renderer. */
const STRESS_CLIPS = [AnimKey.jog, AnimKey.carryIdle] as const;

function worstLineLean(made_: {
  group: THREE.Group;
  visual: CharacterVisual;
}): number {
  // Put the page back exactly as it was found: the clip, its time, and its
  // weight. Restoring through playAnimation instead would rewind to zero
  // and crossfade, so a `?t=0.3` shot would silently render frame zero
  // blended with whatever the sweep ended on — measuring one frame and
  // photographing another.
  const heldKey = made_.visual.current;
  const heldAction =
    heldKey !== null ? made_.visual.actions.get(heldKey) : null;
  const heldTime = heldAction?.time ?? 0;
  const heldWeight = heldAction?.getEffectiveWeight() ?? 1;

  const tip = new THREE.Vector3();
  const hook = new THREE.Vector3();
  let worst = 0;
  for (const key of [...FISHERMAN_CLIPS, ...STRESS_CLIPS]) {
    const action = made_.visual.actions.get(key);
    if (!action) continue;
    for (const other of made_.visual.actions.values()) other.stop();
    action.reset().play();
    const {duration} = action.getClip();
    for (let i = 0; i < 16; i++) {
      action.time = (i / 16) * duration;
      made_.visual.mixer.update(0);
      updateRodLine(made_.visual);
      made_.group.updateWorldMatrix(true, true);
      made_.group.getObjectByName('fishing_rod_line')!.getWorldPosition(tip);
      made_.group.getObjectByName('fishing_rod_hook')!.getWorldPosition(hook);
      const d = hook.clone().sub(tip);
      worst = Math.max(worst, Math.atan2(Math.hypot(d.x, d.z), -d.y));
    }
  }

  for (const other of made_.visual.actions.values()) other.stop();
  if (heldAction) {
    heldAction.reset().play();
    heldAction.time = heldTime;
    heldAction.setEffectiveWeight(heldWeight);
  }
  made_.visual.current = heldKey;
  made_.visual.mixer.update(0);
  updateRodLine(made_.visual);
  made_.group.updateWorldMatrix(true, true);
  return Math.round(((worst * 180) / Math.PI) * 100) / 100;
}

// The first figure stands square, so its numbers are the ones to read; the
// rest only differ by the turn the strip gives them.
const READING = made[0]
  ? {...measure(made[0]), lineOffPlumbWorstAnyClipDeg: worstLineLean(made[0])}
  : null;
(window as unknown as {ANGLER_READING: unknown}).ANGLER_READING = READING;

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
console.log(
  'rendered t=' +
    t +
    ' yaws=' +
    YAWS +
    ' clip=' +
    (params.get('clip') ?? 'fish'),
);
if (READING) console.table(READING);
