import * as THREE from 'three';
import {describe, expect, it} from 'vitest';
import * as AnimKey from './animKeyEnum.ts';
import {type CharacterVisual, updateGrip} from './characters';
import * as Gait from './gaitEnum.ts';

/**
 * The farmer's scythe is held one way and swung another: the blade is a
 * flat crescent in the snath's own plane, so the hold that lays it on the
 * grass beside him at rest stands it on edge through the mowing stroke,
 * and the hold that sweeps it flat through the stalks buries it on the
 * walk out. updateGrip is what carries the tool between the two — over
 * the same blend the clips cross on, because snapping put a visible flick
 * in the scythe at the top and tail of every stroke.
 */

type AnimKey = import('../shared/enum.ts').Enum<typeof AnimKey>;

const REST = {x: 0.35, y: Math.PI, z: -0.1};
const WORK = {x: -0.45, y: Math.PI - 0.34, z: 0.35};

/** A two-bone arm reaching along +X: shoulder at the origin, elbow a fifth
 * out, hand a fifth beyond it, and the elbow already bent — an animated arm
 * always is, and CCD from a dead-straight one is the degenerate case the
 * renderer never feeds it. */
function makeArm(root: THREE.Object3D): {
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  hand: THREE.Object3D;
} {
  const upper = new THREE.Object3D();
  const lower = new THREE.Object3D();
  const hand = new THREE.Object3D();
  lower.position.set(0.2, 0, 0);
  lower.rotation.z = 0.6;
  hand.position.set(0.2, 0, 0);
  lower.add(hand);
  upper.add(lower);
  root.add(upper);
  return {upper, lower, hand};
}

function makeVisual(): {visual: CharacterVisual; tool: THREE.Object3D} {
  const root = new THREE.Object3D();
  const tool = new THREE.Object3D();
  root.add(tool);
  tool.rotation.order = 'XZY';
  tool.rotation.set(REST.x, REST.y, REST.z);
  const visual: CharacterVisual = {
    mixer: new THREE.AnimationMixer(root),
    actions: new Map(),
    current: null,
    gait: Gait.walk,
    gaitNat: {walk: 0, jog: 0},
    gaitSpeed: 0,
    ranged: false,
    toolKind: 0,
    grip: {
      tool,
      clip: AnimKey.mow,
      rest: REST,
      work: WORK,
      t: 0,
      free: null,
      grasp: null,
    },
  };
  return {visual, tool};
}

/** The same, with a free arm and a spot on the tool to put it on. */
function makeGrasping(): {
  visual: CharacterVisual;
  hand: THREE.Object3D;
  grasp: THREE.Object3D;
  root: THREE.Object3D;
} {
  const made = makeVisual();
  const root = made.tool.parent!;
  const arm = makeArm(root);
  const grasp = new THREE.Object3D();
  grasp.position.set(0.28, 0.1, 0);
  root.add(grasp);
  made.visual.grip!.free = arm;
  made.visual.grip!.grasp = grasp;
  return {visual: made.visual, hand: arm.hand, grasp, root};
}

describe('updateGrip', () => {
  it('eases into the work hold while the work clip plays, and back out', () => {
    const {visual, tool} = makeVisual();
    visual.current = AnimKey.mow;

    // Half the blend is half the way over — not there yet, and not still
    // at rest either.
    updateGrip(visual, 0.08);
    expect(tool.rotation.x).toBeGreaterThan(WORK.x);
    expect(tool.rotation.x).toBeLessThan(REST.x);
    expect(visual.grip!.t).toBeCloseTo(0.5, 5);

    // Past the blend it settles exactly on the hold, and stays there.
    updateGrip(visual, 0.08);
    expect(tool.rotation.x).toBeCloseTo(WORK.x, 6);
    expect(tool.rotation.y).toBeCloseTo(WORK.y, 6);
    expect(tool.rotation.z).toBeCloseTo(WORK.z, 6);
    updateGrip(visual, 0.5);
    expect(visual.grip!.t).toBe(1);

    // And back to the carried hold when the stroke ends.
    visual.current = AnimKey.idle;
    updateGrip(visual, 0.5);
    expect(visual.grip!.t).toBe(0);
    expect(tool.rotation.x).toBeCloseTo(REST.x, 6);
    expect(tool.rotation.z).toBeCloseTo(REST.z, 6);
  });

  it('slides the grip down whatever haft the hold ends up on', () => {
    const {visual, tool} = makeVisual();
    visual.current = AnimKey.mow;
    updateGrip(visual, 1);
    // The offset is the slide rotated into the pose, so the haft runs
    // through the fist rather than beside it: it stays a pure slide, and
    // it points down the tool's own -Y.
    const down = new THREE.Vector3(0, -1, 0).applyEuler(tool.rotation);
    expect(tool.position.clone().normalize().dot(down)).toBeCloseTo(1, 6);
  });

  it('puts the free hand on the tool once the work clip is up', () => {
    const {visual, hand, grasp, root} = makeGrasping();
    const where = function () {
      root.updateMatrixWorld(true);
      return hand.getWorldPosition(new THREE.Vector3());
    };
    var rest = where();
    expect(rest.distanceTo(grasp.position)).toBeGreaterThan(0.05);

    // At rest the clip keeps its own arm: the reach is skipped outright.
    visual.current = AnimKey.idle;
    updateGrip(visual, 1);
    expect(where().distanceTo(rest)).toBeCloseTo(0, 6);

    // Through the stroke the hand settles on the spot.
    visual.current = AnimKey.mow;
    updateGrip(visual, 1);
    // Within a fiftieth of the arm's own length: on the real rig that is
    // the couple of hundredths of a world unit the measurements show.
    expect(where().distanceTo(grasp.position)).toBeLessThan(0.008);
  });

  it('reaches only part way while the hold is still easing in', () => {
    const {visual, hand, grasp, root} = makeGrasping();
    const start =
      (root.updateMatrixWorld(true),
      hand.getWorldPosition(new THREE.Vector3()));
    visual.current = AnimKey.mow;
    updateGrip(visual, 0.08); // half the crossfade
    root.updateMatrixWorld(true);
    var mid = hand.getWorldPosition(new THREE.Vector3());
    expect(mid.distanceTo(start)).toBeGreaterThan(0);
    expect(mid.distanceTo(grasp.position)).toBeGreaterThan(0.01);
    expect(mid.distanceTo(grasp.position)).toBeLessThan(
      start.distanceTo(grasp.position),
    );
  });

  it('is a no-op for a unit with no second hold', () => {
    const {visual} = makeVisual();
    visual.grip = undefined;
    visual.current = AnimKey.mow;
    expect(() => updateGrip(visual, 1)).not.toThrow();
  });
});
