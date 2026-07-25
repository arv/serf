import * as THREE from 'three';
import type { BuildingTypeId } from '../sim/entities';
import { goodColors as goodColorsLocal, palette } from './palette';

export { goodColors } from './palette';

/**
 * Procedural building models composed from primitives. Each factory returns a
 * fresh Group whose origin is the building's footprint center at ground level.
 * The pagoda visual language: paper walls, dark timber posts, flattened
 * four-sided cone roofs.
 */

function mesh(geo: THREE.BufferGeometry, color: number): THREE.Mesh {
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** A four-sided "irimoya-ish" roof: flattened cone rotated to sit square. */
function roof(width: number, height: number, color: number): THREE.Mesh {
  const r = mesh(new THREE.ConeGeometry(width * 0.72, height, 4), color);
  r.rotation.y = Math.PI / 4;
  return r;
}

function post(x: number, z: number, h: number): THREE.Mesh {
  const p = mesh(new THREE.BoxGeometry(0.14, h, 0.14), palette.wood);
  p.position.set(x, h / 2, z);
  return p;
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

  const base = mesh(new THREE.BoxGeometry(2.5, 1.1, 2.5), palette.paper);
  base.position.y = 0.55;
  g.add(base);
  for (const sx of [-1.2, 1.2]) for (const sz of [-1.2, 1.2]) g.add(post(sx, sz, 1.25));

  const lowRoof = roof(2.6, 0.85, palette.roofOrange);
  lowRoof.position.y = 1.55;
  g.add(lowRoof);

  const upper = mesh(new THREE.BoxGeometry(1.35, 0.62, 1.35), palette.paper);
  upper.position.y = 2.2;
  g.add(upper);

  const topRoof = roof(1.6, 0.7, palette.roofOrange);
  topRoof.position.y = 2.85;
  g.add(topRoof);

  // Raised platform, granary style.
  const plinth = mesh(new THREE.BoxGeometry(2.9, 0.2, 2.9), palette.woodLight);
  plinth.position.y = 0.1;
  g.add(plinth);

  // Lanterns flanking the door.
  g.add(lantern(-1.1, 1.05, 1.32));
  g.add(lantern(1.1, 1.05, 1.32));

  return g;
}

function makeBambooHut(): THREE.Group {
  const g = new THREE.Group();
  const base = mesh(new THREE.BoxGeometry(1.5, 0.85, 1.5), palette.paper);
  base.position.y = 0.42;
  g.add(base);
  for (const sx of [-0.72, 0.72]) for (const sz of [-0.72, 0.72]) g.add(post(sx, sz, 0.95));
  const r = roof(1.7, 0.65, palette.bambooLeafDark); // thatched bamboo roof
  r.position.y = 1.18;
  g.add(r);
  // Lean-to bamboo rack at the side.
  const rack = mesh(new THREE.BoxGeometry(0.12, 0.5, 0.9), palette.bambooCulm);
  rack.position.set(0.95, 0.25, 0);
  rack.rotation.z = 0.5;
  g.add(rack);
  return g;
}

/** Shared small-workshop base: paper walls, corner posts, colored roof. */
function workshopBase(roofColor: number, size = 1.5): THREE.Group {
  const g = new THREE.Group();
  const base = mesh(new THREE.BoxGeometry(size, 0.85, size), palette.paper);
  base.position.y = 0.42;
  g.add(base);
  const off = size * 0.48;
  for (const sx of [-off, off]) for (const sz of [-off, off]) g.add(post(sx, sz, 0.95));
  const r = roof(size + 0.2, 0.65, roofColor);
  r.position.y = 1.18;
  g.add(r);
  return g;
}

function makeQuarry(): THREE.Group {
  const g = workshopBase(palette.rockDark);
  const pile = mesh(new THREE.DodecahedronGeometry(0.28), palette.rock);
  pile.position.set(0.85, 0.2, 0.4);
  pile.scale.y = 0.7;
  g.add(pile);
  return g;
}

function makeWell(): THREE.Group {
  const g = new THREE.Group();
  const ring = mesh(new THREE.CylinderGeometry(0.32, 0.36, 0.35, 10), palette.rock);
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
  const r = roof(0.75, 0.35, palette.roofOrange);
  r.position.y = 0.95;
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
  const g = workshopBase(palette.indigo);
  const barrel = mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.5, 10), palette.paper);
  barrel.position.set(0.85, 0.25, -0.35);
  g.add(barrel);
  const band = mesh(new THREE.CylinderGeometry(0.255, 0.255, 0.08, 10), palette.wood);
  band.position.set(0.85, 0.25, -0.35);
  g.add(band);
  return g;
}

function makeMine(oreColor: number): () => THREE.Group {
  return () => {
    const g = workshopBase(palette.roofDark);
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
    return g;
  };
}

function makeSwordsmith(): THREE.Group {
  const g = workshopBase(palette.roofDark);
  const chimney = mesh(new THREE.BoxGeometry(0.24, 0.9, 0.24), palette.rockDark);
  chimney.position.set(-0.55, 1.15, -0.45);
  g.add(chimney);
  const blade = mesh(new THREE.BoxGeometry(0.05, 0.55, 0.12), goodColorsLocal.katana);
  blade.position.set(0.8, 0.45, 0.3);
  blade.rotation.z = 0.6;
  g.add(blade);
  return g;
}

function makeSpearmaker(): THREE.Group {
  const g = workshopBase(palette.woodLight);
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
  const g = workshopBase(palette.bambooLeaf);
  const bow = mesh(new THREE.TorusGeometry(0.4, 0.035, 6, 12, Math.PI), goodColorsLocal.yumi);
  bow.position.set(0.85, 0.55, 0.2);
  bow.rotation.z = Math.PI / 2;
  g.add(bow);
  return g;
}

function makeTerakoya(): THREE.Group {
  const g = workshopBase(palette.vermillion, 1.7);
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
  const base = mesh(new THREE.BoxGeometry(2.5, 1.0, 2.5), palette.paper);
  base.position.y = 0.5;
  g.add(base);
  for (const sx of [-1.2, 1.2]) for (const sz of [-1.2, 1.2]) g.add(post(sx, sz, 1.15));
  const lowRoof = roof(2.7, 0.8, palette.indigo);
  lowRoof.position.y = 1.42;
  g.add(lowRoof);
  const upper = mesh(new THREE.BoxGeometry(1.2, 0.5, 1.2), palette.paper);
  upper.position.y = 1.95;
  g.add(upper);
  const topRoof = roof(1.5, 0.6, palette.indigo);
  topRoof.position.y = 2.5;
  g.add(topRoof);
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

  // Tents.
  const tent1 = mesh(new THREE.ConeGeometry(0.62, 0.95, 6), palette.roofDark);
  tent1.position.set(-0.45, 0.48, -0.2);
  g.add(tent1);
  const tent2 = mesh(new THREE.ConeGeometry(0.5, 0.8, 6), palette.roofDark);
  tent2.position.set(0.55, 0.4, 0.45);
  g.add(tent2);

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
