import * as THREE from 'three';

/**
 * The one bit of inverse kinematics the renderer does: swing an arm so its
 * hand lands somewhere the clip did not put it.
 *
 * Two users, and they want the same three bones for opposite reasons. The
 * serf at a well has his right hand glued to a windlass handle that turns
 * on the building's clock, not his (sceneSync); the farmer has his free
 * left hand glued to the snath of the scythe in his other fist
 * (characters.ts), because the pack's two-handed slice was authored around
 * a sword's hilt and the scythe is held nothing like one.
 */

export interface ArmChain {
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  hand: THREE.Object3D;
}

/** GLTFLoader sanitizes bone names ('upperarm.r' → 'upperarmr'). */
export function findArm(
  group: THREE.Object3D,
  side: 'r' | 'l',
): ArmChain | null {
  const bone = (n: string): THREE.Object3D | undefined =>
    group.getObjectByName(n) ?? group.getObjectByName(n.replace(/[^\w-]/g, ''));
  const upper = bone(`upperarm.${side}`);
  const lower = bone(`lowerarm.${side}`);
  const hand = bone(`hand.${side}`);
  return upper && lower && hand ? {upper, lower, hand} : null;
}

const IK_B = new THREE.Vector3();
const IK_E = new THREE.Vector3();
const IK_D = new THREE.Vector3();
const IK_Q = new THREE.Quaternion();
const IK_PQ = new THREE.Quaternion();
const IK_PQI = new THREE.Quaternion();

/** One CCD step: swing `bone` so `tip` aims at `target` (world space). */
function aimBone(
  bone: THREE.Object3D,
  tip: THREE.Object3D,
  target: THREE.Vector3,
): void {
  bone.updateWorldMatrix(true, false);
  tip.updateWorldMatrix(true, false);
  bone.getWorldPosition(IK_B);
  tip.getWorldPosition(IK_E);
  IK_E.sub(IK_B);
  IK_D.copy(target).sub(IK_B);
  if (IK_E.lengthSq() < 1e-8 || IK_D.lengthSq() < 1e-8) return;
  IK_Q.setFromUnitVectors(IK_E.normalize(), IK_D.normalize());
  bone.parent!.getWorldQuaternion(IK_PQ);
  IK_PQI.copy(IK_PQ).invert();
  // local' = parent⁻¹ · Δworld · parent · local
  bone.quaternion.premultiply(IK_PQ).premultiply(IK_Q).premultiply(IK_PQI);
}

/**
 * CCD from the elbow out: a few rounds settle the hand on the target (or at
 * full stretch toward it when out of reach).
 *
 * Elbow first, and starting from the clip's own pose rather than a rest
 * pose, is what keeps the arm looking animated: each aim makes the smallest
 * turn that helps, so a target a finger's width from where the hand already
 * was moves the hand and leaves the shoulder alone. There is no pole vector
 * because there is nothing to aim one at — the elbow keeps the bend the
 * animator gave it.
 *
 * Each round closes a bit over half the remaining gap, so `rounds` buys
 * accuracy at a few quaternion multiplies apiece. Two is enough to sit a
 * hand on a windlass handle it is already beside; the farmer's free hand
 * takes more, because the gap it starts from is a whole hand's width and
 * what is left over reads as a fist beside the snath rather than on it.
 */
export function ikReach(
  arm: ArmChain,
  target: THREE.Vector3,
  rounds = 2,
): void {
  aimBone(arm.lower, arm.hand, target);
  for (let i = 0; i < rounds; i++) {
    aimBone(arm.upper, arm.hand, target);
    aimBone(arm.lower, arm.hand, target);
  }
}
