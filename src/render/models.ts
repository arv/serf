import * as THREE from 'three';
import type { BuildingTypeId } from '../sim/entities';
import { goodColors as goodColorsLocal, palette } from './palette';
import { planks, plaster, roofTiles, stoneBlocks, thatch } from './buildingTextures';

export { goodColors } from './palette';

/**
 * Procedural building models: primitives dressed in canvas-painted textures.
 * The Battle Realms language — scalloped tile roofs with deep eaves and
 * ridge beams, plank and plaster walls in timber frames, stone plinths,
 * lanterns and props. Each factory returns a fresh Group whose origin is the
 * footprint center at ground level.
 */

function mesh(geo: THREE.BufferGeometry, color: number): THREE.Mesh {
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

/**
 * A hipped, tiled roof: four-sided truncated pyramid wearing the scalloped
 * tile texture (one texture width per face), with a deep eave skirt, upturned
 * corners, and a timber ridge beam — the BR roof in one helper.
 */
function hipRoof(width: number, height: number, texture: THREE.Texture): THREE.Group {
  const g = new THREE.Group();
  const radius = width * 0.74;

  const tiles = texture.clone();
  tiles.repeat.set(4, 1); // one copy per face
  const body = tmesh(new THREE.CylinderGeometry(0.09, radius, height, 4, 1), tiles);
  body.rotation.y = Math.PI / 4;
  body.position.y = height / 2;
  g.add(body);

  // Deep eave skirt.
  const eave = width * 1.06;
  const skirt = mesh(new THREE.BoxGeometry(eave, 0.07, eave), palette.wood);
  skirt.position.y = 0.0;
  g.add(skirt);

  // Upturned corners — the eave flip.
  const half = eave / 2 - 0.06;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const flip = mesh(new THREE.BoxGeometry(0.3, 0.06, 0.3), palette.wood);
      flip.position.set(sx * half, 0.07, sz * half);
      flip.rotation.set(sz * -0.42, 0, sx * 0.42);
      g.add(flip);
    }
  }

  // Ridge cap + finials.
  const ridge = mesh(new THREE.BoxGeometry(0.34, 0.09, 0.34), palette.wood);
  ridge.position.y = height + 0.02;
  ridge.rotation.y = Math.PI / 4;
  g.add(ridge);
  const finial = mesh(new THREE.SphereGeometry(0.07, 6, 5), palette.woodLight);
  finial.position.y = height + 0.1;
  g.add(finial);

  return g;
}

function post(x: number, z: number, h: number): THREE.Mesh {
  const p = mesh(new THREE.BoxGeometry(0.14, h, 0.14), palette.wood);
  p.position.set(x, h / 2, z);
  return p;
}

/** Recessed doorway with a lintel on the +z face. */
function doorway(g: THREE.Group, z: number, y = 0): void {
  const opening = mesh(new THREE.BoxGeometry(0.36, 0.52, 0.06), 0x1c130a);
  opening.position.set(0, y + 0.26, z);
  g.add(opening);
  const lintel = mesh(new THREE.BoxGeometry(0.5, 0.07, 0.1), palette.wood);
  lintel.position.set(0, y + 0.56, z);
  g.add(lintel);
}

/** Small dark window with a sill. */
function window_(g: THREE.Group, x: number, y: number, z: number, rotY = 0): void {
  const w = mesh(new THREE.BoxGeometry(0.22, 0.26, 0.05), 0x241a10);
  w.position.set(x, y, z);
  w.rotation.y = rotY;
  g.add(w);
}

const lanternMaterial = new THREE.MeshBasicMaterial({ color: palette.lantern });

/** A glowing paper lantern (basic material ignores lighting = emissive look). */
function lantern(x: number, y: number, z: number): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), lanternMaterial);
  body.scale.y = 1.25;
  g.add(body);
  const cap = mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.04, 6), palette.wood);
  cap.position.y = 0.13;
  cap.castShadow = false;
  g.add(cap);
  g.position.set(x, y, z);
  return g;
}

function makeStorehouse(): THREE.Group {
  const g = new THREE.Group();

  // Stone plinth, granary-raised.
  const plinth = tmesh(new THREE.BoxGeometry(2.9, 0.3, 2.9), TEX.stone());
  plinth.position.y = 0.15;
  g.add(plinth);

  // Lower hall: plank walls in a timber frame.
  const base = tmesh(new THREE.BoxGeometry(2.5, 1.1, 2.5), TEX.plank());
  base.position.y = 0.85;
  g.add(base);
  for (const sx of [-1.2, 1.2]) for (const sz of [-1.2, 1.2]) g.add(post(sx, sz, 1.5));
  const beam = mesh(new THREE.BoxGeometry(2.56, 0.1, 0.1), palette.wood);
  beam.position.set(0, 1.42, 1.24);
  g.add(beam);
  doorway(g, 1.27, 0.3);
  window_(g, -0.75, 1.05, 1.26);
  window_(g, 0.75, 1.05, 1.26);

  const lowRoof = hipRoof(2.75, 0.85, TEX.roofOrange());
  lowRoof.position.y = 1.5;
  g.add(lowRoof);

  // Upper loft: plaster, with its own tiled cap.
  const upper = tmesh(new THREE.BoxGeometry(1.35, 0.62, 1.35), TEX.plaster());
  upper.position.y = 2.55;
  g.add(upper);
  window_(g, 0, 2.6, 0.69);
  const topRoof = hipRoof(1.6, 0.7, TEX.roofOrange());
  topRoof.position.y = 2.9;
  g.add(topRoof);

  // Rice sacks and a barrel by the door.
  for (const [sx, sz, s] of [
    [-0.95, 1.55, 1],
    [-0.7, 1.62, 0.8],
  ] as const) {
    const sack = mesh(new THREE.SphereGeometry(0.16 * s, 7, 5), 0xd8c298);
    sack.scale.y = 0.75;
    sack.position.set(sx, 0.42 + 0.1 * s, sz);
    g.add(sack);
  }
  const barrel = tmesh(new THREE.CylinderGeometry(0.14, 0.16, 0.34, 8), TEX.plank());
  barrel.position.set(0.95, 0.47, 1.5);
  g.add(barrel);

  // Lanterns flanking the door.
  g.add(lantern(-1.1, 1.25, 1.32));
  g.add(lantern(1.1, 1.25, 1.32));

  return g;
}

function makeBambooHut(): THREE.Group {
  const g = workshopBase({ wall: TEX.plank(), roofTex: TEX.thatch(), roofFlat: true });
  // Lean-to bamboo rack at the side.
  const rack = mesh(new THREE.BoxGeometry(0.12, 0.5, 0.9), palette.bambooCulm);
  rack.position.set(0.95, 0.25, 0);
  rack.rotation.z = 0.5;
  g.add(rack);
  const bundle = mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.8, 6), palette.bambooCulmOld);
  bundle.position.set(0.8, 0.12, -0.45);
  bundle.rotation.z = Math.PI / 2.2;
  g.add(bundle);
  return g;
}

/**
 * Shared small-workshop base: stone footing, textured walls in a timber
 * frame, doorway, window, and a tiled or thatched hip roof.
 */
function workshopBase(opts: {
  wall: THREE.Texture;
  roofTex: THREE.Texture;
  size?: number;
  roofFlat?: boolean;
}): THREE.Group {
  const size = opts.size ?? 1.5;
  const g = new THREE.Group();

  const footing = tmesh(new THREE.BoxGeometry(size + 0.2, 0.14, size + 0.2), TEX.stone());
  footing.position.y = 0.07;
  g.add(footing);

  const base = tmesh(new THREE.BoxGeometry(size, 0.85, size), opts.wall);
  base.position.y = 0.5;
  g.add(base);
  const off = size * 0.48;
  for (const sx of [-off, off]) for (const sz of [-off, off]) g.add(post(sx, sz, 1.05));
  doorway(g, size / 2 + 0.02, 0.14);
  window_(g, -size * 0.28, 0.72, size / 2 + 0.02);

  const r = hipRoof(size + 0.25, opts.roofFlat ? 0.55 : 0.7, opts.roofTex);
  r.position.y = 1.02;
  g.add(r);
  return g;
}

function makeQuarry(): THREE.Group {
  const g = workshopBase({ wall: TEX.plank(), roofTex: TEX.roofSlate() });
  const pile = mesh(new THREE.DodecahedronGeometry(0.28), palette.rock);
  pile.position.set(0.85, 0.2, 0.4);
  pile.scale.y = 0.7;
  g.add(pile);
  const chiselBlock = tmesh(new THREE.BoxGeometry(0.34, 0.26, 0.34), TEX.stone());
  chiselBlock.position.set(-0.85, 0.13, 0.55);
  chiselBlock.rotation.y = 0.4;
  g.add(chiselBlock);
  return g;
}

function makeWell(): THREE.Group {
  const g = new THREE.Group();
  const ring = tmesh(new THREE.CylinderGeometry(0.32, 0.36, 0.35, 10), TEX.stone());
  ring.position.y = 0.18;
  g.add(ring);
  const water = mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.05, 10), palette.water);
  water.position.y = 0.34;
  g.add(water);
  for (const sx of [-0.3, 0.3]) {
    const p = mesh(new THREE.BoxGeometry(0.07, 0.85, 0.07), palette.wood);
    p.position.set(sx, 0.45, 0);
    g.add(p);
  }
  // Bucket on a crossbeam.
  const beam = mesh(new THREE.BoxGeometry(0.66, 0.05, 0.05), palette.wood);
  beam.position.y = 0.84;
  g.add(beam);
  const bucket = tmesh(new THREE.CylinderGeometry(0.07, 0.06, 0.1, 7), TEX.plank());
  bucket.position.y = 0.62;
  g.add(bucket);
  const r = hipRoof(0.85, 0.4, TEX.thatch());
  r.position.y = 0.92;
  g.add(r);
  return g;
}

function makeRicePaddy(): THREE.Group {
  const g = new THREE.Group();
  const water = mesh(new THREE.BoxGeometry(2.85, 0.12, 2.85), palette.water);
  water.position.y = 0.06;
  g.add(water);
  // Rows of seedlings.
  for (let row = -1; row <= 1; row++) {
    for (let col = -2; col <= 2; col++) {
      const sprout = mesh(new THREE.ConeGeometry(0.09, 0.3, 4), palette.bambooLeaf);
      sprout.position.set(col * 0.5, 0.24, row * 0.8);
      g.add(sprout);
    }
  }
  // Low earthen bund around the field.
  const bund = mesh(new THREE.BoxGeometry(3, 0.1, 0.18), palette.earthTrail);
  for (const sz of [-1.45, 1.45]) {
    const bb = bund.clone();
    bb.position.set(0, 0.1, sz);
    g.add(bb);
  }
  const bundEW = mesh(new THREE.BoxGeometry(0.18, 0.1, 3), palette.earthTrail);
  for (const sx of [-1.45, 1.45]) {
    const bb = bundEW.clone();
    bb.position.set(sx, 0.1, 0);
    g.add(bb);
  }
  return g;
}

function makeBrewery(): THREE.Group {
  const g = workshopBase({ wall: TEX.plaster(), roofTex: TEX.roofOrange() });
  const barrel = tmesh(new THREE.CylinderGeometry(0.24, 0.24, 0.5, 10), TEX.plank());
  barrel.position.set(0.85, 0.25, -0.35);
  g.add(barrel);
  const band = mesh(new THREE.CylinderGeometry(0.255, 0.255, 0.05, 10), 0x2a2a2e);
  band.position.set(0.85, 0.3, -0.35);
  g.add(band);
  // Sakabayashi: the cedar ball that marks a brewery.
  const sugidama = mesh(new THREE.SphereGeometry(0.13, 8, 6), palette.bambooLeafDark);
  sugidama.position.set(0.45, 0.98, 0.78);
  g.add(sugidama);
  return g;
}

function makeMine(oreColor: number): () => THREE.Group {
  return () => {
    const g = workshopBase({ wall: TEX.plankDark(), roofTex: TEX.roofSlate() });
    // Timber portal.
    const lintel = mesh(new THREE.BoxGeometry(0.7, 0.12, 0.12), palette.wood);
    lintel.position.set(0, 0.62, 0.82);
    g.add(lintel);
    for (const sx of [-0.3, 0.3]) {
      const jamb = mesh(new THREE.BoxGeometry(0.12, 0.6, 0.12), palette.wood);
      jamb.position.set(sx, 0.3, 0.82);
      g.add(jamb);
    }
    const ore = mesh(new THREE.OctahedronGeometry(0.2), oreColor);
    ore.position.set(0.8, 0.14, 0.5);
    g.add(ore);
    // Ore cart on stub rails.
    const cart = tmesh(new THREE.BoxGeometry(0.3, 0.18, 0.22), TEX.plankDark());
    cart.position.set(-0.8, 0.16, 0.6);
    g.add(cart);
    return g;
  };
}

function makeSwordsmith(): THREE.Group {
  const g = workshopBase({ wall: TEX.plankDark(), roofTex: TEX.roofSlate() });
  const chimney = tmesh(new THREE.BoxGeometry(0.24, 0.9, 0.24), TEX.stone());
  chimney.position.set(-0.55, 1.15, -0.45);
  g.add(chimney);
  const blade = mesh(new THREE.BoxGeometry(0.05, 0.55, 0.12), goodColorsLocal.katana);
  blade.position.set(0.8, 0.45, 0.3);
  blade.rotation.z = 0.6;
  g.add(blade);
  const anvil = mesh(new THREE.BoxGeometry(0.22, 0.16, 0.12), 0x33353b);
  anvil.position.set(0.72, 0.1, -0.3);
  g.add(anvil);
  return g;
}

function makeSpearmaker(): THREE.Group {
  const g = workshopBase({ wall: TEX.plank(), roofTex: TEX.roofSlate() });
  const shaft = mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.4, 5), goodColorsLocal.yari);
  shaft.position.set(0.8, 0.7, 0.2);
  shaft.rotation.z = 0.35;
  g.add(shaft);
  const tip = mesh(new THREE.ConeGeometry(0.07, 0.2, 5), goodColorsLocal.katana);
  tip.position.set(0.56, 1.36, 0.2);
  tip.rotation.z = 0.35;
  g.add(tip);
  return g;
}

function makeBowyer(): THREE.Group {
  const g = workshopBase({ wall: TEX.plank(), roofTex: TEX.thatch(), roofFlat: true });
  const bow = mesh(new THREE.TorusGeometry(0.4, 0.035, 6, 12, Math.PI), goodColorsLocal.yumi);
  bow.position.set(0.85, 0.55, 0.2);
  bow.rotation.z = Math.PI / 2;
  g.add(bow);
  return g;
}

function makeTerakoya(): THREE.Group {
  const g = workshopBase({ wall: TEX.plaster(), roofTex: TEX.roofVermillion(), size: 1.7 });
  // Small torii gate at the entrance.
  for (const sx of [-0.35, 0.35]) {
    const p = mesh(new THREE.BoxGeometry(0.09, 0.8, 0.09), palette.vermillion);
    p.position.set(sx, 0.4, 1.15);
    g.add(p);
  }
  const lintel = mesh(new THREE.BoxGeometry(1.05, 0.09, 0.12), palette.vermillion);
  lintel.position.set(0, 0.82, 1.15);
  g.add(lintel);
  g.add(lantern(-0.35, 0.62, 1.28));
  g.add(lantern(0.35, 0.62, 1.28));
  const lintel2 = mesh(new THREE.BoxGeometry(0.85, 0.07, 0.1), palette.wood);
  lintel2.position.set(0, 0.62, 1.15);
  g.add(lintel2);
  return g;
}

function makeDojo(): THREE.Group {
  const g = new THREE.Group();
  const footing = tmesh(new THREE.BoxGeometry(2.8, 0.22, 2.8), TEX.stone());
  footing.position.y = 0.11;
  g.add(footing);
  const base = tmesh(new THREE.BoxGeometry(2.5, 1.0, 2.5), TEX.plaster());
  base.position.y = 0.7;
  g.add(base);
  for (const sx of [-1.2, 1.2]) for (const sz of [-1.2, 1.2]) g.add(post(sx, sz, 1.3));
  doorway(g, 1.27, 0.2);
  window_(g, -0.8, 0.95, 1.26);
  window_(g, 0.8, 0.95, 1.26);
  const lowRoof = hipRoof(2.75, 0.8, TEX.roofIndigo());
  lowRoof.position.y = 1.3;
  g.add(lowRoof);
  const upper = tmesh(new THREE.BoxGeometry(1.2, 0.5, 1.2), TEX.plaster());
  upper.position.y = 2.25;
  g.add(upper);
  const topRoof = hipRoof(1.45, 0.6, TEX.roofIndigo());
  topRoof.position.y = 2.5;
  g.add(topRoof);
  // War banner poles at the gate.
  for (const sx of [-1.35, 1.35]) {
    const pole = mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.9, 4), palette.wood);
    pole.position.set(sx, 0.95, 1.35);
    g.add(pole);
    const banner = mesh(new THREE.BoxGeometry(0.26, 0.7, 0.02), palette.indigo);
    banner.position.set(sx + 0.14, 1.5, 1.35);
    g.add(banner);
  }
  // Crossed practice weapons at the door.
  const bokken = mesh(new THREE.BoxGeometry(0.05, 0.7, 0.05), palette.woodLight);
  bokken.position.set(-0.2, 0.5, 1.3);
  bokken.rotation.z = 0.5;
  g.add(bokken);
  const bokken2 = bokken.clone();
  bokken2.position.x = 0.2;
  bokken2.rotation.z = -0.5;
  g.add(bokken2);
  g.add(lantern(-1.15, 1.2, 1.25));
  g.add(lantern(1.15, 1.2, 1.25));
  return g;
}

function makeRoadPile(): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const s = mesh(new THREE.DodecahedronGeometry(0.12), palette.stoneRoad);
    s.position.set((i - 1) * 0.18, 0.08, (i % 2) * 0.15 - 0.07);
    g.add(s);
  }
  return g;
}

function makeBanditCamp(): THREE.Group {
  const g = new THREE.Group();

  // Palisade ring of stakes.
  const stakes = 14;
  for (let i = 0; i < stakes; i++) {
    const a = (i / stakes) * Math.PI * 2;
    if (a > 4.1 && a < 4.9) continue; // gap for the "gate"
    const h = 0.85 + ((i * 37) % 5) * 0.06;
    const s = mesh(new THREE.CylinderGeometry(0.09, 0.11, h, 5), palette.wood);
    s.position.set(Math.cos(a) * 1.35, h / 2, Math.sin(a) * 1.35);
    g.add(s);
  }

  // Ragged thatch tents.
  const tent1 = tmesh(new THREE.ConeGeometry(0.62, 0.95, 6), TEX.thatchDark());
  tent1.position.set(-0.45, 0.48, -0.2);
  g.add(tent1);
  const tent2 = tmesh(new THREE.ConeGeometry(0.5, 0.8, 6), TEX.thatchDark());
  tent2.position.set(0.55, 0.4, 0.45);
  g.add(tent2);
  // Loot pile and a skull-topped stake for menace.
  const loot = tmesh(new THREE.BoxGeometry(0.3, 0.2, 0.24), TEX.plankDark());
  loot.position.set(-0.2, 0.1, 0.75);
  loot.rotation.y = 0.5;
  g.add(loot);
  const skull = mesh(new THREE.SphereGeometry(0.07, 6, 5), 0xd8d2c0);
  skull.position.set(0.95, 1.05, -0.15);
  g.add(skull);

  // War banner.
  const pole = mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.9, 4), palette.wood);
  pole.position.set(0.15, 0.95, -0.6);
  g.add(pole);
  const banner = mesh(new THREE.BoxGeometry(0.42, 0.6, 0.02), palette.vermillion);
  banner.position.set(0.36, 1.55, -0.6);
  g.add(banner);

  return g;
}

const factories: Record<BuildingTypeId, () => THREE.Group> = {
  storehouse: makeStorehouse,
  banditCamp: makeBanditCamp,
  bambooHut: makeBambooHut,
  quarry: makeQuarry,
  well: makeWell,
  ricePaddy: makeRicePaddy,
  sakeBrewery: makeBrewery,
  ironMine: makeMine(palette.ironOre),
  silverMine: makeMine(palette.silverOre),
  goldMine: makeMine(palette.goldOre),
  swordsmith: makeSwordsmith,
  spearmaker: makeSpearmaker,
  bowyer: makeBowyer,
  terakoya: makeTerakoya,
  dojo: makeDojo,
  roadSite: makeRoadPile,
};

export function makeBuildingModel(type: BuildingTypeId): THREE.Group {
  return factories[type]();
}

/** Clone a building model with all materials made semi-transparent. */
export function makeGhostModel(type: BuildingTypeId, opacity = 0.45): THREE.Group {
  const g = makeBuildingModel(type);
  g.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      const mat = (obj.material as THREE.MeshLambertMaterial).clone();
      mat.transparent = true;
      mat.opacity = opacity;
      mat.depthWrite = false;
      obj.material = mat;
      obj.castShadow = false;
      obj.receiveShadow = false;
    }
  });
  return g;
}

/** Construction-site frame: corner posts + ground sill, Settlers-style. */
export function makeSiteFrame(w: number, h: number): THREE.Group {
  const g = new THREE.Group();
  const hw = w / 2 - 0.15;
  const hh = h / 2 - 0.15;
  for (const sx of [-hw, hw]) {
    for (const sz of [-hh, hh]) {
      g.add(post(sx, sz, 0.7));
    }
  }
  const sillNS = new THREE.BoxGeometry(w - 0.2, 0.08, 0.08);
  const sillEW = new THREE.BoxGeometry(0.08, 0.08, h - 0.2);
  for (const sz of [-hh, hh]) {
    const s = mesh(sillNS, palette.woodLight);
    s.position.set(0, 0.08, sz);
    g.add(s);
  }
  for (const sx of [-hw, hw]) {
    const s = mesh(sillEW, palette.woodLight);
    s.position.set(sx, 0.08, 0);
    g.add(s);
  }
  return g;
}

// ---------------------------------------------------------------------------
// Units — built once per kind, cloned per entity. Origin at feet.

function makeSerf(): THREE.Group {
  const g = new THREE.Group();
  const body = mesh(new THREE.CapsuleGeometry(0.16, 0.28, 3, 8), palette.paper);
  body.position.y = 0.36;
  g.add(body);
  const head = mesh(new THREE.SphereGeometry(0.11, 8, 6), 0xd9b38c);
  head.position.y = 0.72;
  g.add(head);
  // Straw kasa.
  const hat = mesh(new THREE.ConeGeometry(0.17, 0.09, 8), palette.grassDry);
  hat.position.y = 0.82;
  g.add(hat);
  return g;
}

function makeWorker(): THREE.Group {
  const g = makeSerf();
  // Bamboo-green sash marks a resident worker.
  const sash = mesh(new THREE.BoxGeometry(0.34, 0.08, 0.2), palette.bambooLeafDark);
  sash.position.y = 0.45;
  sash.rotation.z = 0.5;
  g.add(sash);
  return g;
}

/** Military read by silhouette: body color, headgear, weapon sliver. */
function soldier(bodyColor: number, opts: { kasa?: boolean; headband?: number }): THREE.Group {
  const g = new THREE.Group();
  const body = mesh(new THREE.CapsuleGeometry(0.17, 0.3, 3, 8), bodyColor);
  body.position.y = 0.38;
  g.add(body);
  const head = mesh(new THREE.SphereGeometry(0.11, 8, 6), 0xd9b38c);
  head.position.y = 0.76;
  g.add(head);
  if (opts.kasa) {
    const hat = mesh(new THREE.ConeGeometry(0.24, 0.1, 8), palette.grassDry);
    hat.position.y = 0.88;
    g.add(hat);
  }
  if (opts.headband !== undefined) {
    const band = mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.04, 8), opts.headband);
    band.position.y = 0.8;
    g.add(band);
  }
  return g;
}

function makeSamurai(): THREE.Group {
  const g = soldier(palette.indigo, { kasa: true });
  const katana = mesh(new THREE.BoxGeometry(0.04, 0.5, 0.07), goodColorsLocal.katana);
  katana.position.set(0.22, 0.5, -0.05);
  katana.rotation.z = 0.4;
  g.add(katana);
  return g;
}

function makeAshigaru(): THREE.Group {
  const g = soldier(palette.paper, { headband: palette.indigo });
  const yari = mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.3, 5), goodColorsLocal.yari);
  yari.position.set(0.2, 0.65, 0);
  g.add(yari);
  const tip = mesh(new THREE.ConeGeometry(0.05, 0.15, 5), goodColorsLocal.katana);
  tip.position.set(0.2, 1.35, 0);
  g.add(tip);
  return g;
}

function makeArcher(): THREE.Group {
  const g = soldier(palette.bambooLeafDark, { kasa: true });
  const bow = mesh(new THREE.TorusGeometry(0.3, 0.025, 6, 12, Math.PI), goodColorsLocal.yumi);
  bow.position.set(0.22, 0.5, 0);
  bow.rotation.z = Math.PI / 2;
  g.add(bow);
  return g;
}

function makeBandit(): THREE.Group {
  const g = soldier(palette.roofDark, { headband: palette.vermillion });
  const blade = mesh(new THREE.BoxGeometry(0.04, 0.4, 0.06), palette.rockDark);
  blade.position.set(0.2, 0.45, 0);
  blade.rotation.z = 0.5;
  g.add(blade);
  return g;
}

function makeBanditArcher(): THREE.Group {
  const g = soldier(palette.roofDark, { headband: palette.vermillion });
  const bow = mesh(new THREE.TorusGeometry(0.28, 0.025, 6, 12, Math.PI), palette.wood);
  bow.position.set(0.2, 0.5, 0);
  bow.rotation.z = Math.PI / 2;
  g.add(bow);
  return g;
}

function makeRonin(): THREE.Group {
  const g = soldier(0x2a2f3a, { kasa: true });
  g.scale.setScalar(1.15); // reads as the heavy
  const katana = mesh(new THREE.BoxGeometry(0.05, 0.55, 0.08), goodColorsLocal.katana);
  katana.position.set(0.22, 0.5, -0.05);
  katana.rotation.z = 0.4;
  g.add(katana);
  return g;
}

const unitFactories = new Map<number, () => THREE.Group>([
  [1, makeSerf],
  [2, makeWorker],
  [3, makeSamurai],
  [4, makeAshigaru],
  [5, makeArcher],
  [6, makeBandit],
  [7, makeBanditArcher],
  [8, makeRonin],
]);

const unitPrototypes = new Map<number, THREE.Group>();

/** Unit model by SAB kind code (see UNIT_DEFS kindCode). */
export function makeUnitModel(kindCode: number): THREE.Group {
  let proto = unitPrototypes.get(kindCode);
  if (!proto) {
    proto = (unitFactories.get(kindCode) ?? makeSerf)();
    unitPrototypes.set(kindCode, proto);
  }
  return proto.clone();
}

/** The visible good on a carrier's shoulders — the core fantasy, in one box. */
export function makeCarryBox(colorHex: number): THREE.Mesh {
  const box = mesh(new THREE.BoxGeometry(0.22, 0.16, 0.22), colorHex);
  box.position.y = 0.92;
  box.castShadow = false;
  return box;
}
