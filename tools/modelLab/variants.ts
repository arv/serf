import * as THREE from 'three';
import type { Kit } from './kit';
import type { BuildingTypeId } from '../../src/sim/defs/buildings';

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

/**
 * A rowboat: keel plank, flared sides, pointed at both ends. Unused since
 * the EXTRA pack's own boat arrived — kept because it is the only hull we
 * can ship without the paid pack, and the free-pack fallback would need it
 * back.
 */
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

/** The food buildings as the game builds them, baked straight out of
 * src/render/assets.ts by the bake page. */
export const GAME_BUILDINGS: { type: BuildingTypeId; id: string }[] = [
  { type: 'mill', id: 'mill' },
  { type: 'bakery', id: 'bakery' },
  { type: 'henYard', id: 'henYard' },
  { type: 'fishery', id: 'fishery' },
];

export const VARIANTS: Variant[] = [
  {
    id: 'mill',
    slot: 'mill',
    title: 'Windmill',
    blurb:
      'The pack windmill, straight in, with a sack of flour at its foot. Its sail cross is a separate node, so it can turn while the mill is staffed — the same trick the well crank uses, and still to be wired up.',
    pack: ['building_windmill_green', 'sack'],
    handmade: [],
    w: 2,
    h: 2,
    build(K) {
      const g = new THREE.Group();
      add(g, K.model('game/mill'));
      return g;
    },
  },
  {
    id: 'bakery',
    slot: 'bakery',
    title: 'Bake-house',
    blurb:
      'The pack’s second house with a clay oven built onto its flank: domed hearth, arched mouth with a fire behind it, short chimney, firewood stacked against the side. The oven is the whole tell — the shell alone would read as another dwelling.',
    pack: ['building_home_B_green', 'barrel'],
    handmade: ['clay oven + chimney'],
    w: 2,
    h: 2,
    build(K) {
      const g = new THREE.Group();
      add(g, K.model('game/bakery'));
      return g;
    },
  },
  {
    id: 'henYard',
    slot: 'livestock',
    title: 'Hen yard',
    blurb:
      'The EXTRA stables — an open shed that arrives with its own rail fence, hay and awning — with five hens and scattered feed in the pen. No KayKit pack has an animal in it, so the birds were always going to be ours.',
    pack: ['extra/building_stables_green'],
    handmade: ['hens', 'feed'],
    w: 3,
    h: 3,
    build(K) {
      const g = new THREE.Group();
      add(g, K.model('game/henYard'));
      return g;
    },
  },
  {
    id: 'fishery',
    slot: 'fishery',
    title: 'Fishery',
    blurb:
      'The EXTRA shipyard with the sailing ship cut off its roof and a fish sign standing in its place, the pack’s pier running out of the front, an anchor and a boat rack on the quay. The pier turns with the building to reach whichever side the water is on.',
    pack: ['extra/building_shipyard_green', 'extra/building_docks_green', 'extra/anchor', 'extra/boatrack'],
    handmade: ['fish sign'],
    w: 3,
    h: 3,
    waterAt: 1.35,
    build(K) {
      const g = new THREE.Group();
      add(g, K.model('game/fishery'));
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

/**
 * Pack files the *goods* cards still compose by hand. The buildings no
 * longer appear here: they are baked whole out of the game's own pipeline,
 * so the gallery cannot drift from what a match draws.
 */
export function requiredFiles(): string[] {
  return ['sack', 'crate_open', 'crate_A_small', 'crate_A_big', 'barrel', 'crate_long_A', 'restaurant/crate_buns'];
}
