import * as THREE from 'three';
import type { Kit } from './kit';

/**
 * Candidate looks for the food chain: mill, bakery, fishery, livestock,
 * and the goods themselves. Each variant says which pack files it leans on
 * and which parts are hand-built, so the cost of a choice is visible
 * before we commit to it.
 *
 * Space is tiles. A variant declares its footprint; parts sit around the
 * origin the way BUILDING_DECOR entries do, except in tiles rather than in
 * the unit square (easier to reason about against w/h).
 */

export interface Variant {
  id: string;
  slot: 'mill' | 'bakery' | 'fishery' | 'livestock' | 'goods';
  title: string;
  /** One line: what the player is looking at. */
  blurb: string;
  /** Pack models used, for the "what this costs us" column. */
  pack: string[];
  /** Parts we would have to build ourselves. */
  handmade: string[];
  /** Footprint in tiles (drives the ground plate and the framing). */
  w: number;
  h: number;
  /** Tile z beyond which the preview ground is water. */
  waterAt?: number;
  /** Props are framed much closer than buildings. */
  closeUp?: boolean;
  build(K: Kit): THREE.Group;
}

// ---------------------------------------------------------------------------
// Hand-built parts. Small, blocky, and painted from the pack's own atlas so
// they sit in the same key as the models they stand next to.

function add(g: THREE.Group, o: THREE.Object3D | null, x = 0, y = 0, z = 0, ry = 0): void {
  if (!o) return;
  o.position.set(x, y, z);
  if (ry) o.rotation.y = ry;
  g.add(o);
}

/** A stone bake oven: domed hearth, arched mouth, short chimney. */
export function bakeOven(K: Kit, s = 1): THREE.Group {
  const g = new THREE.Group();
  add(g, K.box(0.72 * s, 0.24 * s, 0.62 * s, 'stone'), 0, 0.12 * s, 0);
  add(g, K.box(0.78 * s, 0.05 * s, 0.68 * s, 'stonePale'), 0, 0.26 * s, 0);
  const dome = K.sphere(0.32 * s, 'stonePale', 12);
  dome.scale.set(1.08, 0.95, 0.95);
  add(g, dome, 0, 0.26 * s, 0);
  // Mouth: a dark arch with embers behind it.
  add(g, K.box(0.26 * s, 0.22 * s, 0.12 * s, 'charcoal'), 0, 0.34 * s, 0.28 * s);
  add(g, K.box(0.19 * s, 0.06 * s, 0.08 * s, 'roofOrange'), 0, 0.28 * s, 0.31 * s);
  add(g, K.cyl(0.075 * s, 0.085 * s, 0.42 * s, 6, 'stone'), -0.02 * s, 0.62 * s, -0.14 * s);
  add(g, K.box(0.2 * s, 0.05 * s, 0.2 * s, 'slate'), -0.02 * s, 0.84 * s, -0.14 * s);
  // Firewood stacked against the flank.
  for (let i = 0; i < 3; i++) {
    const log = K.cyl(0.035 * s, 0.035 * s, 0.34 * s, 6, 'timberDark');
    log.rotation.x = Math.PI / 2;
    add(g, log, 0.42 * s, (0.04 + i * 0.06) * s, -0.06 * s + (i % 2) * 0.03 * s);
  }
  return g;
}

/** A golden loaf. */
export function loaf(K: Kit, len = 0.2): THREE.Group {
  const g = new THREE.Group();
  const body = K.sphere(len * 0.5, 'gold', 8);
  body.scale.set(1.25, 0.62, 0.8);
  add(g, body, 0, len * 0.28, 0);
  for (const dx of [-len * 0.16, len * 0.16]) {
    add(g, K.box(len * 0.05, len * 0.06, len * 0.26, 'cream'), dx, len * 0.53, 0);
  }
  return g;
}

/** A crate spilling loaves — the food good as a ground pile. */
export function breadCrate(K: Kit, s = 1): THREE.Group {
  const g = new THREE.Group();
  add(g, K.prop('crate_open', { span: 0.34 * s, rot: 0.2 }), 0, 0, 0);
  const rows: [number, number, number][] = [
    [-0.06, 0.15, -0.025],
    [0.01, 0.15, 0.03],
    [0.07, 0.15, -0.03],
    [-0.01, 0.2, 0.0],
  ];
  for (const [x, y, z] of rows) {
    const l = loaf(K, 0.15 * s);
    l.rotation.y = x * 6;
    add(g, l, x * s, y * s, z * s);
  }
  return g;
}

/** A fish: diamond body, forked tail. */
export function fish(K: Kit, len = 0.24): THREE.Group {
  const g = new THREE.Group();
  const body = K.part(new THREE.OctahedronGeometry(len * 0.5, 0), 'steel');
  body.scale.set(1, 0.52, 0.26);
  add(g, body, 0, 0, 0);
  const tail = K.cone(len * 0.22, len * 0.26, 4, 'steel');
  tail.rotation.z = Math.PI / 2;
  tail.scale.set(1, 1, 0.4);
  add(g, tail, -len * 0.56, 0, 0);
  add(g, K.sphere(len * 0.05, 'charcoal', 6), len * 0.24, len * 0.06, len * 0.07);
  return g;
}

/** Posts, a crossbar, and the day's catch hung out to dry. */
export function dryingRack(K: Kit, len = 0.9): THREE.Group {
  const g = new THREE.Group();
  for (const sx of [-len / 2, len / 2]) {
    add(g, K.box(0.05, 0.56, 0.05, 'timber'), sx, 0.28, 0);
  }
  add(g, K.box(len + 0.08, 0.045, 0.045, 'timber'), 0, 0.55, 0);
  const n = 4;
  for (let i = 0; i < n; i++) {
    const x = -len / 2 + (len * (i + 0.5)) / n;
    add(g, K.box(0.012, 0.09, 0.012, 'cream'), x, 0.5, 0);
    const f = fish(K, 0.2);
    f.rotation.z = Math.PI / 2;
    add(g, f, x, 0.36, 0);
  }
  return g;
}

/** A rowboat: keel plank, flared sides, pointed at both ends. */
export function rowboat(K: Kit, len = 0.8): THREE.Group {
  const g = new THREE.Group();
  const w = 0.24;
  add(g, K.box(len * 0.52, 0.07, w, 'timber'), 0, 0.07, 0);
  // Interior, dark enough to read as a hollow rather than a block.
  add(g, K.box(len * 0.5, 0.02, w * 0.8, 'timberDark'), 0, 0.115, 0);
  for (const sz of [-1, 1]) {
    const side = K.box(len * 0.62, 0.15, 0.03, 'timber');
    side.rotation.x = sz * 0.32;
    add(g, side, 0, 0.13, sz * (w / 2 + 0.02));
  }
  for (const sx of [-1, 1]) {
    const end = K.cone(0.15, len * 0.3, 4, 'timber');
    end.rotation.z = (-sx * Math.PI) / 2;
    end.rotation.y = Math.PI / 4;
    end.scale.set(1, 1, 0.72);
    add(g, end, sx * len * 0.34, 0.12, 0);
  }
  for (const dx of [-0.16, 0.16]) {
    add(g, K.box(0.06, 0.03, w + 0.06, 'timberDark'), len * dx, 0.19, 0);
  }
  // An oar shipped across the thwarts.
  const oar = K.cyl(0.017, 0.017, len * 0.8, 5, 'timber');
  oar.rotation.y = 0.35;
  oar.rotation.z = Math.PI / 2;
  add(g, oar, 0, 0.22, 0.02);
  add(g, K.box(0.13, 0.015, 0.07, 'timber'), -len * 0.33, 0.22, -0.1);
  return g;
}

/** A net stretched on a frame. */
export function netFrame(K: Kit, w = 0.6): THREE.Group {
  const g = new THREE.Group();
  for (const sx of [-w / 2, w / 2]) add(g, K.box(0.045, 0.6, 0.045, 'timber'), sx, 0.3, 0);
  add(g, K.box(w + 0.06, 0.04, 0.04, 'timber'), 0, 0.6, 0);
  for (let i = 1; i < 5; i++) {
    add(g, K.box(0.01, 0.42, 0.01, 'cream'), -w / 2 + (w * i) / 5, 0.36, 0);
  }
  for (let i = 1; i < 4; i++) {
    add(g, K.box(w, 0.01, 0.01, 'cream'), 0, 0.18 + i * 0.12, 0);
  }
  return g;
}

/** A pig. */
export function pig(K: Kit, len = 0.36): THREE.Group {
  const g = new THREE.Group();
  const body = K.sphere(len * 0.34, 'salmon', 8);
  body.scale.set(1.35, 0.92, 0.95);
  add(g, body, 0, len * 0.36, 0);
  add(g, K.sphere(len * 0.2, 'salmon', 8), len * 0.42, len * 0.38, 0);
  const snout = K.cyl(len * 0.09, len * 0.09, len * 0.08, 6, 'salmon');
  snout.rotation.z = Math.PI / 2;
  add(g, snout, len * 0.58, len * 0.34, 0);
  for (const sz of [-1, 1]) {
    const ear = K.cone(len * 0.07, len * 0.1, 3, 'salmon');
    add(g, ear, len * 0.36, len * 0.53, sz * len * 0.1);
  }
  for (const sx of [-0.28, 0.24]) {
    for (const sz of [-0.16, 0.16]) {
      add(g, K.box(len * 0.1, len * 0.24, len * 0.1, 'brown'), len * sx, len * 0.12, len * sz);
    }
  }
  add(g, K.sphere(len * 0.05, 'salmon', 5), -len * 0.5, len * 0.44, 0);
  return g;
}

/** A chicken. */
export function chicken(K: Kit, h = 0.26): THREE.Group {
  const g = new THREE.Group();
  const body = K.sphere(h * 0.3, 'white', 8);
  body.scale.set(1.2, 1, 0.95);
  add(g, body, 0, h * 0.46, 0);
  add(g, K.sphere(h * 0.17, 'white', 8), h * 0.26, h * 0.72, 0);
  const beak = K.cone(h * 0.06, h * 0.12, 4, 'roofOrange');
  beak.rotation.z = -Math.PI / 2;
  add(g, beak, h * 0.45, h * 0.7, 0);
  add(g, K.box(h * 0.05, h * 0.1, h * 0.04, 'red'), h * 0.24, h * 0.88, 0);
  const tail = K.cone(h * 0.16, h * 0.24, 4, 'white');
  tail.rotation.z = Math.PI / 2.4;
  tail.scale.set(1, 1, 0.5);
  add(g, tail, -h * 0.36, h * 0.6, 0);
  for (const sz of [-0.09, 0.09]) {
    add(g, K.box(h * 0.04, h * 0.22, h * 0.04, 'gold'), 0, h * 0.11, h * sz);
  }
  return g;
}

/** A feed trough. */
export function trough(K: Kit, len = 0.5): THREE.Group {
  const g = new THREE.Group();
  add(g, K.box(len, 0.05, 0.2, 'timber'), 0, 0.09, 0);
  for (const sz of [-0.1, 0.1]) add(g, K.box(len, 0.13, 0.035, 'timber'), 0, 0.15, sz);
  for (const sx of [-len / 2, len / 2]) add(g, K.box(0.035, 0.13, 0.2, 'timber'), sx, 0.15, 0);
  add(g, K.box(len * 0.86, 0.05, 0.14, 'straw'), 0, 0.14, 0);
  for (const sx of [-len / 2 + 0.03, len / 2 - 0.03]) {
    add(g, K.box(0.05, 0.09, 0.05, 'timberDark'), sx, 0.045, 0);
  }
  return g;
}

/** A henhouse on stilts with a ramp. */
export function coop(K: Kit, w = 0.62): THREE.Group {
  const g = new THREE.Group();
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      add(g, K.box(0.05, 0.2, 0.05, 'timberDark'), sx * w * 0.36, 0.1, sz * w * 0.3);
    }
  }
  add(g, K.box(w, 0.34, w * 0.72, 'timber'), 0, 0.37, 0);
  add(g, K.box(w * 0.26, 0.18, 0.03, 'charcoal'), -w * 0.05, 0.32, w * 0.37);
  for (const sz of [-1, 1]) {
    const pitch = K.box(w * 1.15, 0.05, w * 0.46, 'roofBlue');
    pitch.rotation.x = sz * 0.5;
    add(g, pitch, 0, 0.6, sz * w * 0.17);
  }
  add(g, K.box(w * 1.2, 0.05, 0.05, 'roofOrange'), 0, 0.68, 0);
  const ramp = K.box(0.18, 0.03, 0.44, 'timberDark');
  ramp.rotation.x = -0.75;
  add(g, ramp, -w * 0.05, 0.13, w * 0.55);
  return g;
}

/** A run of pack fencing around a pen, with the gate on the south face. */
export function pen(K: Kit, w: number, h: number, gateAt = 0): THREE.Group {
  const g = new THREE.Group();
  const seg = 0.62;
  const along = (
    len: number,
    place: (t: number) => [number, number],
    rot: number,
    gate = false,
  ): void => {
    const n = Math.max(1, Math.round(len / seg));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n - 0.5;
      const [x, z] = place(t);
      const isGate = gate && i === Math.floor(n / 2) + gateAt;
      // The pack's fence runs along Z; +90 degrees lays it along X.
      const p = K.prop(isGate ? 'fence_wood_straight_gate' : 'fence_wood_straight', {
        span: isGate ? (len / n) * 1.1 : len / n,
        rot: rot + Math.PI / 2,
      });
      add(g, p, x, 0, z);
    }
  };
  along(w, (t) => [t * w, h / 2], 0, true);
  along(w, (t) => [t * w, -h / 2], 0);
  along(h, (t) => [w / 2, t * h], Math.PI / 2);
  along(h, (t) => [-w / 2, t * h], Math.PI / 2);
  return g;
}

/** A plank jetty running out into the water. */
export function jetty(K: Kit, len = 1.6, w = 0.5): THREE.Group {
  const g = new THREE.Group();
  const planks = Math.round(len / 0.16);
  for (let i = 0; i < planks; i++) {
    add(g, K.box(w, 0.035, 0.13, 'timber'), 0, 0.18, (i + 0.5) * (len / planks));
  }
  for (let i = 0; i <= 2; i++) {
    const z = 0.2 + (i * (len - 0.3)) / 2;
    for (const sx of [-w / 2 + 0.05, w / 2 - 0.05]) {
      add(g, K.box(0.06, 0.4, 0.06, 'timberDark'), sx, 0.0, z);
    }
  }
  return g;
}

/** Sacks tipped against a wall — the mill's yard. */
export function sacks(K: Kit, n: number, swatch: 'cream' | 'straw' | 'white' | null = null): THREE.Group {
  const g = new THREE.Group();
  const spots: [number, number, number][] = [
    [0, 0, 0],
    [0.16, 0, 0.06],
    [0.08, 0.1, 0.03],
    [-0.14, 0, 0.08],
  ];
  for (let i = 0; i < Math.min(n, spots.length); i++) {
    const s = K.prop('sack', { h: 0.16, rot: i * 1.3 });
    if (s && swatch) K.recolor(s, swatch);
    add(g, s, spots[i]![0], spots[i]![1], spots[i]![2]);
  }
  return g;
}

// ---------------------------------------------------------------------------
// The candidates.

export const VARIANTS: Variant[] = [
  // --- Mill: wheat -> flour ------------------------------------------------
  {
    id: 'mill-windmill',
    slot: 'mill',
    title: 'Windmill',
    blurb:
      'The pack windmill, straight in. Its sail cross is a separate node, so it can turn while the mill is staffed — the same trick the well crank uses.',
    pack: ['building_windmill_green', 'sack', 'wheelbarrow'],
    handmade: [],
    w: 2,
    h: 2,
    build(K) {
      const g = new THREE.Group();
      add(g, K.base('building_windmill_green', 2, 2, { rot: -Math.PI / 2 }));
      add(g, sacks(K, 3, 'white'), -0.62, 0, 0.52);
      add(g, K.prop('wheelbarrow', { h: 0.3, rot: 2.2 }), 0.66, 0, 0.5);
      return g;
    },
  },
  {
    id: 'mill-watermill',
    slot: 'mill',
    title: 'Watermill',
    blurb:
      'The pack watermill. Its wheel is a separate node too, and it wants a riverbank — a placement rule the game already has machinery for (nearDeposit).',
    pack: ['building_watermill_green', 'sack', 'crate_A_small'],
    handmade: [],
    w: 2,
    h: 2,
    waterAt: 0.62,
    build(K) {
      const g = new THREE.Group();
      // The wheel sits on the model's -z face; turn the mill to put it in
      // the water rather than against the bank.
      add(g, K.base('building_watermill_green', 2, 2, { rot: Math.PI }), 0, 0, -0.25);
      add(g, sacks(K, 3, 'white'), -0.85, 0, -0.5);
      add(g, K.prop('crate_A_small', { h: 0.2, rot: 0.4 }), 0.8, 0, -0.55);
      return g;
    },
  },
  {
    id: 'mill-windmill-yard',
    slot: 'mill',
    title: 'Windmill + threshing yard',
    blurb:
      'Same windmill, dressed: a pallet of grain sacks, a barrow, and loose straw. Reads as a working mill from further out, at the cost of a busier footprint.',
    pack: ['building_windmill_green', 'pallet', 'sack', 'wheelbarrow', 'crate_A_small'],
    handmade: ['straw scatter'],
    w: 3,
    h: 3,
    build(K) {
      const g = new THREE.Group();
      add(g, K.base('building_windmill_green', 2, 2, { rot: -Math.PI / 2 }), 0.25, 0, -0.25);
      add(g, K.prop('pallet', { span: 0.7, rot: 0.1 }), -0.85, 0, 0.55);
      add(g, sacks(K, 4, 'straw'), -0.9, 0.07, 0.5);
      add(g, K.prop('wheelbarrow', { h: 0.32, rot: 2.4 }), 0.9, 0, 0.75);
      add(g, K.prop('crate_A_small', { h: 0.22 }), 0.2, 0, 1.0);
      for (let i = 0; i < 5; i++) {
        const straw = K.box(0.24, 0.02, 0.03, 'straw');
        straw.rotation.y = i * 1.1;
        add(g, straw, -0.2 + i * 0.16, 0.01, 0.95 - (i % 2) * 0.2);
      }
      return g;
    },
  },

  // --- Bakery: flour + water -> food --------------------------------------
  {
    id: 'bakery-house-oven',
    slot: 'bakery',
    title: 'Bake-house',
    blurb:
      'The unused second house model with a hand-built stone oven bolted to its flank. Cheapest honest bakery: one new prop, and the town gains a silhouette it does not already have.',
    pack: ['building_home_B_green', 'crate_open', 'barrel'],
    handmade: ['stone oven + chimney', 'loaves'],
    w: 2,
    h: 2,
    build(K) {
      const g = new THREE.Group();
      add(g, K.base('building_home_B_green', 1.75, 1.75, { rot: 0.08 }), -0.4, 0, -0.35);
      add(g, bakeOven(K, 1.35), 0.85, 0, 0.35, -0.55);
      add(g, breadCrate(K, 1.1), -0.05, 0, 0.85);
      add(g, K.prop('barrel', { h: 0.32 }), -1.05, 0, 0.72);
      return g;
    },
  },
  {
    id: 'bakery-market-stall',
    slot: 'bakery',
    title: 'Baker’s stall',
    blurb:
      'The pack market stall as an open bakery: awning, counter, oven behind. Lightest build (no surgery on the model) and instantly readable, but it is a stall, not a workshop.',
    pack: ['building_market_green', 'crate_open', 'crate_A_small'],
    handmade: ['stone oven', 'loaves on the counter'],
    w: 2,
    h: 2,
    build(K) {
      const g = new THREE.Group();
      add(g, K.base('building_market_green', 1.9, 1.9), -0.18, 0, 0.25);
      add(g, bakeOven(K, 1.05), 0.95, 0, -0.35, 0.3);
      add(g, breadCrate(K, 1.0), 0.7, 0, 0.75);
      add(g, K.prop('crate_A_small', { h: 0.22, rot: 0.7 }), -1.0, 0, 0.75);
      return g;
    },
  },
  {
    id: 'bakery-oven-yard',
    slot: 'bakery',
    title: 'Oven house',
    blurb:
      'No pack building at all: a squat stone bakehouse whose whole front is the oven arch, under a pack-style gabled roof. Nothing in the village looks like it, and it is the only option that needs no model we already use elsewhere.',
    pack: ['pallet', 'sack', 'crate_open', 'barrel'],
    handmade: ['stone bakehouse', 'gable roof', 'oven arch', 'loaves'],
    w: 2,
    h: 2,
    build(K) {
      const g = new THREE.Group();
      const W = 1.5;
      const D = 1.25;
      // Stone body with a banded course at the top, like the pack's walls.
      add(g, K.box(W, 0.82, D, 'stone'), 0, 0.41, -0.1);
      add(g, K.box(W + 0.08, 0.09, D + 0.08, 'stonePale'), 0, 0.86, -0.1);
      // The oven mouth: an arch cut into the south face, embers inside.
      add(g, K.box(0.62, 0.5, 0.12, 'charcoal'), -0.02, 0.29, 0.53);
      add(g, K.cyl(0.31, 0.31, 0.12, 12, 'charcoal'), -0.02, 0.54, 0.53, 0);
      add(g, K.box(0.5, 0.09, 0.1, 'roofOrange'), -0.02, 0.12, 0.55);
      for (const sx of [-0.4, 0.36]) {
        add(g, K.box(0.16, 0.72, 0.14, 'stonePale'), sx * 1.05, 0.36, 0.53);
      }
      // Gable roof, pack colors.
      for (const sz of [-1, 1]) {
        const pitch = K.box(W + 0.3, 0.09, D * 0.72, 'roofBlue');
        pitch.rotation.x = sz * 0.62;
        add(g, pitch, 0, 1.14, -0.1 + sz * D * 0.27);
      }
      add(g, K.box(W + 0.36, 0.08, 0.1, 'roofOrange'), 0, 1.34, -0.1);
      // Chimney off the ridge.
      add(g, K.cyl(0.11, 0.13, 0.62, 6, 'stone'), 0.42, 1.34, -0.34);
      add(g, K.box(0.3, 0.07, 0.3, 'slate'), 0.42, 1.68, -0.34);
      // The working yard: bread bench, flour on a pallet, water butt.
      add(g, K.box(0.8, 0.07, 0.36, 'timber'), -0.9, 0.46, 0.5, 0.35);
      for (const d of [-0.3, 0.3]) {
        add(g, K.box(0.07, 0.44, 0.07, 'timberDark'), -0.9 + d * 0.94, 0.22, 0.5 + d * 0.34);
      }
      add(g, breadCrate(K, 0.95), -0.88, 0.49, 0.48);
      add(g, K.prop('pallet', { span: 0.58, rot: 0.2 }), 1.02, 0, 0.42);
      add(g, sacks(K, 3, 'white'), 0.98, 0.07, 0.4);
      add(g, K.prop('barrel', { h: 0.32 }), 0.42, 0, 0.82);
      for (let i = 0; i < 4; i++) {
        const log = K.cyl(0.05, 0.05, 0.42, 6, 'timberDark');
        log.rotation.z = Math.PI / 2;
        add(g, log, -0.95, 0.06 + Math.floor(i / 2) * 0.1, -0.5 + (i % 2) * 0.12);
      }
      return g;
    },
  },

  // --- Fishery -------------------------------------------------------------
  {
    id: 'fishery-hut-jetty',
    slot: 'fishery',
    title: 'Fisherman’s hut',
    blurb:
      'A small house on the bank, a plank jetty over the water, the catch drying on a rack. The jetty and the fish are ours; everything else is the pack.',
    pack: ['building_home_B_green', 'barrel', 'crate_A_small', 'waterplant_A', 'waterlily_A'],
    handmade: ['jetty', 'drying rack + fish', 'rowboat'],
    w: 2,
    h: 2,
    waterAt: 0.7,
    build(K) {
      const g = new THREE.Group();
      add(g, K.base('building_home_B_green', 1.55, 1.55, { rot: -0.3 }), -0.5, 0, -0.62);
      add(g, jetty(K, 1.35, 0.46), 0.72, 0, 0.35);
      add(g, dryingRack(K, 0.8), -1.0, 0, -0.05, -0.5);
      add(g, rowboat(K, 0.85), -0.35, 0.04, 1.3, 1.15);
      add(g, K.prop('barrel', { h: 0.26 }), 0.62, 0, -0.55);
      add(g, K.prop('crate_A_small', { h: 0.2, rot: 0.6 }), 0.25, 0, 0.15);
      add(g, K.prop('waterplant_A', { h: 0.22 }), -1.15, 0, 1.05);
      add(g, K.prop('waterlily_A', { span: 0.3 }), 0.35, 0.04, 1.6);
      return g;
    },
  },
  {
    id: 'fishery-camp',
    slot: 'fishery',
    title: 'Fishing camp',
    blurb:
      'The pack tent, nets on frames, a boat pulled up. Cheap and early — it looks like something two serfs put up in an afternoon, which is exactly what a first food building should look like.',
    pack: ['tent', 'crate_open', 'barrel', 'waterplant_A'],
    handmade: ['net frames', 'rowboat', 'fish'],
    w: 2,
    h: 2,
    waterAt: 0.75,
    build(K) {
      const g = new THREE.Group();
      add(g, K.prop('tent', { h: 0.92, rot: 0.35 }), -0.6, 0, -0.55);
      add(g, netFrame(K, 0.72), 0.62, 0, -0.6, -0.3);
      add(g, netFrame(K, 0.56), 1.0, 0, 0.1, 0.45);
      add(g, rowboat(K, 0.9), 0.05, 0.02, 1.3, 1.4);
      add(g, dryingRack(K, 0.62), -0.9, 0, 0.35, 0.2);
      add(g, K.prop('crate_open', { span: 0.32, rot: 0.5 }), -0.05, 0, 0.2);
      add(g, K.prop('barrel', { h: 0.26 }), 0.45, 0, 0.45);
      add(g, K.prop('waterplant_A', { h: 0.2 }), -1.2, 0, 1.15);
      // The fire the camp is named for.
      add(g, K.part(new THREE.CircleGeometry(0.2, 10), 'charcoal'), -0.15, 0.01, -0.15);
      for (let i = 0; i < 4; i++) {
        const stick = K.cyl(0.03, 0.03, 0.3, 5, 'timberDark');
        stick.rotation.z = 0.9;
        stick.rotation.y = i * 1.6;
        add(g, stick, -0.15, 0.08, -0.15);
      }
      add(g, K.sphere(0.1, 'roofOrange', 6), -0.15, 0.1, -0.15);
      return g;
    },
  },
  {
    id: 'fishery-stilt-house',
    slot: 'fishery',
    title: 'Fish house on stilts',
    blurb:
      'The hut stands *in* the water on posts, reached by the jetty. Strongest silhouette of the three and the clearest "this needs a shore" signal, but it needs the deck and posts built by hand.',
    pack: ['building_home_B_green', 'crate_A_small', 'barrel', 'waterlily_A'],
    handmade: ['stilt deck + posts', 'jetty', 'drying rack + fish'],
    w: 2,
    h: 2,
    waterAt: 0.15,
    build(K) {
      const g = new THREE.Group();
      // Deck out over the water, on posts.
      add(g, K.box(1.6, 0.09, 1.45, 'timber'), 0.05, 0.38, 0.95);
      for (const sx of [-0.66, 0.72]) {
        for (const sz of [0.4, 1.5]) {
          add(g, K.box(0.1, 0.45, 0.1, 'timberDark'), sx, 0.19, sz);
        }
      }
      add(g, K.base('building_home_B_green', 1.4, 1.4, { rot: 0.22 }), -0.02, 0.42, 1.05);
      // The plank walk from the bank onto the deck.
      add(g, jetty(K, 0.55, 0.44), 0.62, 0, -0.42);
      add(g, K.box(0.44, 0.04, 0.5, 'timber'), 0.62, 0.31, 0.15);
      add(g, dryingRack(K, 0.62), 0.78, 0.42, 0.55, 1.55);
      add(g, K.prop('crate_A_small', { h: 0.2, rot: 0.5 }), -0.55, 0.42, 0.6);
      add(g, K.prop('barrel', { h: 0.24 }), -0.5, 0.42, 1.5);
      add(g, K.prop('waterlily_A', { span: 0.32 }), 1.45, 0.05, 1.35);
      add(g, rowboat(K, 0.7), -1.05, 0.05, 0.8, 0.4);
      return g;
    },
  },

  // --- Livestock -----------------------------------------------------------
  {
    id: 'livestock-pigpen',
    slot: 'livestock',
    title: 'Pig pen',
    blurb:
      'Pack fencing around a hand-built sty, a trough, and three pigs. The fence run is the pack’s and tiles cleanly; the animals are the only genuinely new modelling.',
    pack: ['fence_wood_straight', 'fence_wood_straight_gate', 'crate_A_small'],
    handmade: ['pigs', 'trough', 'sty'],
    w: 3,
    h: 3,
    build(K) {
      const g = new THREE.Group();
      add(g, pen(K, 2.7, 2.7));
      // Sty: a low shed against the north fence.
      add(g, K.box(1.0, 0.42, 0.6, 'timber'), -0.55, 0.21, -0.9);
      const roof = K.box(1.15, 0.06, 0.72, 'straw');
      roof.rotation.x = -0.18;
      add(g, roof, -0.55, 0.46, -0.88);
      add(g, K.box(0.34, 0.3, 0.03, 'charcoal'), -0.55, 0.15, -0.6);
      add(g, trough(K, 0.7), 0.75, 0, 0.35, 0.2);
      add(g, pig(K, 0.4), 0.35, 0, -0.35, 1.9);
      add(g, pig(K, 0.36), 0.85, 0, -0.05, 3.5);
      add(g, pig(K, 0.34), -0.35, 0, 0.65, 0.7);
      add(g, K.prop('crate_A_small', { h: 0.2, rot: 0.3 }), -1.05, 0, 0.85);
      // Churned mud where they wallow.
      const mud = K.part(new THREE.CircleGeometry(0.42, 12), 'brown');
      mud.rotation.x = -Math.PI / 2;
      add(g, mud, 0.5, 0.012, 0.45);
      return g;
    },
  },
  {
    id: 'livestock-henyard',
    slot: 'livestock',
    title: 'Hen yard',
    blurb:
      'A coop on stilts with a ramp, fenced run, five hens. Smaller and gentler than the pig pen — reads well at 2x2, so it can be the cheap early food building.',
    pack: ['fence_wood_straight', 'fence_wood_straight_gate', 'crate_open', 'sack'],
    handmade: ['coop', 'hens', 'feed scatter'],
    w: 3,
    h: 3,
    build(K) {
      const g = new THREE.Group();
      add(g, pen(K, 2.7, 2.7));
      add(g, coop(K, 0.75), -0.6, 0, -0.75, 0.15);
      const hens: [number, number, number][] = [
        [0.5, -0.5, 1.2],
        [0.85, 0.15, 2.6],
        [0.2, 0.5, 0.3],
        [-0.5, 0.75, 4.1],
        [1.0, 0.85, 5.2],
      ];
      for (const [x, z, r] of hens) add(g, chicken(K, 0.27), x, 0, z, r);
      add(g, K.prop('crate_open', { span: 0.3, rot: 0.4 }), -1.05, 0, 0.55);
      add(g, sacks(K, 2, 'straw'), -1.0, 0, 0.05);
      for (let i = 0; i < 7; i++) {
        add(g, K.box(0.035, 0.012, 0.035, 'gold'), 0.15 + (i % 4) * 0.16, 0.006, 0.15 + (i % 3) * 0.2);
      }
      return g;
    },
  },
  {
    id: 'livestock-steading',
    slot: 'livestock',
    title: 'Steading',
    blurb:
      'One building that covers both animals: pack barn, fenced yard, pigs on one side, hens on the other. The most content per building slot, and the busiest 3x3 in the game.',
    pack: ['building_home_B_green', 'fence_wood_straight', 'fence_wood_straight_gate', 'barrel'],
    handmade: ['pigs', 'hens', 'trough', 'coop'],
    w: 3,
    h: 3,
    build(K) {
      const g = new THREE.Group();
      add(g, K.base('building_home_B_green', 1.9, 1.9, { rot: 0.12 }), -0.62, 0, -0.68);
      add(g, pen(K, 2.7, 2.7));
      add(g, coop(K, 0.55), 1.0, 0, -0.75, -0.4);
      add(g, trough(K, 0.6), -0.35, 0, 0.85, 0.15);
      add(g, pig(K, 0.38), 0.45, 0, 0.55, 2.2);
      add(g, pig(K, 0.32), 0.95, 0, 0.9, 4.0);
      add(g, chicken(K, 0.25), 0.95, 0, -0.1, 1.2);
      add(g, chicken(K, 0.25), 0.45, 0, -0.25, 3.4);
      add(g, K.prop('barrel', { h: 0.26 }), -1.05, 0, 0.35);
      return g;
    },
  },

  // --- The goods themselves ------------------------------------------------
  {
    id: 'goods-food',
    slot: 'goods',
    title: 'Food: three candidates',
    blurb:
      'Left: the Restaurant Bits bread crate (second atlas, but exactly a crate of loaves). Middle: our own loaves in the pack’s open crate. Right: the plain crate, food-agnostic if food is meant to cover fish and meat too.',
    pack: ['restaurant/crate_buns', 'crate_open', 'crate_A_big'],
    handmade: ['loaves'],
    w: 2,
    h: 1,
    closeUp: true,
    build(K) {
      const g = new THREE.Group();
      add(g, K.prop('restaurant/crate_buns', { span: 0.4, rot: 0.35 }), -0.62, 0, 0);
      add(g, breadCrate(K, 1.15), 0.05, 0, 0);
      add(g, K.prop('crate_A_big', { span: 0.36, rot: -0.3 }), 0.68, 0, 0);
      add(g, fish(K, 0.3), 0.68, 0.4, 0.0, 0.4);
      add(g, fish(K, 0.26), 0.62, 0.42, 0.08, 0.9);
      return g;
    },
  },
  {
    id: 'goods-flour',
    slot: 'goods',
    title: 'Flour and wheat, told apart',
    blurb:
      'Wheat keeps the pack’s tan sack (left). Flour is the same sack with its UVs moved to the atlas’ near-white swatch (middle) — one model, no new asset, and the two never read alike in a yard. Right: a barrel, if flour should be bulk store instead.',
    pack: ['sack', 'barrel'],
    handmade: ['cream repaint of sack'],
    w: 2,
    h: 1,
    closeUp: true,
    build(K) {
      const g = new THREE.Group();
      add(g, sacks(K, 3), -0.5, 0, 0);
      add(g, sacks(K, 3, 'white'), 0.08, 0, 0);
      add(g, K.prop('barrel', { h: 0.3 }), 0.62, 0, 0);
      return g;
    },
  },
  {
    id: 'goods-fish',
    slot: 'goods',
    title: 'Fish, if the fishery ships its own good',
    blurb:
      'If fish is a distinct good rather than food-by-another-name, this is what a serf would carry and what would stack in the yard: a crate of them, and a pair on a plank.',
    pack: ['crate_open', 'crate_long_A'],
    handmade: ['fish'],
    w: 2,
    h: 1,
    closeUp: true,
    build(K) {
      const g = new THREE.Group();
      const crate = K.prop('crate_open', { span: 0.4, rot: 0.25 });
      add(g, crate, -0.4, 0, 0);
      for (let i = 0; i < 4; i++) {
        const f = fish(K, 0.22);
        f.rotation.z = 0.25;
        add(g, f, -0.44 + (i % 2) * 0.14, 0.2 + Math.floor(i / 2) * 0.08, -0.04 + (i % 2) * 0.08, i * 0.6);
      }
      add(g, K.prop('crate_long_A', { span: 0.44, rot: -0.2 }), 0.5, 0, 0);
      for (let i = 0; i < 2; i++) {
        add(g, fish(K, 0.26), 0.43 + i * 0.14, 0.17, -0.05 + i * 0.1, 0.3 + i);
      }
      return g;
    },
  },
];

/** Every pack file the variants reference (the lab preloads exactly these). */
export function requiredFiles(): string[] {
  const s = new Set<string>();
  for (const v of VARIANTS) for (const f of v.pack) s.add(f);
  // Referenced by shared parts rather than named per variant.
  for (const f of ['sack', 'crate_open', 'crate_A_small', 'crate_A_big', 'pallet', 'barrel']) {
    s.add(f);
  }
  return [...s];
}
