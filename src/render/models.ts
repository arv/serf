import * as THREE from 'three';
import type {Enum} from '../shared/enum.ts';
import * as GoodId from '../sim/defs/goodIdEnum.ts';
import {GOODS} from '../sim/defs/goods';
import type {BuildingTypeId} from '../sim/entities';
import {
  makeGlbBuilding,
  glbCarryProp,
  glbPropAtScale,
  hasGlbProp,
} from './assets';
import {mapMaterials} from './materials';
import {
  goodColors as goodColorsLocal,
  rock,
  stalk,
  stoneRoad,
  wood,
  woodLight,
} from './palette';

type GoodId = Enum<typeof GoodId>;

export {goodColors} from './palette';

/**
 * Shared procedural props: site frames, the road-work pile, ghost tinting,
 * stock piles and carried goods. Building and unit bodies come exclusively
 * from the GLB assets — the old procedural fallback town (which wore the
 * legacy japan look and appeared whenever the asset fetch hiccuped) is
 * gone; asset loading now retries and fails loudly instead.
 */

export function mesh(geo: THREE.BufferGeometry, color: number): THREE.Mesh {
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({color}));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function makeRoadPile(): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const s = mesh(new THREE.DodecahedronGeometry(0.12), stoneRoad);
    s.position.set((i - 1) * 0.18, 0.08, (i % 2) * 0.15 - 0.07);
    g.add(s);
  }
  return g;
}

export function makeGhostModel(
  type: BuildingTypeId,
  opacity = 0.45,
  owner = 0,
): THREE.Group {
  // Preview whatever model will actually be built, in your colors.
  // (Only road sites have no GLB; they preview as the wood pile marker.)
  const g = makeGlbBuilding(type, owner) ?? makeRoadPile();
  const ghosted = (m: THREE.Material): THREE.Material => {
    const mat = m.clone() as THREE.MeshLambertMaterial;
    mat.transparent = true;
    mat.opacity = opacity;
    mat.depthWrite = false;
    return mat;
  };
  g.traverse(obj => {
    if (obj instanceof THREE.Mesh) {
      mapMaterials(obj, ghosted);
      obj.castShadow = false;
      obj.receiveShadow = false;
    }
  });
  return g;
}

function post(x: number, z: number, h: number): THREE.Mesh {
  const p = mesh(new THREE.BoxGeometry(0.09, h, 0.09), wood);
  p.position.set(x, h / 2, z);
  return p;
}

/** Corner-post height of a construction frame, in world units — the top of
 * a fresh site, before the building itself has risen past it. */
export const SITE_FRAME_H = 0.7;

/** Construction-site frame: corner posts + ground sill, Settlers-style. */
export function makeSiteFrame(w: number, h: number): THREE.Group {
  const g = new THREE.Group();
  const hw = w / 2 - 0.15;
  const hh = h / 2 - 0.15;
  for (const sx of [-hw, hw]) {
    for (const sz of [-hh, hh]) {
      g.add(post(sx, sz, SITE_FRAME_H));
    }
  }
  const sillNS = new THREE.BoxGeometry(w - 0.2, 0.08, 0.08);
  const sillEW = new THREE.BoxGeometry(0.08, 0.08, h - 0.2);
  for (const sz of [-hh, hh]) {
    const s = mesh(sillNS, woodLight);
    s.position.set(0, 0.08, sz);
    g.add(s);
  }
  for (const sx of [-hw, hw]) {
    const s = mesh(sillEW, woodLight);
    s.position.set(sx, 0.08, 0);
    g.add(s);
  }
  return g;
}

// ---------------------------------------------------------------------------
// Units — articulated little people, built once per kind and cloned per
// entity. Origin at feet. Limbs are named groups pivoted at hip/shoulder so
// the renderer can swing them: 'legL', 'legR', 'armL', 'armR', 'torso'.
// Tools/weapons are parented to the right hand and swing with the arm.

export function lathe(
  profile: [number, number][],
  color: number,
  segments = 10,
): THREE.Mesh {
  const points = profile.map(([r, y]) => new THREE.Vector2(r, y));
  return mesh(new THREE.LatheGeometry(points, segments), color);
}

function carryProto(good: GoodId): THREE.Group {
  const g = new THREE.Group();
  const add = (m: THREE.Mesh): void => {
    m.castShadow = false;
    g.add(m);
  };

  switch (good) {
    case GoodId.water: {
      // A shoulder pole with a pail swinging at each end.
      const pole = mesh(
        new THREE.CylinderGeometry(0.022, 0.022, 0.78, 5),
        woodLight,
      );
      pole.rotation.z = Math.PI / 2;
      add(pole);
      for (const sx of [-0.36, 0.36]) {
        const rope = mesh(
          new THREE.CylinderGeometry(0.008, 0.008, 0.16, 3),
          0x2a2018,
        );
        rope.position.set(sx, -0.09, 0);
        add(rope);
        const pail = mesh(
          new THREE.CylinderGeometry(0.06, 0.05, 0.09, 7),
          wood,
        );
        pail.position.set(sx, -0.2, 0);
        add(pail);
        const waterTop = mesh(
          new THREE.CylinderGeometry(0.045, 0.045, 0.012, 7),
          0x4a708c,
        );
        waterTop.position.set(sx, -0.155, 0);
        add(waterTop);
      }
      g.position.y = 0.88;
      break;
    }
    case GoodId.wheat: {
      // A straw grain bale with rope bindings.
      const bale = mesh(
        new THREE.CylinderGeometry(0.11, 0.11, 0.32, 8),
        0xd8c288,
      );
      bale.rotation.z = Math.PI / 2;
      add(bale);
      for (const sx of [-0.09, 0.09]) {
        const band = mesh(
          new THREE.CylinderGeometry(0.115, 0.115, 0.025, 8),
          0x8a6c3c,
        );
        band.rotation.z = Math.PI / 2;
        band.position.x = sx;
        add(band);
      }
      g.position.y = 0.92;
      break;
    }
    case GoodId.wood: {
      // A bundle of poles over the shoulder.
      for (const [dy, dz, r] of [
        [0, 0, 0.032],
        [0.05, 0.03, 0.028],
        [0.04, -0.04, 0.03],
      ] as const) {
        const culm = mesh(new THREE.CylinderGeometry(r, r, 0.95, 5), stalk);
        culm.rotation.z = Math.PI / 2;
        culm.rotation.y = 0.12;
        culm.position.set(0, dy, dz);
        add(culm);
      }
      g.position.y = 0.9;
      break;
    }
    case GoodId.stone: {
      const chunk = mesh(new THREE.DodecahedronGeometry(0.14), rock);
      chunk.scale.y = 0.8;
      add(chunk);
      g.position.y = 0.92;
      break;
    }
    case GoodId.iron:
    case GoodId.silver:
    case GoodId.gold: {
      const tone =
        good === GoodId.iron
          ? 0x5a5350
          : good === GoodId.silver
            ? 0xc4cad2
            : 0xe0b44a;
      const a = mesh(new THREE.BoxGeometry(0.24, 0.07, 0.1), tone);
      add(a);
      const b = mesh(new THREE.BoxGeometry(0.24, 0.07, 0.1), tone);
      b.position.set(0, 0.07, 0.02);
      b.rotation.y = 0.35;
      add(b);
      g.position.y = 0.9;
      break;
    }
    case GoodId.sword: {
      // Sheathed arming sword: leather scabbard, straight crossguard.
      // Parts sit along the same yaw as the scabbard, so their offsets are
      // (d·cos 0.35, −d·sin 0.35) for a distance d up the blade.
      const scabbard = mesh(new THREE.BoxGeometry(0.44, 0.05, 0.075), wood);
      scabbard.rotation.y = 0.35;
      add(scabbard);
      const guard = mesh(new THREE.BoxGeometry(0.035, 0.045, 0.19), 0x9aa0a8);
      guard.position.set(0.216, 0.005, -0.079);
      guard.rotation.y = 0.35;
      add(guard);
      const grip = mesh(new THREE.BoxGeometry(0.1, 0.04, 0.042), 0x2c2018);
      grip.position.set(0.268, 0.005, -0.098);
      grip.rotation.y = 0.35;
      add(grip);
      const pommel = mesh(new THREE.SphereGeometry(0.032, 6, 5), 0x9aa0a8);
      pommel.position.set(0.315, 0.005, -0.115);
      add(pommel);
      g.position.y = 0.92;
      break;
    }
    case GoodId.spear: {
      const shaft = mesh(
        new THREE.CylinderGeometry(0.022, 0.022, 1.05, 5),
        goodColorsLocal[GoodId.spear],
      );
      shaft.rotation.z = Math.PI / 2;
      shaft.rotation.y = 0.25;
      add(shaft);
      const tip = mesh(new THREE.ConeGeometry(0.045, 0.14, 5), 0xd8dde3);
      tip.rotation.z = -Math.PI / 2;
      tip.position.set(0.57, 0, -0.14);
      tip.rotation.y = 0.25;
      add(tip);
      g.position.y = 0.92;
      break;
    }
    case GoodId.bow: {
      const bow = mesh(
        new THREE.TorusGeometry(0.26, 0.022, 5, 10, Math.PI),
        goodColorsLocal[GoodId.bow],
      );
      bow.rotation.z = Math.PI / 2;
      add(bow);
      g.position.y = 0.85;
      break;
    }
    case GoodId.flour: {
      // A milled sack: plumper than the grain sack the pack ships, and pale
      // with the dust of it, so the two never read alike on a road.
      const body = mesh(new THREE.SphereGeometry(0.13, 8, 6), 0xe4dcc9);
      body.scale.set(1.05, 0.9, 0.8);
      add(body);
      const neck = mesh(
        new THREE.CylinderGeometry(0.05, 0.07, 0.06, 6),
        0xd6ccb4,
      );
      neck.position.y = 0.11;
      add(neck);
      const tie = mesh(
        new THREE.CylinderGeometry(0.045, 0.045, 0.018, 6),
        0x8a6c3c,
      );
      tie.position.y = 0.1;
      add(tie);
      g.position.y = 0.9;
      break;
    }
    case GoodId.food: {
      // Loaves in the crook of an arm: three round ones, slashed.
      for (const [dx, dy, dz, r] of [
        [-0.07, 0, 0.01, 0.075],
        [0.06, 0.005, -0.02, 0.08],
        [0, 0.075, 0, 0.07],
      ] as const) {
        const loaf = mesh(
          new THREE.SphereGeometry(r, 7, 5),
          goodColorsLocal[GoodId.food],
        );
        loaf.scale.set(1.35, 0.72, 0.85);
        loaf.position.set(dx, dy, dz);
        add(loaf);
        const slash = mesh(
          new THREE.BoxGeometry(0.012, 0.014, r * 0.9),
          0xf0dcb8,
        );
        slash.position.set(dx, dy + r * 0.62, dz);
        add(slash);
      }
      g.position.y = 0.91;
      break;
    }
    case GoodId.scythe: {
      // Pre-load fallback for the Fantasy Weapons Bits scythe (PACK_CARRY):
      // a snath over the shoulder with the blade hooked out past one end,
      // lying flat the way the pack tools are laid.
      const snath = mesh(
        new THREE.CylinderGeometry(0.02, 0.024, 0.72, 5),
        woodLight,
      );
      snath.rotation.z = Math.PI / 2;
      add(snath);
      const blade = mesh(
        new THREE.TorusGeometry(0.12, 0.016, 4, 10, 1.9),
        0x8b95a0,
      );
      blade.position.set(0.34, 0, 0.02);
      blade.rotation.x = Math.PI / 2;
      blade.scale.y = 0.5; // a blade, not a hoop: flattened along its arc
      add(blade);
      g.position.y = 0.9;
      break;
    }
    case GoodId.ale: {
      // A stout ale cask, iron-hooped, carried on its side.
      const staves = mesh(
        new THREE.CylinderGeometry(0.1, 0.1, 0.26, 10),
        0x8a6033,
      );
      staves.rotation.z = Math.PI / 2;
      add(staves);
      const belly = mesh(
        new THREE.CylinderGeometry(0.115, 0.115, 0.12, 10),
        0x8a6033,
      );
      belly.rotation.z = Math.PI / 2;
      add(belly);
      for (const sx of [-0.085, 0.085]) {
        const hoop = mesh(
          new THREE.CylinderGeometry(0.106, 0.106, 0.022, 10),
          0x3a3128,
        );
        hoop.rotation.z = Math.PI / 2;
        hoop.position.x = sx;
        add(hoop);
      }
      g.position.y = 0.93;
      break;
    }
  }
  return g;
}

const carryPrototypes = new Map<GoodId, THREE.Group>();

/** The visible good on a carrier's shoulders, by SAB carry code. */
/** Goods whose carried look comes from the pack's own resource piles, so
 * what's on a serf's arms matches what's stacked in the yards. */
const PACK_CARRY: Partial<
  Record<
    GoodId,
    {
      prop: string;
      span: number;
      rot?: [number, number, number];
    }
  >
> = {
  // Resource Bits (CC0): the raw goods, one unit on the arms — a single
  // board, a single dressed stone, a single bar. Ground stock bundles them
  // up (PILE_TIERS).
  [GoodId.wood]: {
    prop: 'resources/Wood_Plank_A',
    span: 0.46,
    rot: [0, Math.PI / 2, 0],
  },
  // Long side across the arms, like the board; authored running along z,
  // they would stick straight out of the carrier's chest.
  [GoodId.stone]: {
    prop: 'resources/Stone_Brick',
    span: 0.26,
    rot: [0, Math.PI / 2, 0],
  },
  [GoodId.iron]: {
    prop: 'resources/Iron_Bar',
    span: 0.24,
    rot: [0, Math.PI / 2, 0],
  },
  [GoodId.silver]: {
    prop: 'resources/Silver_Bar',
    span: 0.24,
    rot: [0, Math.PI / 2, 0],
  },
  [GoodId.gold]: {
    prop: 'resources/Gold_Bar',
    span: 0.24,
    rot: [0, Math.PI / 2, 0],
  },
  // The procedural shoulder-pole carry spanned most of a tile; water
  // travels by the hand-sized pack bucket instead.
  [GoodId.water]: {prop: 'bucket_water', span: 0.26},
  [GoodId.wheat]: {prop: 'sack', span: 0.3},
  [GoodId.ale]: {prop: 'barrel', span: 0.3},
  // The tools ride from RPG Tools Bits, laid across the arms (they are
  // authored standing, handle up +Y — the rot is what lays them down and
  // what the span is measured against). The scythe is Fantasy Weapons
  // Bits' (RPG Tools ships none); the cauldron is the pack's metal bucket.
  [GoodId.axe]: {prop: 'tools/axe', span: 0.4, rot: [0, 0, Math.PI / 2]},
  [GoodId.pickaxe]: {
    prop: 'tools/pickaxe',
    span: 0.42,
    rot: [0, 0, Math.PI / 2],
  },
  [GoodId.hammer]: {prop: 'tools/hammer', span: 0.34, rot: [0, 0, Math.PI / 2]},
  [GoodId.cauldron]: {prop: 'tools/bucket_metal', span: 0.26},
  // Laid down like the other hafted tools; the blade hooks out sideways,
  // which is most of the span and all of the silhouette.
  [GoodId.scythe]: {
    prop: 'weapons/scythe',
    span: 0.46,
    rot: [0, 0, Math.PI / 2],
  },
  [GoodId.rod]: {
    prop: 'tools/fishing_rod',
    span: 0.5,
    rot: [0, 0, Math.PI / 2],
  },
};

/** Ground stock renders a quarter larger than the carried version: at
 * village zoom the true-size stacks read as ground clutter, not goods. */
export const PILE_SCALE = 1.25;

/**
 * A single unit of a good as a small grounded prop, for the stock piles
 * that grow beside buildings — same look as the carried version, base on
 * the ground.
 */
export function makePileProp(good: GoodId): THREE.Group {
  const pack = PACK_CARRY[good];
  // Clone from the shared prototype cache (like makeCarryProp): building
  // a fresh carryProto per pile minted new geometries/materials each call,
  // which buildingSync's bare remove() then leaked on the GPU.
  const inner =
    (pack && glbCarryProp(pack.prop, 0.3, pack.rot)) ??
    cachedCarryProto(good).clone();
  if (!pack) {
    inner.position.set(0, 0, 0); // strip the carry-height offset
    inner.scale.setScalar(0.62);
  }
  inner.scale.multiplyScalar(PILE_SCALE);
  const g = new THREE.Group();
  g.add(inner);
  const bb = new THREE.Box3().setFromObject(g);
  inner.position.y -= bb.min.y;
  return g;
}

/**
 * How a good whose unit is squared-off — a board, a dressed stone, a bar —
 * piles at a door: the way a yard would stack it, not heaped. Up to a few
 * units lie loose; past that they are strapped into the pack's own bundles,
 * each of which holds exactly `units` of them (counted off the models), so
 * the pile is the count: five boards are a banded four and one loose, not
 * five of anything.
 *
 * Every model is drawn at one `scale` (world units per pack unit), and the
 * pack authors every board the same size in every stack, so a loose board
 * and a board in a bundle are the same board.
 */
interface PileTiers {
  scale: number;
  /** Turned by this before laying: boards parallel to the wall. */
  yaw: number;
  /** The loose unit, and how many lie side by side in a layer of them. */
  unit: string;
  perLayer: number;
  /** Alternate layers turn a quarter, the way bars are stacked. */
  crisscross?: boolean;
  /** Units one door pile holds before the rest start another beside it
   * (pileChunks) — what fits in a lane without towering or running deep. */
  laneCap: number;
  /**
   * Largest first. A repeat of a bundle is set on top of the one before,
   * unless `rests` is false — a roped pyramid of bars has a ridge for a
   * top, and a tower of them on a tower would topple — in which case
   * repeats go `across` to a row (default 1), rows running out from the
   * wall.
   */
  tiers: {prop: string; units: number; rests?: false; across?: number}[];
}

const PILE_TIERS: Partial<Record<GoodId, PileTiers>> = {
  [GoodId.wood]: {
    scale: 0.28,
    yaw: Math.PI / 2,
    unit: 'resources/Wood_Plank_A',
    perLayer: 2,
    laneCap: 64,
    tiers: [
      {prop: 'resources/Wood_Planks_Stack_Large', units: 32},
      {prop: 'resources/Wood_Planks_Stack_Medium', units: 16},
      {prop: 'resources/Wood_Planks_Stack_Small', units: 4},
    ],
  },
  [GoodId.stone]: {
    scale: 0.3,
    yaw: 0,
    unit: 'resources/Stone_Brick',
    perLayer: 2,
    laneCap: 48,
    tiers: [
      {prop: 'resources/Stone_Bricks_Stack_Large', units: 24},
      {prop: 'resources/Stone_Bricks_Stack_Medium', units: 12},
      {prop: 'resources/Stone_Bricks_Stack_Small', units: 4},
    ],
  },
  ...Object.fromEntries(
    (
      [
        [GoodId.iron, 'Iron'],
        [GoodId.silver, 'Silver'],
        [GoodId.gold, 'Gold'],
      ] as const
    ).map(([good, metal]) => [
      good,
      {
        scale: 0.28,
        yaw: 0,
        unit: `resources/${metal}_Bar`,
        perLayer: 2,
        crisscross: true,
        // The pack's whole progression, counted by mesh volume: a roped
        // pyramid of 6, a tower of 12 (slim enough to stand two across a
        // lane), and the block of 48 that is four towers square — a full
        // lane on its own.
        laneCap: 48,
        tiers: [
          {prop: `resources/${metal}_Bars_Stack_Large`, units: 48},
          {
            prop: `resources/${metal}_Bars_Stack_Medium`,
            units: 12,
            rests: false,
            across: 2,
          },
          {prop: `resources/${metal}_Bars`, units: 6, rests: false},
        ],
      } satisfies PileTiers,
    ]),
  ),
};

/** Units one door pile holds before the rest start another beside it:
 * the tiered good's own laneCap, or three layers of three heaped. */
export function laneCap(good: GoodId): number {
  return PILE_TIERS[good]?.laneCap ?? 9;
}

/**
 * `n` units of a good split into door piles, each a lane of its own: full
 * ones first, the remainder last. There is no cap — a storehouse holding
 * forty bars shows forty bars, in as many piles as that takes.
 */
export function pileChunks(good: GoodId, n: number): number[] {
  const cap = laneCap(good);
  const out: number[] = [];
  for (let left = n; left > 0; left -= cap) out.push(Math.min(left, cap));
  return out;
}

/** Centre-to-centre spacing of door-pile lanes. The lattice grows with the
 * props (PILE_SCALE), or the fatter stacks interpenetrate. */
export const PILE_LANE = 0.42 * PILE_SCALE;

/** Back edge of a door pile, lane-local: just off the wall. */
const PILE_BACK = -0.26;
/** Air between bundles laid one in front of the next. */
const PILE_GAP = 0.03;

const SCRATCH_BOX = new THREE.Box3();

/**
 * A tiered good's whole door pile for `n` units, lane-local (x across the
 * lane, z out from the wall, y up), or null when the good heaps instead or
 * the pack has not loaded — the caller then lays units with pileSlot.
 * Bundles go against the wall, biggest first, a repeat of the same bundle
 * set on top of the one before (or in rows out from the wall, when it
 * `rests` nothing); loose units lie in front, `perLayer` to a layer. Any
 * `n` lays; keeping it to laneCap is pileChunks' job.
 */
export function makeTieredPile(good: GoodId, n: number): THREE.Group | null {
  const t = PILE_TIERS[good];
  if (!t || !hasGlbProp(t.unit)) return null;
  const g = new THREE.Group();
  /** Front edge of what is down so far. */
  let front = PILE_BACK;
  /** One bundle: on top of `below`, or else in a row that starts at the
   * current front — slot `col` of `cols` across it. */
  const place = (
    prop: string,
    below: THREE.Object3D | null,
    col = 0,
    cols = 1,
  ): THREE.Object3D | null => {
    const item = glbPropAtScale(prop, t.scale);
    if (!item) return null;
    item.rotation.y = t.yaw;
    const size = SCRATCH_BOX.setFromObject(item).getSize(SCRATCH_SIZE);
    if (below) {
      item.position.set(below.position.x, below.userData.top, below.position.z);
    } else {
      item.position.set(
        (col - (cols - 1) / 2) * (size.x + PILE_GAP),
        0,
        front + size.z / 2,
      );
      // A row is only as deep as one of its bundles, and only its last
      // bundle moves the front on.
      if (col === cols - 1) front += size.z + PILE_GAP;
    }
    item.userData.top = item.position.y + size.y;
    g.add(item);
    return item;
  };
  let left = n;
  for (const tier of t.tiers) {
    const count = Math.floor(left / tier.units);
    left %= tier.units;
    if (tier.rests !== false) {
      let below: THREE.Object3D | null = null;
      for (let k = 0; k < count; k++) below = place(tier.prop, below);
      continue;
    }
    const across = tier.across ?? 1;
    for (let k = 0; k < count; k++) {
      // The last row closes the front even when it is short of full.
      const cols = Math.min(across, count - k + (k % across));
      place(tier.prop, null, k % across, cols);
    }
  }
  // Loose units, a layer at a time, side by side across the unit's own
  // width; a crisscrossed layer turns a quarter and spreads the other way.
  const unit = glbPropAtScale(t.unit, t.scale);
  if (!unit || left === 0) return g;
  unit.rotation.y = t.yaw;
  const u = SCRATCH_BOX.setFromObject(unit).getSize(new THREE.Vector3());
  const cell = Math.min(u.x, u.z);
  // The first layer's depth off the wall sets where the loose rows start.
  const z0 = front + (u.x < u.z ? u.z : t.perLayer * cell) / 2;
  for (let i = 0; i < left; i++) {
    const layer = (i / t.perLayer) | 0;
    const slot = (i % t.perLayer) - (t.perLayer - 1) / 2;
    const turned = t.crisscross === true && layer % 2 === 1;
    const item = i === 0 ? unit : glbPropAtScale(t.unit, t.scale)!;
    item.rotation.y = t.yaw + (turned ? Math.PI / 2 : 0);
    // Side by side along whichever ground axis is the unit's narrow one.
    const along = u.x < u.z !== turned;
    item.position.set(
      along ? slot * cell : 0,
      layer * u.y,
      z0 + (along ? 0 : slot * cell),
    );
    g.add(item);
  }
  return g;
}

const SCRATCH_SIZE = new THREE.Vector3();

/**
 * Where the `i`th unit of a heaped good's door pile goes, relative to its
 * lane's centre: [x, y, z, yaw]. Three to a layer, front to back, each set
 * down a little off true by `ja` and `jb` — hash draws in [0, 1), so a
 * heap stays the same heap from one rebuild to the next.
 */
export function pileSlot(
  i: number,
  ja: number,
  jb: number,
): [number, number, number, number] {
  const row = i % 3;
  const layer = (i / 3) | 0;
  return [
    (ja - 0.5) * 0.06,
    layer * 0.12 * PILE_SCALE,
    (row * 0.17 - 0.17) * PILE_SCALE,
    (jb - 0.5) * 0.7,
  ];
}

export function makeCarryProp(carryCode: number): THREE.Group | null {
  const good = GOODS[carryCode - 1];
  if (!good) return null;
  const pack = PACK_CARRY[good];
  if (pack) {
    const prop = glbCarryProp(pack.prop, pack.span, pack.rot);
    if (prop) {
      // The chest anchor sits at the palms: stand the prop off by its own
      // half-depth so round loads (bucket, barrel) rest against the hands
      // instead of clipping through the torso. The offset lives on an
      // inner node because sceneSync zeroes the carry box's own position
      // when it parents it to the anchor (that reset strips the procedural
      // protos' baked carry height). Anchor space is world units.
      const bb = new THREE.Box3().setFromObject(prop);
      prop.position.z = (bb.max.z - bb.min.z) / 2;
      const held = new THREE.Group();
      held.add(prop);
      return held;
    }
  }
  return cachedCarryProto(good).clone();
}

/** Shared procedural prototype per good; clones share geometry/materials. */
function cachedCarryProto(good: GoodId): THREE.Group {
  let proto = carryPrototypes.get(good);
  if (!proto) {
    proto = carryProto(good);
    carryPrototypes.set(good, proto);
  }
  return proto;
}
