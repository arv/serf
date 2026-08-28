import * as THREE from 'three';

/**
 * Headworks for the four extraction posts.
 *
 * The pack ships one mine — a grey rock mound with a timbered adit and a
 * length of rail — and the quarry, the iron, the silver and the gold mine
 * were all playing it. Empty-yarded they were the same building four
 * times; stocked, they differed by three boulders the size of a thumb,
 * mostly hidden behind the mound at the default camera yaw. A player
 * scanning the valley could not tell which hill was making what.
 *
 * The fix is silhouette, not tint. Each post keeps the family shell — they
 * *are* all holes in the ground — and gains its own works standing clear of
 * it, chosen so the four read apart as outlines at village zoom:
 *
 *   quarry  a sheerlegs derrick over a stack of squared ashlar — an open
 *           cut, no shaft at all, which is also what the sim says it is
 *           (it gathers surface `rock`, not a seam)
 *   iron    a plank ore chute running down to a trestle bin — a low slant
 *   silver  a roofed windlass over a shaft collar — a little kiosk
 *   gold    an A-frame headframe with a winding wheel at the apex, and a
 *           washing sluice beside it — the only circle in the set
 *
 * Everything is authored in the building's unit-square space, the space
 * BUILDING_DECOR places in, so a part is a fraction of the footprint and
 * scales with it. Nothing here loads; parts are flat-shaded in the pack's
 * own timber and stone tones (sampled off the atlas) so they sit in key
 * beside the model they stand on.
 */

/** Atlas-sampled tones, so a built part shades like the mound behind it. */
const TIMBER = 0x9b5a45;
const TIMBER_DARK = 0x6f4132;
const STONE = 0x978f86;
const STONE_PALE = 0xc5b097;
const IRON_DARK = 0x4a5155;
const SHAFT_DARK = 0x241c16;
const ROPE = 0xdaae7d;

function part(geo: THREE.BufferGeometry, color: number): THREE.Mesh {
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function beam(len: number, thick: number, color = TIMBER): THREE.Mesh {
  return part(new THREE.BoxGeometry(thick, len, thick), color);
}

/** A leg from `a` to `b`, both in the group's own space. */
function strut(
  g: THREE.Group,
  a: [number, number, number],
  b: [number, number, number],
  thick: number,
  color = TIMBER,
): void {
  const av = new THREE.Vector3(...a);
  const bv = new THREE.Vector3(...b);
  const d = bv.clone().sub(av);
  const m = beam(d.length(), thick, color);
  m.position.copy(av).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
  g.add(m);
}

/**
 * The quarry: sheerlegs — two long legs and a back stay meeting over a
 * block — with a rope and hook, and courses of sawn ashlar stacked to be
 * carted off.
 *
 * No shaft and no headgear over a mouth, because a quarry has neither: it
 * is the one post of the four that works the surface. The tall thin
 * triangle is the whole tell, and it is the only one of the four that
 * carries no roof, no wheel and no chute.
 */
export function makeSheerlegs(s = 1): THREE.Group {
  const g = new THREE.Group();
  const apex: [number, number, number] = [0, 0.52 * s, -0.04 * s];
  strut(g, [-0.14 * s, 0, 0.08 * s], apex, 0.036 * s);
  strut(g, [0.14 * s, 0, 0.08 * s], apex, 0.036 * s);
  // The back stay, which is what makes sheerlegs sheerlegs rather than an
  // A-frame: the pair leans out over the work and this holds it up.
  strut(g, [0, 0, -0.24 * s], [0, 0.47 * s, -0.045 * s], 0.03 * s, TIMBER_DARK);
  // A brace across the legs, low, so the triangle reads as built.
  const brace = part(new THREE.BoxGeometry(0.24 * s, 0.026 * s, 0.026 * s), TIMBER_DARK);
  brace.position.set(0, 0.16 * s, 0.052 * s);
  g.add(brace);

  // Rope down from the apex to a block half lifted off the ground.
  const rope = part(new THREE.CylinderGeometry(0.007 * s, 0.007 * s, 0.32 * s, 5), ROPE);
  rope.position.set(0, 0.35 * s, 0.01 * s);
  g.add(rope);
  const block = part(new THREE.BoxGeometry(0.13 * s, 0.09 * s, 0.11 * s), STONE_PALE);
  block.position.set(0, 0.145 * s, 0.01 * s);
  block.rotation.y = 0.25;
  g.add(block);
  return g;
}

/** Courses of sawn ashlar: squared blocks, stacked square. Nothing else in
 * the valley is a right angle in stone, which is the point — the pack's own
 * rubble is all lumps. */
export function makeAshlar(s = 1): THREE.Group {
  const g = new THREE.Group();
  const blocks: [number, number, number, number][] = [
    [-0.08, 0.045, 0, 0.04],
    [0.08, 0.045, -0.015, -0.04],
    [-0.065, 0.045, 0.14, 0.55],
    [0.0, 0.135, 0.02, 0.1],
    [0.075, 0.225, 0.03, -0.2],
  ];
  for (const [x, y, z, rot] of blocks) {
    const b = part(
      new THREE.BoxGeometry(0.15 * s, 0.09 * s, 0.13 * s),
      y > 0.1 ? STONE_PALE : STONE,
    );
    b.position.set(x * s, y * s, z * s);
    b.rotation.y = rot;
    g.add(b);
  }
  return g;
}

/**
 * The iron mine: an ore chute. A plank deck on trestle legs runs down out
 * of the hill into an open bin, with the day's rubble spilling into it.
 * A long low slant, the only one in the set — and the heavy, dirty
 * silhouette the workhorse ore should have.
 */
export function makeOreChute(s = 1): THREE.Group {
  const g = new THREE.Group();
  const LEN = 0.34 * s;
  const RISE = 0.27 * s;

  // The deck, hinged high at -z and running down to the bin at +z.
  const deck = new THREE.Group();
  const floor = part(new THREE.BoxGeometry(0.17 * s, 0.018 * s, LEN), TIMBER);
  deck.add(floor);
  for (const sx of [-1, 1]) {
    const side = part(new THREE.BoxGeometry(0.016 * s, 0.05 * s, LEN), TIMBER_DARK);
    side.position.set(sx * 0.085 * s, 0.032 * s, 0);
    deck.add(side);
  }
  deck.rotation.x = Math.atan2(RISE, LEN);
  deck.position.set(0, RISE / 2 + 0.06 * s, 0);
  g.add(deck);

  // Trestle legs under the high end and the middle.
  for (const [z, h] of [
    [-LEN * 0.42, RISE * 0.92],
    [0.0, RISE * 0.52],
  ] as [number, number][]) {
    for (const sx of [-1, 1]) {
      const leg = beam(h + 0.06 * s, 0.02 * s, TIMBER_DARK);
      leg.position.set(sx * 0.08 * s, (h + 0.06 * s) / 2, z);
      g.add(leg);
    }
  }

  // The bin the chute empties into, and what is in it.
  const bin = new THREE.Group();
  bin.position.set(0, 0, LEN * 0.58);
  for (const [dx, dz, w, d] of [
    [0, -0.075, 0.19, 0.016],
    [0, 0.075, 0.19, 0.016],
    [-0.087, 0, 0.016, 0.15],
    [0.087, 0, 0.016, 0.15],
  ] as [number, number, number, number][]) {
    const wall = part(new THREE.BoxGeometry(w * s, 0.1 * s, d * s), TIMBER);
    wall.position.set(dx * s, 0.05 * s, dz * s);
    bin.add(wall);
  }
  const load = part(new THREE.BoxGeometry(0.16 * s, 0.035 * s, 0.13 * s), 0x8a5238);
  load.position.set(0, 0.075 * s, 0);
  bin.add(load);
  g.add(bin);
  return g;
}

/**
 * The silver mine: a windlass house over a vertical shaft. A plank collar
 * around a black hole, four posts, a shingled cap, and the winding drum
 * with its crank and a bucket on the rope.
 *
 * The little roof is what does the work at zoom: it is the only roof in the
 * set, and a roof at the foot of a bare rock mound reads instantly as a
 * shaft with a man at the crank rather than a tunnel walked into.
 */
export function makeWindlassHouse(s = 1): THREE.Group {
  const g = new THREE.Group();
  const R = 0.115 * s;

  // Collar: four planks round a dark hole.
  const hole = part(new THREE.BoxGeometry(R * 1.7, 0.01 * s, R * 1.7), SHAFT_DARK);
  hole.position.y = 0.004 * s;
  g.add(hole);
  for (const [dx, dz, w, d] of [
    [0, -1, 2.2, 0.28],
    [0, 1, 2.2, 0.28],
    [-1, 0, 0.28, 2.2],
    [1, 0, 0.28, 2.2],
  ] as [number, number, number, number][]) {
    const plank = part(new THREE.BoxGeometry(w * R, 0.035 * s, d * R), TIMBER);
    plank.position.set(dx * R, 0.018 * s, dz * R);
    g.add(plank);
  }

  // Four posts and the cap they carry.
  const POST_H = 0.29 * s;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const p = beam(POST_H, 0.026 * s, TIMBER);
      p.position.set(sx * R * 0.85, POST_H / 2, sz * R * 0.85);
      g.add(p);
    }
  }
  const cap = new THREE.Group();
  cap.position.y = POST_H;
  const plate = part(new THREE.BoxGeometry(R * 2.5, 0.02 * s, R * 2.5), TIMBER);
  cap.add(plate);
  // A shallow hip rather than a cone: it keeps the pack's faceted look and
  // does not read as a tent.
  const roof = part(new THREE.ConeGeometry(R * 1.85, 0.11 * s, 4), 0x8d9aa0);
  roof.position.y = 0.065 * s;
  roof.rotation.y = Math.PI / 4;
  cap.add(roof);
  g.add(cap);

  // The drum, its crank, and a bucket down the rope.
  const drum = part(new THREE.CylinderGeometry(0.026 * s, 0.026 * s, R * 1.9, 8), TIMBER);
  drum.rotation.z = Math.PI / 2;
  drum.position.y = POST_H * 0.72;
  g.add(drum);
  const crankArm = part(new THREE.BoxGeometry(0.016 * s, 0.075 * s, 0.016 * s), IRON_DARK);
  crankArm.position.set(R * 1.02, POST_H * 0.72 + 0.035 * s, 0);
  g.add(crankArm);
  const grip = part(new THREE.CylinderGeometry(0.011 * s, 0.011 * s, 0.05 * s, 6), TIMBER_DARK);
  grip.rotation.z = Math.PI / 2;
  grip.position.set(R * 1.14, POST_H * 0.72 + 0.07 * s, 0);
  g.add(grip);
  const line = part(new THREE.CylinderGeometry(0.005 * s, 0.005 * s, POST_H * 0.42, 5), ROPE);
  line.position.set(0, POST_H * 0.72 - POST_H * 0.21, 0);
  g.add(line);
  const bucket = part(new THREE.CylinderGeometry(0.036 * s, 0.03 * s, 0.055 * s, 8), IRON_DARK);
  bucket.position.set(0, POST_H * 0.44, 0);
  g.add(bucket);
  return g;
}

/**
 * The gold mine: a headframe with the winding wheel at its apex, the rope
 * over the sheave and down the shaft.
 *
 * The wheel is the one circle anywhere in the four, and it sits at the top
 * of the tallest thing any of them carries — which is the whole reason it
 * belongs to gold: the deepest shaft, the most gear over it, and a
 * silhouette nothing else in the valley can be mistaken for.
 */
export function makeHeadframe(s = 1): THREE.Group {
  const g = new THREE.Group();
  const APEX = 0.6 * s;
  const apex: [number, number, number] = [0, APEX, 0];
  strut(g, [-0.135 * s, 0, 0.07 * s], apex, 0.03 * s);
  strut(g, [0.135 * s, 0, 0.07 * s], apex, 0.03 * s);
  strut(g, [0, 0, -0.2 * s], [0, APEX * 0.94, -0.01 * s], 0.026 * s, TIMBER_DARK);
  for (const y of [0.2, 0.38] as number[]) {
    const t = y / (APEX / s);
    const halfw = 0.135 * s * (1 - t);
    const rail = part(new THREE.BoxGeometry(halfw * 2, 0.018 * s, 0.018 * s), TIMBER_DARK);
    rail.position.set(0, y * s, 0.07 * s * (1 - t));
    g.add(rail);
  }

  // The sheave: a rim, a hub and four spokes, turned so its face is
  // broadside to the default camera yaw — edge-on it would vanish, and it
  // is the whole point of the silhouette.
  const wheel = new THREE.Group();
  wheel.position.set(0, APEX - 0.015 * s, 0.02 * s);
  wheel.rotation.y = Math.PI / 2;
  const R = 0.085 * s;
  const rim = part(new THREE.TorusGeometry(R, 0.014 * s, 6, 14), IRON_DARK);
  wheel.add(rim);
  const hub = part(new THREE.CylinderGeometry(0.022 * s, 0.022 * s, 0.03 * s, 8), IRON_DARK);
  hub.rotation.x = Math.PI / 2;
  wheel.add(hub);
  for (let i = 0; i < 4; i++) {
    const spoke = part(new THREE.BoxGeometry(0.012 * s, R * 1.9, 0.012 * s), IRON_DARK);
    spoke.rotation.z = (i * Math.PI) / 4;
    wheel.add(spoke);
  }
  g.add(wheel);

  // The rope: over the sheave, down the frame, into the collar.
  const line = part(new THREE.CylinderGeometry(0.006 * s, 0.006 * s, APEX - 0.06 * s, 5), ROPE);
  line.position.set(0, (APEX - 0.06 * s) / 2, 0.105 * s);
  g.add(line);
  const skip = part(new THREE.BoxGeometry(0.07 * s, 0.075 * s, 0.06 * s), IRON_DARK);
  skip.position.set(0, 0.075 * s, 0.105 * s);
  g.add(skip);

  // The collar the skip comes up through.
  const hole = part(new THREE.BoxGeometry(0.15 * s, 0.01 * s, 0.13 * s), SHAFT_DARK);
  hole.position.set(0, 0.005 * s, 0.03 * s);
  g.add(hole);
  for (const [dx, dz, w, d] of [
    [0, -0.085, 0.21, 0.03],
    [0, 0.145, 0.21, 0.03],
    [-0.105, 0.03, 0.03, 0.2],
    [0.105, 0.03, 0.03, 0.2],
  ] as [number, number, number, number][]) {
    const plank = part(new THREE.BoxGeometry(w * s, 0.03 * s, d * s), TIMBER);
    plank.position.set(dx * s, 0.016 * s, dz * s);
    g.add(plank);
  }
  return g;
}

/**
 * The gold mine's second tell, at ground level where the headframe is at
 * roof level: a washing sluice. An inclined trough on trestles, riffled
 * across the fall, with the wash caught bright in the bottom of it.
 */
export function makeSluice(s = 1): THREE.Group {
  const g = new THREE.Group();
  const LEN = 0.27 * s;
  const trough = new THREE.Group();
  const floor = part(new THREE.BoxGeometry(0.16 * s, 0.018 * s, LEN), TIMBER);
  trough.add(floor);
  for (const sx of [-1, 1]) {
    const side = part(new THREE.BoxGeometry(0.018 * s, 0.06 * s, LEN), TIMBER_DARK);
    side.position.set(sx * 0.08 * s, 0.038 * s, 0);
    trough.add(side);
  }
  // A plain launder, and the wash pooled at its foot. It carried riffles
  // across the fall at first, which is what a real sluice has and what at
  // this pitch read as the rungs of a ladder — the one thing an inclined
  // plank on legs must not be mistaken for. One unbroken bright band low in
  // the trough says washing on its own.
  const wash = part(new THREE.BoxGeometry(0.12 * s, 0.018 * s, LEN * 0.44), 0xd4a93c);
  wash.position.set(0, 0.019 * s, LEN * 0.24);
  trough.add(wash);
  trough.rotation.x = 0.26;
  trough.position.y = 0.115 * s;
  g.add(trough);

  for (const [z, h] of [
    [-LEN * 0.36, 0.155],
    [LEN * 0.36, 0.075],
  ] as [number, number][]) {
    for (const sx of [-1, 1]) {
      const leg = beam(h * s, 0.02 * s, TIMBER_DARK);
      leg.position.set(sx * 0.07 * s, (h * s) / 2, z);
      g.add(leg);
    }
  }
  // The catch box the trough spills into, with the day's wash in it.
  const box = new THREE.Group();
  box.position.set(0, 0, LEN * 0.72);
  for (const [dx, dz, w, d] of [
    [0, -0.07, 0.18, 0.016],
    [0, 0.07, 0.18, 0.016],
    [-0.082, 0, 0.016, 0.14],
    [0.082, 0, 0.016, 0.14],
  ] as [number, number, number, number][]) {
    const wall = part(new THREE.BoxGeometry(w * s, 0.075 * s, d * s), TIMBER);
    wall.position.set(dx * s, 0.038 * s, dz * s);
    box.add(wall);
  }
  const caught = part(new THREE.BoxGeometry(0.15 * s, 0.03 * s, 0.12 * s), 0xe0b342);
  caught.position.set(0, 0.055 * s, 0);
  box.add(caught);
  g.add(box);
  return g;
}
