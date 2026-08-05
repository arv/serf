import * as THREE from 'three';
import { palette } from './palette';

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
