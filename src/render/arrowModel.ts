import * as THREE from 'three';
import * as GoodId from '../sim/defs/goodIdEnum.ts';
import {goodColors} from './palette';

/**
 * The arrow, in world units — one model for the arrow in flight
 * (arrows.ts) and the one nocked on an archer's string (characters.ts),
 * so what leaves the bow is what was on it. Its own module because the
 * two owners import each other's neighbours: arrows.ts reads
 * TARGET_HEIGHT from characters.ts, and characters.ts pulling the model
 * back out of arrows.ts would close that loop at module-evaluation
 * time.
 */

const shaftMaterial = new THREE.MeshLambertMaterial({color: 0x8a6a42});
const headMaterial = new THREE.MeshLambertMaterial({
  color: goodColors[GoodId.sword],
});
const fletchMaterial = new THREE.MeshLambertMaterial({
  color: 0xe4ddc4,
  side: THREE.DoubleSide,
});

/** Tip to tail end, world units — where the nock sits behind the tip. */
export const ARROW_LENGTH = 0.52;

/**
 * The arrow model, built once and cloned per pool entry so every clone
 * shares geometry and materials (the spearProp economy). Authored tip at
 * the origin, shaft hanging down -Y: the flight math tracks the tip, and
 * pointing +Y along the velocity is then the whole orientation.
 *
 * Sized with the same chibi exaggeration the hand tools wear — a true
 * arrow against these bodies would vanish at village zoom.
 */
let arrowTemplate: THREE.Group | null = null;

export function makeArrow(): THREE.Group {
  if (arrowTemplate) return arrowTemplate.clone();
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.016, 0.016, 0.43, 5),
    shaftMaterial,
  );
  shaft.position.y = -0.305;
  const head = new THREE.Mesh(
    new THREE.ConeGeometry(0.035, 0.09, 5),
    headMaterial,
  );
  head.position.y = -0.045;
  g.add(shaft, head);
  // Two crossed vanes at the tail. Planes, not solids: seen edge-on they
  // thin to a line exactly the way feathers do.
  for (const half of [0, 1]) {
    const vane = new THREE.Mesh(
      new THREE.PlaneGeometry(0.085, 0.13),
      fletchMaterial,
    );
    vane.position.y = -0.45;
    vane.rotation.y = half * (Math.PI / 2);
    g.add(vane);
  }
  arrowTemplate = g;
  return g.clone();
}
