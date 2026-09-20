import * as THREE from 'three';
import {describe, expect, it} from 'vitest';
import {type CharacterVisual, updateRodLine} from './characters';

/**
 * The fishing line hangs from the rod's tip, and the pack models it as a
 * rigid node — so it inherits every rotation the rod does and has to be
 * put back upright against whatever pose the clip struck.
 *
 * It used to be put back by a constant measured once, in the hand socket's
 * frame, off the Fishing_Idle pose. That is right for exactly one pose.
 * The fisherman does not drop the rod when he stops fishing — he paces the
 * deck and carries the catch to the hut still holding it, because
 * sceneSync only stows a tool for full hands — and on those clips the
 * constant was 56, 64 and 73 degrees out. The line stood up out of the rod
 * like a wire.
 *
 * So what is pinned here is the property, not a number: whatever the hand
 * is doing, the line ends up pointing at the ground.
 */

/** A line node under a parent turned `q`, plus the visual holding it. */
function rigged(q: THREE.Quaternion): {
  visual: CharacterVisual;
  line: THREE.Object3D;
} {
  // A stand-in for the rod's own hierarchy: an arm that the clip turns,
  // and the tip node the line hangs off.
  const arm = new THREE.Object3D();
  arm.quaternion.copy(q);
  const line = new THREE.Object3D();
  arm.add(line);
  const root = new THREE.Object3D();
  root.add(arm);
  root.updateMatrixWorld(true);
  return {visual: {rodLine: line} as CharacterVisual, line};
}

/** Which way the line's own hanging axis (its -y) ends up pointing. */
function hangsToward(line: THREE.Object3D): THREE.Vector3 {
  line.updateMatrixWorld(true);
  return new THREE.Vector3(0, -1, 0)
    .transformDirection(line.matrixWorld)
    .normalize();
}

const DOWN = new THREE.Vector3(0, -1, 0);

describe('updateRodLine', () => {
  it('hangs the line straight down whatever the hand is doing', () => {
    // A spread of poses standing in for the clips he holds the rod through
    // — fishing, walking, carrying — including ones that turn the tip past
    // the horizontal, which is where the baked constant failed worst.
    const poses: [name: string, euler: THREE.Euler][] = [
      ['neutral', new THREE.Euler(0, 0, 0)],
      ['fishing-ish', new THREE.Euler(0.66, 0, -0.55)],
      ['walking-ish', new THREE.Euler(-1.2, 0.9, 0.4)],
      ['carrying-ish', new THREE.Euler(1.1, -2.2, 1.3)],
      ['upside down', new THREE.Euler(Math.PI, 0, 0)],
    ];
    for (const [name, euler] of poses) {
      const q = new THREE.Quaternion().setFromEuler(euler);
      const {visual, line} = rigged(q);
      updateRodLine(visual);
      const lean = hangsToward(line).angleTo(DOWN);
      expect((lean * 180) / Math.PI, name).toBeLessThan(0.001);
    }
  });

  it('is unmoved by a yaw, which is what made the bug look bounded', () => {
    // Turning the man about the world's up axis genuinely does not disturb
    // plumb. That is why a constant looked sufficient — the reasoning was
    // right about yaw and silent about everything else.
    for (const yaw of [0, 1, 2, 3]) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));
      const {visual, line} = rigged(q);
      updateRodLine(visual);
      expect(hangsToward(line).angleTo(DOWN)).toBeLessThan(1e-6);
    }
  });

  it('does nothing when no rod is held', () => {
    const visual = {} as CharacterVisual;
    expect(() => updateRodLine(visual)).not.toThrow();
  });
});
