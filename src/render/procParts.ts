import * as THREE from 'three';
import type {PropFactory} from './assets';
import {wood, woodLight} from './palette';

/**
 * Hand-built dressing for buildings the KayKit pack has no model of.
 *
 * It lives apart from models.ts on purpose: assets.ts places these while it
 * assembles the GLB templates, and models.ts already imports assets.ts, so
 * putting them there would close an import cycle. Nothing here loads.
 *
 * Everything is authored in a building's unit-square space — the same space
 * BUILDING_DECOR positions in — so a part is sized as a fraction of the
 * footprint and scales with it.
 */

function part(geo: THREE.BufferGeometry, color: number): THREE.Mesh {
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({color}));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/**
 * A fish, lying along +x: diamond body, forked tail, one dark eye. `len` is
 * nose-to-tail in unit-square units.
 */
export function makeFish(len = 0.2): THREE.Group {
  const g = new THREE.Group();
  // Painted blue-grey rather than bare silver: at village zoom a pale fish
  // washes out against the roof it stands on.
  const body = part(new THREE.OctahedronGeometry(len * 0.5, 0), 0x8aa7b5);
  body.scale.set(1, 0.56, 0.4);
  g.add(body);

  const tail = part(
    new THREE.ConeGeometry(len * 0.24, len * 0.28, 4),
    0x8aa7b5,
  );
  tail.rotation.z = Math.PI / 2;
  tail.scale.set(1, 1, 0.55);
  tail.position.x = -len * 0.56;
  g.add(tail);

  for (const sz of [-1, 1]) {
    const fin = part(
      new THREE.ConeGeometry(len * 0.13, len * 0.16, 3),
      0x6f8894,
    );
    fin.rotation.x = (sz * Math.PI) / 2;
    fin.position.set(-len * 0.05, 0, sz * len * 0.06);
    g.add(fin);
  }

  const eye = part(new THREE.SphereGeometry(len * 0.05, 5, 4), 0x241c16);
  eye.position.set(len * 0.24, len * 0.06, len * 0.07);
  g.add(eye);
  return g;
}

/**
 * The fishery's sign: a fish on a mast, standing where the pack put a whole
 * sailing ship on the roof.
 *
 * The ship was the wrong tell twice over — it read as a toy on a shelf at
 * village zoom, and it said shipwright rather than fisherman. A fish says
 * one thing at any distance, which is all a roof ornament is for.
 *
 * It is mounted like a weathervane rather than hung from a bracket: a
 * hanging sign needs to be read from the side, and the camera looks down at
 * 35 degrees. Broadside-on and above the ridge, the silhouette survives the
 * angle.
 */
export function makeFishSign(len = 0.32, prop?: PropFactory): THREE.Group {
  const g = new THREE.Group();
  // Short post: the fish is a roof ornament, not a mast. Standing it high
  // reads as a weathervane on a pole and takes the eye off the building.
  const post = part(
    new THREE.CylinderGeometry(len * 0.06, len * 0.08, len * 0.42, 6),
    wood,
  );
  post.position.y = len * 0.21;
  g.add(post);

  const collar = part(
    new THREE.BoxGeometry(len * 0.16, len * 0.06, len * 0.16),
    woodLight,
  );
  collar.position.y = len * 0.42;
  g.add(collar);

  // The real fish where there is one — it is the same atlas, so it shades
  // with the building under it. makeFish stays as the fallback for a build
  // without the fish models.
  const fish = prop?.('fish/fish', len) ?? makeFish(len);
  // The model's nose points -z; the sign reads along +x like the hand-built
  // one it replaced.
  fish.rotation.y = -Math.PI / 2;
  fish.position.y = len * 0.62;
  g.add(fish);
  return g;
}

/**
 * A shoal working the water off the fishery's pier: three fish on their own
 * slow circles, at three depths and three phases.
 *
 * They are named so buildingSync can find and swim them, and they only move
 * while the building is staffed — the same rule the well's windlass follows.
 * Still water outside a working fishery is the tell that it has no worker.
 */
export function makeShoal(prop: PropFactory): THREE.Group {
  const g = new THREE.Group();
  g.name = 'fisheryShoal';
  const paths: {
    r: number;
    phase: number;
    speed: number;
    y: number;
    len: number;
  }[] = [
    {r: 0.2, phase: 0, speed: 0.55, y: 0, len: 0.15},
    {r: 0.3, phase: 2.3, speed: -0.42, y: -0.015, len: 0.13},
    {r: 0.13, phase: 4.1, speed: 0.7, y: 0.01, len: 0.11},
  ];
  for (const p of paths) {
    const fish = prop('fish/fish', p.len);
    if (!fish) continue;
    const pivot = new THREE.Group();
    pivot.userData = p;
    pivot.add(fish);
    g.add(pivot);
  }
  return g;
}

/**
 * Fishing rods stood against the hut wall: three of the pack's own rod,
 * butts on the ground, tips leaning back on the wall.
 *
 * They lean toward -z, so the caller places this in front of the wall it
 * leans on and the tops travel back to meet it. Leaning the other way was
 * the first attempt and it put three rods propped against thin air with
 * their butts through the boards.
 *
 * The rod is already in the pack (it is the fishery's output good), so this
 * places the model rather than carving sticks — the same call the shoal and
 * the fish sign make, and for the same reason: a hand-built rod would be
 * the one thing in the yard not shading off the atlas.
 *
 * Both the size and the origin are taken off the clone's own bounding box
 * rather than trusted, because this model breaks the two assumptions the
 * decor path makes. It is authored to be HELD: its origin sits mid-shaft
 * with the line hanging out to one side, so a prop placed at its own origin
 * plants halfway into the ground. And it is 4.3 long against 1.3 across, so
 * `PropFactory`'s span — which sizes by the horizontal footprint — hands
 * back a rod three times the height asked for. `len` here means height, and
 * is enforced after the fact.
 */
export function makeRodStand(prop: PropFactory, len = 0.34): THREE.Group {
  const g = new THREE.Group();
  const LEAN = [
    {tilt: 0.22, turn: -0.5, x: -0.035},
    {tilt: 0.15, turn: 0.15, x: 0.0},
    {tilt: 0.26, turn: 0.7, x: 0.038},
  ];
  for (const l of LEAN) {
    const rod = prop('tools/fishing_rod', len);
    if (!rod) continue;
    // Rescale to `len` TALL, then stand it on its butt.
    const raw = new THREE.Box3().setFromObject(rod);
    rod.scale.multiplyScalar(len / Math.max(raw.max.y - raw.min.y, 1e-6));
    const box = new THREE.Box3().setFromObject(rod);
    rod.position.set(
      -(box.min.x + box.max.x) / 2,
      -box.min.y,
      -(box.min.z + box.max.z) / 2,
    );
    const pivot = new THREE.Group();
    pivot.add(rod);
    pivot.rotation.order = 'YXZ';
    pivot.rotation.y = l.turn;
    pivot.rotation.x = -l.tilt;
    pivot.position.x = l.x;
    g.add(pivot);
  }
  return g;
}
