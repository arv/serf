import * as THREE from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import * as UnitTypeId from '../sim/defs/unitTypeIdEnum.ts';
import * as AnimKeyNs from './animKeyEnum.ts';
import {
  type AnimKey,
  makeCharacter,
  playAnimation,
  setWorkTool,
} from './characters';
import {makeCarryProp} from './models';

/**
 * A villager, frozen: one pose of the rig baked down to a plain static
 * geometry, for the things that want a person's shape without a person.
 *
 * Why bake rather than stand a paused character there. A monument is a
 * building, and a building is a template that is cloned per instance and
 * dressed by the same mill every other building goes through — UV-mapped
 * into the pack atlas, split for team colour, scaled by footprint. A
 * SkinnedMesh cannot ride that: it carries a skeleton and a mixer of its
 * own, its vertices live in bind space until the shader skins them, and
 * every clone of it is a second skeleton to update. Bake the pose once and
 * what comes out is a lump of geometry the building pipeline cannot tell
 * from a wall.
 *
 * The figure is the pack's own serf — the Rogue body every hauler in the
 * valley wears — so a statue of a serf is that serf, not a sculptor's
 * impression of him.
 */

/** A pose to cut the figure from: a clip, a moment in it, and a load. */
export interface StatuePose {
  clip: AnimKey;
  /** How far into the clip the chisel stopped, 0..1 of its duration. */
  phase: number;
  /** Carry code of the load in his arms (GOODS index + 1; 0 = empty). */
  load: number;
  /** WORK.* kind whose tool he holds (0 = none) — the same swap sceneSync
   * makes when a villager reaches a work site. */
  tool?: number;
  /**
   * Chin lift, in radians on the head bone, applied after the clip is
   * sampled. The sculptor's one liberty: every clip in the library is
   * authored for a man watching his own work, and a monument whose subject
   * studies his boots is a monument to nothing. Nothing downstream animates
   * this figure again, so a bone moved here stays moved.
   */
  lift?: number;
}

/**
 * The serf as the valley would raise him: standing with a load in his arms,
 * chin up.
 *
 * Every choice here was made against the alternatives on the lab page
 * (tools/modelLab/_monument.ts), at the camera angle a match uses:
 *
 * - The carry-idle stance over the walk cycle, which plants one boot over
 *   the edge of the socle, and over the plain idle, whose empty hands make
 *   a mannequin of a figure this stylized.
 * - Timber over the wheat sack. Gilded, the sack loses its drawstring and
 *   its slump and comes out a smooth slab against the body; the log bundle
 *   keeps its round ends and its stack, and reads as a load from across the
 *   valley.
 * - The chin. Every clip in the library is authored for a man watching his
 *   own work: unlifted, the statue studies its boots and the face is lost
 *   under the hair from every angle the game ever shows it.
 */
export const SERF_AT_REST: StatuePose = {
  clip: AnimKeyNs.carryIdle,
  phase: 0.5,
  load: 3, // wood — the log bundle a serf hauls out of the woodcutter
  lift: (22 * Math.PI) / 180,
};

/**
 * The lord, for the other statue a village raises: the knight body, armed
 * and helmeted, caught at the top of the chop where the sword is up and the
 * shield across him — the one moment in the whole clip library where a
 * figure stands square with a weapon raised. His own idle holds the sword
 * out sideways, which reaches past the pedestal and loses the blade against
 * the ground behind it.
 *
 * The load is a hauler's, so he carries none; the chin comes up further
 * than the serf's because a helmet's brow hides more of a face than hair
 * does.
 */
export const LORD_AT_ARMS: StatuePose = {
  clip: AnimKeyNs.attack,
  phase: 0.2,
  load: 0,
  lift: (26 * Math.PI) / 180,
};

/**
 * The abbot, for the village that raises its monument to the studying
 * rather than the carrying: the Lorekeeper body (FIGURE_LOREKEEPER), staff
 * in hand, on the plain idle.
 *
 * The idle rather than the carry-idle the serf takes, because the argument
 * against it there does not hold here: an idle's empty hands make a
 * mannequin of a figure with nothing to hold, and this one is holding a
 * staff. It also leaves the stoop the body is modeled with intact, which
 * is the reading — a man bent over his books, not a lord at ease.
 *
 * No load and no tool: a bundle of timber in a scholar's arms is a joke,
 * and the pack's own staff is already in his right hand.
 *
 * The chin comes up least of the three. The serf's is lifted 22 degrees
 * and the lord's 26 to get a face out from under hair and a helmet brow;
 * this one wears glasses on a bare head, which hide nothing, and lifting
 * him further straightens the very stoop that makes him legible.
 */
export const ABBOT_AT_STUDY: StatuePose = {
  clip: AnimKeyNs.idle,
  phase: 0.5,
  load: 0,
  lift: (14 * Math.PI) / 180,
};

/**
 * Bake one pose of a villager into a single static geometry, feet on y=0,
 * standing on the origin, exactly 1 tall — so a caller sizes the figure by
 * scaling and nothing here has to know how big a monument is.
 *
 * Null until both packs are loaded: the characters (the body and its clips)
 * and the building pack (the load in his arms comes from the same props the
 * carriers use). Callers fall back the way every other pack model does.
 */
export function makeStatueGeometry(
  pose: StatuePose = SERF_AT_REST,
  kind: number = UnitTypeId.serf,
): THREE.BufferGeometry | null {
  const made = makeCharacter(kind, 0, 0);
  if (!made) return null;
  const {group, visual} = made;

  if (pose.tool) setWorkTool(visual, pose.tool);

  if (pose.load > 0 && visual.carryAnchor) {
    const load = makeCarryProp(pose.load);
    // Placed exactly the way sceneSync hangs a carried good: position
    // zeroed on the chest anchor, the prop's own inner node standing it
    // off the palms. A load posed any other way is a load in the wrong
    // hands.
    if (load) {
      load.position.set(0, 0, 0);
      visual.carryAnchor.add(load);
    }
  }

  // Strike the pose and stop the clock on it. playAnimation starts the
  // action; the mixer has to be stepped once for the bones to actually
  // move, and stepping it by 0 after setting the time samples that exact
  // frame rather than one dt past it.
  playAnimation(visual, pose.clip, 0);
  const action = visual.actions.get(pose.clip);
  if (!action) return null;
  action.time = pose.phase * action.getClip().duration;
  visual.mixer.update(0);
  // After the mixer, not before: sampling the clip writes every bone the
  // track touches, head included.
  if (pose.lift) {
    const head = group.getObjectByName('head');
    if (head) head.rotation.x -= pose.lift;
  }
  group.updateMatrixWorld(true);

  const parts: THREE.BufferGeometry[] = [];
  const toRoot = new THREE.Matrix4();
  group.traverse(o => {
    if (!(o instanceof THREE.Mesh)) return;
    // A hidden mesh is hidden for a reason — the wardrobe switches capes
    // and hats off by name — and a statue of a serf should be a statue of
    // the serf the village sees.
    for (let p: THREE.Object3D | null = o; p; p = p.parent) {
      if (!p.visible) return;
    }
    toRoot.copy(group.matrixWorld).invert().multiply(o.matrixWorld);
    parts.push(
      o instanceof THREE.SkinnedMesh
        ? skinnedGeometry(o, toRoot)
        : staticGeometry(o.geometry, toRoot),
    );
  });
  if (parts.length === 0) return null;

  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  if (!merged) return null;
  return stand(merged);
}

/**
 * Skin one mesh by hand, into world-of-the-figure space.
 *
 * three does this on the GPU and exposes it per vertex as
 * `applyBoneTransform`, which walks the skeleton again for every vertex and
 * hands back positions only. A statue needs normals too — recomputing them
 * from the baked triangles would smooth over exactly the creases the pack
 * authored — so the skinning matrix is accumulated here and applied to
 * both. Same arithmetic as the shader: the bind pose into each bone's
 * current frame, weighted, then back out of bind space.
 */
function skinnedGeometry(
  m: THREE.SkinnedMesh,
  toRoot: THREE.Matrix4,
): THREE.BufferGeometry {
  const geo = m.geometry;
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const six = geo.getAttribute('skinIndex');
  const swt = geo.getAttribute('skinWeight');
  const {bones, boneInverses} = m.skeleton;
  const boneMat = bones.map((b, i) =>
    new THREE.Matrix4().multiplyMatrices(b.matrixWorld, boneInverses[i]!),
  );

  const skin = new THREE.Matrix4();
  const full = new THREE.Matrix4();
  const rot = new THREE.Matrix3();
  const v = new THREE.Vector3();
  const outPos = new Float32Array(pos.count * 3);
  const outNrm = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    // Weighted sum of the four influencing bones, element by element —
    // matrices add like this because skinning is a blend of transforms,
    // not a composition of them.
    const e = skin.elements;
    e.fill(0);
    for (let k = 0; k < 4; k++) {
      const w = swt.getComponent(i, k);
      if (w === 0) continue;
      const be = boneMat[six.getComponent(i, k)]!.elements;
      for (let j = 0; j < 16; j++) e[j]! += be[j]! * w;
    }
    full
      .copy(toRoot)
      .multiply(m.bindMatrixInverse)
      .multiply(skin)
      .multiply(m.bindMatrix);
    v.fromBufferAttribute(pos, i).applyMatrix4(full);
    outPos[i * 3] = v.x;
    outPos[i * 3 + 1] = v.y;
    outPos[i * 3 + 2] = v.z;
    if (nrm) {
      // The rig scales uniformly, so the rotation block transforms normals
      // as-is once renormalized — no inverse-transpose needed.
      rot.setFromMatrix4(full);
      v.fromBufferAttribute(nrm, i).applyMatrix3(rot).normalize();
      outNrm[i * 3] = v.x;
      outNrm[i * 3 + 1] = v.y;
      outNrm[i * 3 + 2] = v.z;
    }
  }
  return plain(outPos, outNrm, geo.getIndex());
}

/** The same, for a mesh with no skeleton — the load in his arms. */
function staticGeometry(
  geo: THREE.BufferGeometry,
  toRoot: THREE.Matrix4,
): THREE.BufferGeometry {
  const out = geo.clone();
  out.applyMatrix4(toRoot);
  const pos = out.getAttribute('position');
  const nrm = out.getAttribute('normal');
  const baked = plain(
    pos.array as Float32Array,
    (nrm?.array as Float32Array | undefined) ?? new Float32Array(pos.count * 3),
    out.getIndex(),
  );
  out.dispose();
  return baked;
}

/**
 * Position and normal and nothing else, un-indexed.
 *
 * The parts come off the rig carrying skin weights, UVs and (on the load)
 * a second UV set, and merging is an all-or-nothing match on the attribute
 * list. Everything but the shape is dead weight here anyway: the atlas UVs
 * are written afresh by the ramp pass that paints the monument, and one
 * statue is a template that is cloned, so the vertices an un-indexed bake
 * duplicates are paid for once.
 */
function plain(
  pos: Float32Array,
  nrm: Float32Array,
  index: THREE.BufferAttribute | null,
): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  if (index) geo.setIndex(index.clone());
  const flat = geo.toNonIndexed();
  geo.dispose();
  return flat;
}

/**
 * Stand the figure up for the caller: feet on y=0, 1 unit tall, and the
 * FEET on the origin — not the bounding box, which a load held out in
 * front drags forward. Centering on the box put the man a load's-worth
 * behind the middle of his own pedestal.
 */
function stand(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const pos = geo.getAttribute('position');
  // The soles: everything in the bottom twentieth of the figure, which on
  // a standing pose is boot and nothing else.
  const cut = bb.min.y + (bb.max.y - bb.min.y) * 0.05;
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > cut) continue;
    x0 = Math.min(x0, pos.getX(i));
    x1 = Math.max(x1, pos.getX(i));
    z0 = Math.min(z0, pos.getZ(i));
    z1 = Math.max(z1, pos.getZ(i));
  }
  geo.translate(-(x0 + x1) / 2, -bb.min.y, -(z0 + z1) / 2);
  const s = 1 / Math.max(bb.max.y - bb.min.y, 1e-6);
  geo.scale(s, s, s);
  geo.computeBoundingBox();
  return geo;
}
