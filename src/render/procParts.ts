import * as THREE from 'three';
import { palette } from './palette';
import type { PropFactory } from './assets';

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
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/**
 * A bake oven: clay dome on a stone plinth, arched mouth with a fire behind
 * it, short chimney, and a few billets stacked against the flank. `h` is its
 * overall height in unit-square units — about 0.62 reads right against a
 * house without competing with its roof.
 *
 * This is the bakery's whole identity. The shell is the pack's second house
 * model, which on its own would read as another dwelling; the oven is what
 * makes the building say bread from across the valley.
 */
export function makeBakeOven(h = 0.62): THREE.Group {
  const g = new THREE.Group();
  const s = h / 0.62; // proportions authored at h = 0.62

  const base = part(new THREE.BoxGeometry(0.38 * s, 0.13 * s, 0.34 * s), palette.rockDark);
  base.position.y = 0.065 * s;
  g.add(base);
  const course = part(new THREE.BoxGeometry(0.42 * s, 0.035 * s, 0.38 * s), palette.paper);
  course.position.y = 0.14 * s;
  g.add(course);

  // Clay, not plaster: a white dome reads as an egg against the pack's warm
  // roofs, and the terracotta is the atlas' own (#b16f52) so the oven sits
  // in the same key as the timber around it.
  const dome = part(new THREE.SphereGeometry(0.19 * s, 10, 6), 0xb1795a);
  dome.scale.set(1.05, 0.92, 0.95);
  dome.position.y = 0.15 * s;
  g.add(dome);

  // The mouth, with a little fire behind it. Small and dark: at village
  // zoom it is the one high-contrast note on the whole building.
  const mouth = part(new THREE.BoxGeometry(0.15 * s, 0.13 * s, 0.07 * s), 0x241c16);
  mouth.position.set(0, 0.2 * s, 0.17 * s);
  g.add(mouth);
  const embers = part(new THREE.BoxGeometry(0.11 * s, 0.035 * s, 0.05 * s), palette.lantern);
  embers.position.set(0, 0.16 * s, 0.185 * s);
  g.add(embers);

  const flue = part(new THREE.CylinderGeometry(0.04 * s, 0.048 * s, 0.24 * s, 6), palette.rock);
  flue.position.set(-0.01 * s, 0.37 * s, -0.08 * s);
  g.add(flue);
  const cap = part(new THREE.BoxGeometry(0.11 * s, 0.026 * s, 0.11 * s), palette.rockDark);
  cap.position.set(-0.01 * s, 0.5 * s, -0.08 * s);
  g.add(cap);

  for (let i = 0; i < 3; i++) {
    const log = part(new THREE.CylinderGeometry(0.017 * s, 0.017 * s, 0.16 * s, 6), palette.wood);
    log.rotation.x = Math.PI / 2;
    log.position.set(0.245 * s, (0.022 + i * 0.03) * s, (-0.03 + (i % 2) * 0.015) * s);
    g.add(log);
  }
  return g;
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

  const tail = part(new THREE.ConeGeometry(len * 0.24, len * 0.28, 4), 0x8aa7b5);
  tail.rotation.z = Math.PI / 2;
  tail.scale.set(1, 1, 0.55);
  tail.position.x = -len * 0.56;
  g.add(tail);

  for (const sz of [-1, 1]) {
    const fin = part(new THREE.ConeGeometry(len * 0.13, len * 0.16, 3), 0x6f8894);
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
  const post = part(new THREE.CylinderGeometry(len * 0.06, len * 0.08, len * 0.42, 6), palette.wood);
  post.position.y = len * 0.21;
  g.add(post);

  const collar = part(new THREE.BoxGeometry(len * 0.16, len * 0.06, len * 0.16), palette.woodLight);
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
  const paths: { r: number; phase: number; speed: number; y: number; len: number }[] = [
    { r: 0.2, phase: 0, speed: 0.55, y: 0, len: 0.15 },
    { r: 0.3, phase: 2.3, speed: -0.42, y: -0.015, len: 0.13 },
    { r: 0.13, phase: 4.1, speed: 0.7, y: 0.01, len: 0.11 },
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
