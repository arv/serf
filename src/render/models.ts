import type { Enum } from '../shared/enum.ts';
import * as THREE from 'three';
import type { BuildingTypeId } from '../sim/entities';
import { GOODS } from '../sim/defs/goods';
import { makeGlbBuilding, glbCarryProp } from './assets';
import { mapMaterials } from './materials';
import { goodColors as goodColorsLocal, rock, stalk, stoneRoad, wood, woodLight } from './palette';
import { planks, plaster, roofTiles, stoneBlocks, thatch } from './buildingTextures';
import * as GoodId from '../sim/defs/goodIdEnum.ts';

type GoodId = Enum<typeof GoodId>;

export { goodColors } from './palette';

/**
 * Shared procedural props: site frames, the road-work pile, ghost tinting,
 * stock piles and carried goods. Building and unit bodies come exclusively
 * from the GLB assets — the old procedural fallback town (which wore the
 * legacy japan look and appeared whenever the asset fetch hiccuped) is
 * gone; asset loading now retries and fails loudly instead.
 */

export function mesh(geo: THREE.BufferGeometry, color: number): THREE.Mesh {
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// Shared textured materials (textures are cached; materials should be too).
const matCache = new Map<THREE.Texture, THREE.MeshLambertMaterial>();
function texMat(texture: THREE.Texture): THREE.MeshLambertMaterial {
  let m = matCache.get(texture);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ map: texture });
    matCache.set(texture, m);
  }
  return m;
}

function tmesh(geo: THREE.BufferGeometry, texture: THREE.Texture): THREE.Mesh {
  const m = new THREE.Mesh(geo, texMat(texture));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// The texture wardrobe.
const TEX = {
  roofOrange: () => roofTiles('#c9722e'),
  roofSlate: () => roofTiles('#4d5462'),
  roofIndigo: () => roofTiles('#3f508c'),
  roofVermillion: () => roofTiles('#b03a30'),
  thatch: () => thatch('#8a7434'),
  thatchDark: () => thatch('#5c4c26'),
  plank: () => planks('#6e5233'),
  plankDark: () => planks('#463323'),
  plaster: () => plaster('#e6d9ba'),
  stone: () => stoneBlocks('#8a8272'),
};

export function makeRoadPile(): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const s = mesh(new THREE.DodecahedronGeometry(0.12), stoneRoad);
    s.position.set((i - 1) * 0.18, 0.08, (i % 2) * 0.15 - 0.07);
    g.add(s);
  }
  return g;
}

export function makeGhostModel(type: BuildingTypeId, opacity = 0.45, owner = 0): THREE.Group {
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
  g.traverse((obj) => {
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

export function lathe(profile: [number, number][], color: number, segments = 10): THREE.Mesh {
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
      const pole = mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.78, 5), woodLight);
      pole.rotation.z = Math.PI / 2;
      add(pole);
      for (const sx of [-0.36, 0.36]) {
        const rope = mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.16, 3), 0x2a2018);
        rope.position.set(sx, -0.09, 0);
        add(rope);
        const pail = mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.09, 7), wood);
        pail.position.set(sx, -0.2, 0);
        add(pail);
        const waterTop = mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.012, 7), 0x4a708c);
        waterTop.position.set(sx, -0.155, 0);
        add(waterTop);
      }
      g.position.y = 0.88;
      break;
    }
    case GoodId.wheat: {
      // A straw grain bale with rope bindings.
      const bale = mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.32, 8), 0xd8c288);
      bale.rotation.z = Math.PI / 2;
      add(bale);
      for (const sx of [-0.09, 0.09]) {
        const band = mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.025, 8), 0x8a6c3c);
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
      const tone = good === GoodId.iron ? 0x5a5350 : good === GoodId.silver ? 0xc4cad2 : 0xe0b44a;
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
      const neck = mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.06, 6), 0xd6ccb4);
      neck.position.y = 0.11;
      add(neck);
      const tie = mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.018, 6), 0x8a6c3c);
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
        const loaf = mesh(new THREE.SphereGeometry(r, 7, 5), goodColorsLocal[GoodId.food]);
        loaf.scale.set(1.35, 0.72, 0.85);
        loaf.position.set(dx, dy, dz);
        add(loaf);
        const slash = mesh(new THREE.BoxGeometry(0.012, 0.014, r * 0.9), 0xf0dcb8);
        slash.position.set(dx, dy + r * 0.62, dz);
        add(slash);
      }
      g.position.y = 0.91;
      break;
    }
    case GoodId.scythe: {
      // The one tool RPG Tools Bits does not ship: a snath over the
      // shoulder with the blade hooked out past one end, lying flat the
      // way the pack tools are laid by PACK_CARRY.
      const snath = mesh(new THREE.CylinderGeometry(0.02, 0.024, 0.72, 5), woodLight);
      snath.rotation.z = Math.PI / 2;
      add(snath);
      const blade = mesh(new THREE.TorusGeometry(0.12, 0.016, 4, 10, 1.9), 0x8b95a0);
      blade.position.set(0.34, 0, 0.02);
      blade.rotation.x = Math.PI / 2;
      blade.scale.y = 0.5; // a blade, not a hoop: flattened along its arc
      add(blade);
      g.position.y = 0.9;
      break;
    }
    case GoodId.ale: {
      // A stout ale cask, iron-hooped, carried on its side.
      const staves = mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.26, 10), 0x8a6033);
      staves.rotation.z = Math.PI / 2;
      add(staves);
      const belly = mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.12, 10), 0x8a6033);
      belly.rotation.z = Math.PI / 2;
      add(belly);
      for (const sx of [-0.085, 0.085]) {
        const hoop = mesh(new THREE.CylinderGeometry(0.106, 0.106, 0.022, 10), 0x3a3128);
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
  Record<GoodId, { prop: string; span: number; rot?: [number, number, number] }>
> = {
  [GoodId.wood]: { prop: 'resource_lumber', span: 0.44 },
  [GoodId.stone]: { prop: 'resource_stone', span: 0.36 },
  // The procedural shoulder-pole carry spanned most of a tile; water
  // travels by the hand-sized pack bucket instead.
  [GoodId.water]: { prop: 'bucket_water', span: 0.26 },
  [GoodId.wheat]: { prop: 'sack', span: 0.3 },
  [GoodId.ale]: { prop: 'barrel', span: 0.3 },
  // The tools ride from RPG Tools Bits, laid across the arms (they are
  // authored standing, handle up +Y — the rot is what lays them down and
  // what the span is measured against). The scythe has no pack model and
  // keeps its procedural carry; the cauldron is the pack's metal bucket.
  [GoodId.axe]: { prop: 'tools/axe', span: 0.4, rot: [0, 0, Math.PI / 2] },
  [GoodId.pickaxe]: { prop: 'tools/pickaxe', span: 0.42, rot: [0, 0, Math.PI / 2] },
  [GoodId.hammer]: { prop: 'tools/hammer', span: 0.34, rot: [0, 0, Math.PI / 2] },
  [GoodId.cauldron]: { prop: 'tools/bucket_metal', span: 0.26 },
  [GoodId.rod]: { prop: 'tools/fishing_rod', span: 0.5, rot: [0, 0, Math.PI / 2] },
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
  const inner = (pack && glbCarryProp(pack.prop, 0.3, pack.rot)) ?? cachedCarryProto(good).clone();
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
