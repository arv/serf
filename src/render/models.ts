import * as THREE from 'three';
import type { BuildingTypeId } from '../sim/entities';
import { THEME, makeMedievalBuilding, medievalCarryProp } from './medieval';
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

/**
 * An organic blob: a cylinder whose rim is radius-jittered per angular
 * segment (walls stay vertical). Every instance rolls its own outline.
 */
function blobGeometry(radius: number, height: number, jitter: number): THREE.BufferGeometry {
  const segments = 14;
  const geo = new THREE.CylinderGeometry(1, 1, height, segments);
  const factors: number[] = [];
  for (let s = 0; s <= segments; s++) {
    factors.push(s === segments ? factors[0]! : 1 + (Math.random() - 0.5) * jitter);
  }
  const pos = geo.attributes.position!;
  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v);
    const z = pos.getZ(v);
    const len = Math.hypot(x, z);
    if (len < 1e-4) continue; // cap centers
    const angle = Math.atan2(z, x) + Math.PI;
    const s = Math.round((angle / (Math.PI * 2)) * segments) % segments;
    const f = radius * factors[s]!;
    pos.setX(v, (x / len) * len * f);
    pos.setZ(v, (z / len) * len * f);
  }
  geo.computeVertexNormals();
  return geo;
}

function makeQuarry(): THREE.Group {
  // An open working yard — no house. Rock face, cut blocks, timber hoist.
  const g = new THREE.Group();

  // Gravel apron settles the yard into the meadow.
  const apron = mesh(blobGeometry(1.15, 0.5, 0.3), palette.rockDark);
  apron.position.y = -0.17;
  g.add(apron);

  // The rock face being worked: a shoulder of big flat-shaded boulders.
  for (const [x, z, s, ry] of [
    [-0.55, -0.55, 1.15, 0.3],
    [-0.05, -0.75, 0.8, 1.2],
    [-0.85, -0.05, 0.7, 2.1],
  ] as const) {
    const rock = mesh(new THREE.DodecahedronGeometry(0.4), palette.rock);
    rock.scale.set(s, s * 0.8, s);
    rock.rotation.y = ry;
    rock.position.set(x, 0.28 * s, z);
    g.add(rock);
  }

  // Stacked cut blocks, ready for hauling.
  for (const [x, y, z, ry] of [
    [0.55, 0.14, 0.45, 0.15],
    [0.85, 0.14, 0.15, -0.2],
    [0.68, 0.4, 0.32, 0.4],
  ] as const) {
    const block = tmesh(new THREE.BoxGeometry(0.4, 0.26, 0.3), TEX.stone());
    block.position.set(x, y, z);
    block.rotation.y = ry;
    g.add(block);
  }

  // Timber shear-legs hoist leaning over the blocks.
  for (const sx of [-1, 1]) {
    const leg = mesh(new THREE.CylinderGeometry(0.045, 0.05, 1.5, 5), palette.wood);
    leg.position.set(0.55 + sx * 0.32, 0.68, 0.28);
    leg.rotation.z = -sx * 0.35;
    leg.rotation.x = 0.12;
    g.add(leg);
  }
  const crossbar = mesh(new THREE.BoxGeometry(0.5, 0.06, 0.06), palette.wood);
  crossbar.position.set(0.55, 1.32, 0.2);
  g.add(crossbar);
  const rope = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.55, 4), 0x2a2018);
  rope.position.set(0.55, 1.02, 0.2);
  rope.castShadow = false;
  g.add(rope);
  const sling = tmesh(new THREE.BoxGeometry(0.26, 0.18, 0.22), TEX.stone());
  sling.position.set(0.55, 0.68, 0.2);
  g.add(sling);

  // Rubble scatter.
  for (let i = 0; i < 5; i++) {
    const chip = mesh(new THREE.DodecahedronGeometry(0.07 + Math.random() * 0.06), palette.rockDark);
    chip.position.set(-0.2 + Math.random() * 1.0, 0.06, 0.55 + Math.random() * 0.35);
    chip.rotation.y = Math.random() * Math.PI;
    g.add(chip);
  }

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
  // A flooded pond dug into the meadow: organic outline, earthen skirt that
  // sinks below grade (so sloped terrain never shows a gap), soft bund lip.
  const g = new THREE.Group();

  // The field is DUG IN, not built up: almost all of the earth skirt lies
  // below grade (it only exists to hide terrain seams on slopes), and the
  // water sits barely above the grass like a flooded cut. Colors stay close
  // to the meadow — murky green flood water, olive-earth bund — so the
  // paddy melts into the terrain instead of contrasting against it.
  const muddyEarth = 0x6d603a;
  const floodWater = 0x42583f;
  const basin = mesh(blobGeometry(1.55, 0.8, 0.24), muddyEarth);
  basin.position.y = -0.33; // top face at +0.07
  g.add(basin);

  const water = mesh(blobGeometry(1.38, 0.04, 0.22), floodWater);
  water.position.y = 0.08;
  g.add(water);

  // Hand-piled bund: irregular earth mounds around the waterline instead of
  // a geometric lip.
  const mounds = 12;
  for (let i = 0; i < mounds; i++) {
    const a = (i / mounds) * Math.PI * 2 + (Math.random() - 0.5) * 0.25;
    const r = 1.42 + (Math.random() - 0.5) * 0.16;
    const s = 0.16 + Math.random() * 0.12;
    const mound = mesh(new THREE.SphereGeometry(s, 6, 5), muddyEarth);
    mound.scale.y = 0.45;
    mound.position.set(Math.cos(a) * r, 0.075, Math.sin(a) * r);
    g.add(mound);
  }

  // Seedlings in loose, hand-planted rows, poking out of the shallow water.
  for (let row = -2; row <= 2; row++) {
    for (let col = -2; col <= 2; col++) {
      const x = col * 0.42 + (Math.random() - 0.5) * 0.14;
      const z = row * 0.42 + (Math.random() - 0.5) * 0.14;
      if (Math.hypot(x, z) > 1.15) continue; // stay inside the pond
      const sprout = mesh(
        new THREE.ConeGeometry(0.07, 0.26 + Math.random() * 0.12, 4),
        Math.random() < 0.3 ? palette.bambooLeafDark : palette.bambooLeaf,
      );
      sprout.position.set(x, 0.2, z);
      sprout.rotation.y = Math.random() * Math.PI;
      g.add(sprout);
    }
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
  // Preview whatever model the theme will actually build.
  const g = makeMedievalBuilding(type) ?? makeBuildingModel(type);
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
// Units — articulated little people, built once per kind and cloned per
// entity. Origin at feet. Limbs are named groups pivoted at hip/shoulder so
// the renderer can swing them: 'legL', 'legR', 'armL', 'armR', 'torso'.
// Tools/weapons are parented to the right hand and swing with the arm.

const SKIN = 0xd9b38c;
const HAIR = 0x241a12;

interface PersonStyle {
  robe: number; // kimono / armor color
  sash?: number;
  kasa?: boolean; // straw hat
  headband?: number;
  topknot?: boolean;
  armored?: boolean; // broader torso + shoulder plates
  scale?: number;
  /** Built into the right hand; swings with work/fight animations. */
  tool?: (hand: THREE.Group) => void;
  /** Extras attached to the torso (quivers, back-banners...). */
  back?: (torso: THREE.Group) => void;
}

/** Smooth surface of revolution from a (radius, height) profile. */
export function lathe(profile: [number, number][], color: number, segments = 10): THREE.Mesh {
  const points = profile.map(([r, y]) => new THREE.Vector2(r, y));
  return mesh(new THREE.LatheGeometry(points, segments), color);
}

/**
 * A rigged villager with professional game-character anatomy: a smooth
 * lathe-turned kimono body (one continuous surface, hem to collar), and
 * TWO-BONE limbs — thighs with knee-jointed shins, upper arms with
 * elbow-jointed forearms — so gaits and swings articulate like real
 * characters instead of stick figures. Rig group names:
 * hips, legL/legR (hip), shinL/shinR (knee), torso, armL/armR (shoulder),
 * foreL/foreR (elbow), head. Total height ~0.98 world units.
 */
function person(style: PersonStyle): THREE.Group {
  const g = new THREE.Group();
  const robeDark = new THREE.Color(style.robe).multiplyScalar(0.78).getHex();
  const shoulderW = style.armored ? 0.155 : 0.135;

  // --- Pelvis + two-bone legs --------------------------------------------
  const hips = new THREE.Group();
  hips.name = 'hips';
  hips.position.y = 0.5;
  const pelvis = mesh(new THREE.SphereGeometry(0.11, 9, 7), robeDark);
  pelvis.scale.set(1.15, 0.62, 0.95);
  pelvis.position.y = -0.01;
  hips.add(pelvis);

  for (const side of [-1, 1] as const) {
    const leg = new THREE.Group();
    leg.name = side < 0 ? 'legL' : 'legR';
    leg.position.set(side * 0.062, -0.02, 0);

    // Thigh: hakama volume, widest at the hip.
    const thigh = lathe(
      [
        [0.045, -0.26],
        [0.062, -0.18],
        [0.07, -0.08],
        [0.06, 0.02],
      ],
      robeDark,
      8,
    );
    leg.add(thigh);

    // Shin pivots at the knee; hakama cuff flares over the ankle.
    const shin = new THREE.Group();
    shin.name = side < 0 ? 'shinL' : 'shinR';
    shin.position.y = -0.25;
    const calf = lathe(
      [
        [0.052, -0.23],
        [0.058, -0.12],
        [0.044, -0.02],
        [0.04, 0.03],
      ],
      robeDark,
      8,
    );
    shin.add(calf);
    const foot = mesh(new THREE.SphereGeometry(0.045, 7, 5), HAIR);
    foot.scale.set(1, 0.5, 1.6);
    foot.position.set(0, -0.235, 0.035);
    shin.add(foot);
    leg.add(shin);
    hips.add(leg);
  }
  g.add(hips);

  // --- Torso: one continuous kimono surface, hem to collar ---------------
  const torso = new THREE.Group();
  torso.name = 'torso';
  torso.position.y = 0.48;
  const robe = lathe(
    [
      [0.148, 0.0], // hem, flared over the pelvis
      [0.135, 0.06],
      [0.118, 0.12], // waist pinch under the obi
      [0.126, 0.2],
      [shoulderW, 0.3], // chest spread
      [shoulderW * 0.92, 0.36], // shoulder roll-off
      [0.075, 0.41], // collar
      [0.05, 0.43],
    ],
    style.robe,
    12,
  );
  torso.add(robe);
  if (style.sash !== undefined) {
    const sash = mesh(new THREE.CylinderGeometry(0.124, 0.134, 0.075, 12), style.sash);
    sash.position.y = 0.125;
    torso.add(sash);
    // Obi knot at the back.
    const knot = mesh(new THREE.SphereGeometry(0.045, 6, 5), style.sash);
    knot.scale.set(1.4, 0.8, 0.7);
    knot.position.set(0, 0.13, -0.135);
    torso.add(knot);
  }
  if (style.armored) {
    // Layered dō plates + sode shoulder guards.
    const plate = mesh(new THREE.CylinderGeometry(0.145, 0.16, 0.05, 12), robeDark);
    plate.position.y = 0.2;
    torso.add(plate);
    const plate2 = mesh(new THREE.CylinderGeometry(0.15, 0.165, 0.05, 12), robeDark);
    plate2.position.y = 0.15;
    torso.add(plate2);
    for (const side of [-1, 1] as const) {
      const sode = lathe(
        [
          [0.09, -0.07],
          [0.075, -0.02],
          [0.045, 0.02],
        ],
        robeDark,
        8,
      );
      sode.position.set(side * 0.175, 0.37, 0);
      sode.rotation.z = side * 0.35;
      torso.add(sode);
    }
  }

  // --- Head with a face plane and shaped hair ----------------------------
  const head = new THREE.Group();
  head.name = 'head';
  head.position.y = 0.46;
  const skull = mesh(new THREE.SphereGeometry(0.085, 10, 8), SKIN);
  skull.scale.set(0.92, 1, 0.95);
  skull.position.y = 0.055;
  head.add(skull);
  const nose = mesh(new THREE.SphereGeometry(0.018, 5, 4), SKIN);
  nose.position.set(0, 0.045, 0.082);
  head.add(nose);
  // Hair: swept cap with a fringe line, leaving the face open.
  const hair = mesh(new THREE.SphereGeometry(0.09, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.62), HAIR);
  hair.scale.set(1.02, 1, 1.05);
  hair.position.set(0, 0.052, -0.012);
  head.add(hair);
  if (style.topknot) {
    const tail = mesh(new THREE.CylinderGeometry(0.02, 0.028, 0.07, 6), HAIR);
    tail.position.set(0, 0.165, -0.01);
    tail.rotation.x = -0.3;
    head.add(tail);
  }
  if (style.kasa) {
    const hat = lathe(
      [
        [0.215, 0],
        [0.13, 0.045],
        [0.04, 0.085],
        [0.0, 0.095],
      ],
      palette.grassDry,
      12,
    );
    hat.position.y = 0.115;
    head.add(hat);
  }
  if (style.headband !== undefined) {
    const band = mesh(new THREE.TorusGeometry(0.082, 0.015, 5, 12), style.headband);
    band.rotation.x = Math.PI / 2;
    band.position.y = 0.088;
    head.add(band);
  }
  torso.add(head);

  // --- Two-bone arms: shoulder + elbow, kimono sleeves --------------------
  for (const side of [-1, 1] as const) {
    const arm = new THREE.Group();
    arm.name = side < 0 ? 'armL' : 'armR';
    arm.position.set(side * (shoulderW + 0.015), 0.35, 0);
    const shoulder = mesh(new THREE.SphereGeometry(0.052, 7, 5), style.robe);
    arm.add(shoulder);
    const upper = lathe(
      [
        [0.036, -0.16],
        [0.046, -0.06],
        [0.05, 0.0],
      ],
      style.robe,
      7,
    );
    arm.add(upper);

    const fore = new THREE.Group();
    fore.name = side < 0 ? 'foreL' : 'foreR';
    fore.position.y = -0.16;
    // Forearm with a draped sleeve cuff widening at the wrist.
    const sleeve = lathe(
      [
        [0.05, -0.15],
        [0.034, -0.1],
        [0.03, -0.02],
        [0.034, 0.01],
      ],
      robeDark,
      7,
    );
    fore.add(sleeve);
    const hand = new THREE.Group();
    hand.position.y = -0.165;
    const fist = mesh(new THREE.SphereGeometry(0.035, 6, 5), SKIN);
    hand.add(fist);
    fore.add(hand);
    if (side > 0 && style.tool) style.tool(hand);
    arm.add(fore);
    torso.add(arm);
  }

  if (style.back) style.back(torso);

  g.add(torso);
  if (style.scale) g.scale.setScalar(style.scale);
  return g;
}

// Hand tools/weapons (positioned relative to the fist). Exported so the
// skinned-character pipeline can bolt the same props onto GLB hand bones.
export function hatchet(hand: THREE.Group): void {
  const haft = mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.34, 5), palette.woodLight);
  haft.position.y = 0.1;
  hand.add(haft);
  const headM = mesh(new THREE.BoxGeometry(0.11, 0.07, 0.03), 0x8a8f96);
  headM.position.set(0.05, 0.24, 0);
  hand.add(headM);
}

export function katanaBlade(hand: THREE.Group, big = false): void {
  const blade = mesh(
    new THREE.BoxGeometry(0.035, big ? 0.6 : 0.5, 0.05),
    goodColorsLocal.katana,
  );
  blade.position.y = big ? 0.32 : 0.27;
  hand.add(blade);
  const guard = mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.02, 8), 0xc8a84a);
  guard.position.y = 0.06;
  hand.add(guard);
}

export function yariSpear(hand: THREE.Group): void {
  const shaft = mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.15, 5), goodColorsLocal.yari);
  shaft.position.y = 0.3;
  hand.add(shaft);
  const tip = mesh(new THREE.ConeGeometry(0.045, 0.16, 5), goodColorsLocal.katana);
  tip.position.y = 0.94;
  hand.add(tip);
}

export function crudeBlade(hand: THREE.Group): void {
  const blade = mesh(new THREE.BoxGeometry(0.04, 0.42, 0.05), palette.rockDark);
  blade.position.y = 0.22;
  hand.add(blade);
}

export function bowInHand(color: number): (hand: THREE.Group) => void {
  return (hand) => {
    const bow = mesh(new THREE.TorusGeometry(0.3, 0.022, 5, 12, Math.PI), color);
    bow.rotation.z = Math.PI / 2;
    hand.add(bow);
  };
}

export function quiver(torso: THREE.Group): void {
  const q = mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.28, 6), palette.wood);
  q.position.set(-0.08, 0.22, -0.13);
  q.rotation.z = 0.3;
  torso.add(q);
  for (let i = 0; i < 3; i++) {
    const fletch = mesh(new THREE.BoxGeometry(0.025, 0.05, 0.012), palette.paper);
    fletch.position.set(-0.13 + i * 0.04, 0.4, -0.13);
    torso.add(fletch);
  }
}

const unitFactories = new Map<number, () => THREE.Group>([
  // Serf: washi-cream kimono, burnt-orange obi — the BR peasant read.
  [1, () => person({ robe: 0xe6d9b5, sash: 0xc86428 })],
  // Worker: warm tan kimono, straw kasa, hatchet in hand.
  [2, () => person({ robe: 0xd8a868, sash: 0x6b8f3f, kasa: true, tool: hatchet })],
  // Samurai: bright indigo armor, topknot, katana.
  [3, () =>
    person({ robe: 0x5a72b8, armored: true, topknot: true, tool: (h) => katanaBlade(h) })],
  // Ashigaru: paper tunic, indigo headband, yari.
  [4, () => person({ robe: 0xefe3cc, headband: 0x4a5f8e, tool: yariSpear })],
  // Archer: leaf-green garb, kasa, bow + quiver.
  [5, () =>
    person({
      robe: 0x7fae4a,
      kasa: true,
      tool: bowInHand(goodColorsLocal.yumi),
      back: quiver,
    })],
  // Bandit: charcoal rags, vermillion headband, crude blade.
  [6, () => person({ robe: 0x5d636e, headband: 0xd85a4a, tool: crudeBlade })],
  // Bandit archer: same rags, bow + quiver.
  [7, () =>
    person({
      robe: 0x5d636e,
      headband: 0xd85a4a,
      tool: bowInHand(palette.wood),
      back: quiver,
    })],
  // Rōnin: gunmetal armor, big frame, long katana.
  [8, () =>
    person({
      robe: 0x4a5364,
      armored: true,
      topknot: true,
      scale: 1.15,
      tool: (h) => katanaBlade(h, true),
    })],
]);

const unitPrototypes = new Map<number, THREE.Group>();

/** Unit model by SAB kind code (see UNIT_DEFS kindCode). */
export function makeUnitModel(kindCode: number): THREE.Group {
  let proto = unitPrototypes.get(kindCode);
  if (!proto) {
    proto = (unitFactories.get(kindCode) ?? unitFactories.get(1)!)();
    unitPrototypes.set(kindCode, proto);
  }
  return proto.clone();
}

// ---------------------------------------------------------------------------
// Carried goods — the core fantasy. Each good is a distinct little prop on
// the carrier's shoulders, readable at gameplay zoom.

import { GOODS, type GoodId } from '../sim/defs/goods';

const MEDIEVAL = THEME === 'medieval';

function carryProto(good: GoodId): THREE.Group {
  const g = new THREE.Group();
  const add = (m: THREE.Mesh): void => {
    m.castShadow = false;
    g.add(m);
  };

  switch (good) {
    case 'water': {
      // Tenbin-bo: a shoulder pole with a pail swinging at each end.
      const pole = mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.78, 5), palette.woodLight);
      pole.rotation.z = Math.PI / 2;
      add(pole);
      for (const sx of [-0.36, 0.36]) {
        const rope = mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.16, 3), 0x2a2018);
        rope.position.set(sx, -0.09, 0);
        add(rope);
        const pail = mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.09, 7), palette.wood);
        pail.position.set(sx, -0.2, 0);
        add(pail);
        const waterTop = mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.012, 7), 0x4a708c);
        waterTop.position.set(sx, -0.155, 0);
        add(waterTop);
      }
      g.position.y = 0.88;
      break;
    }
    case 'rice': {
      // Tawara: a straw bale with rope bindings.
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
    case 'bamboo': {
      // A bundle of culms over the shoulder.
      for (const [dy, dz, r] of [
        [0, 0, 0.032],
        [0.05, 0.03, 0.028],
        [0.04, -0.04, 0.03],
      ] as const) {
        const culm = mesh(new THREE.CylinderGeometry(r, r, 0.95, 5), palette.bambooCulm);
        culm.rotation.z = Math.PI / 2;
        culm.rotation.y = 0.12;
        culm.position.set(0, dy, dz);
        add(culm);
      }
      g.position.y = 0.9;
      break;
    }
    case 'stone': {
      const chunk = mesh(new THREE.DodecahedronGeometry(0.14), palette.rock);
      chunk.scale.y = 0.8;
      add(chunk);
      g.position.y = 0.92;
      break;
    }
    case 'iron':
    case 'silver':
    case 'gold': {
      const tone = good === 'iron' ? 0x5a5350 : good === 'silver' ? 0xc4cad2 : 0xe0b44a;
      const a = mesh(new THREE.BoxGeometry(0.24, 0.07, 0.1), tone);
      add(a);
      const b = mesh(new THREE.BoxGeometry(0.24, 0.07, 0.1), tone);
      b.position.set(0, 0.07, 0.02);
      b.rotation.y = 0.35;
      add(b);
      g.position.y = 0.9;
      break;
    }
    case 'katana': {
      if (MEDIEVAL) {
        // Sheathed arming sword: leather scabbard, straight crossguard.
        // Parts sit along the same yaw as the scabbard, so their offsets are
        // (d·cos 0.35, −d·sin 0.35) for a distance d up the blade.
        const scabbard = mesh(new THREE.BoxGeometry(0.44, 0.05, 0.075), palette.wood);
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
      // Sheathed blade carried flat.
      const saya = mesh(new THREE.BoxGeometry(0.55, 0.045, 0.07), 0x2a2233);
      saya.rotation.y = 0.35;
      saya.rotation.z = 0.1;
      add(saya);
      const tsuba = mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.02, 8), 0xc8a84a);
      tsuba.rotation.z = Math.PI / 2;
      tsuba.position.set(0.2, 0.02, -0.07);
      tsuba.rotation.y = 0.35;
      add(tsuba);
      g.position.y = 0.92;
      break;
    }
    case 'yari': {
      const shaft = mesh(new THREE.CylinderGeometry(0.022, 0.022, 1.05, 5), goodColorsLocal.yari);
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
    case 'yumi': {
      const bow = mesh(new THREE.TorusGeometry(0.26, 0.022, 5, 10, Math.PI), goodColorsLocal.yumi);
      bow.rotation.z = Math.PI / 2;
      add(bow);
      g.position.y = 0.85;
      break;
    }
    case 'sake': {
      if (MEDIEVAL) {
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
      // A cream tokkuri jug with a vermillion collar.
      const body = mesh(new THREE.SphereGeometry(0.12, 8, 6), 0xece2d0);
      body.scale.y = 1.1;
      add(body);
      const neck = mesh(new THREE.CylinderGeometry(0.04, 0.055, 0.1, 7), 0xece2d0);
      neck.position.y = 0.14;
      add(neck);
      const collar = mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.025, 7), palette.vermillion);
      collar.position.y = 0.1;
      add(collar);
      g.position.y = 0.94;
      break;
    }
  }
  return g;
}

const carryPrototypes = new Map<GoodId, THREE.Group>();

/** The visible good on a carrier's shoulders, by SAB carry code. */
/** Goods whose carried look comes from the pack's own resource piles, so
 * what's on a serf's arms matches what's stacked in the yards. */
const PACK_CARRY: Partial<Record<GoodId, { prop: string; span: number }>> = {
  bamboo: { prop: 'resource_lumber', span: 0.44 },
  stone: { prop: 'resource_stone', span: 0.36 },
  // A shoulder yoke is feudal Japan, and the pole spanned most of a tile
  // besides: medieval water travels by the hand-sized pack bucket.
  water: { prop: 'bucket_water', span: 0.26 },
  rice: { prop: 'sack', span: 0.3 },
  sake: { prop: 'barrel', span: 0.3 },
};

/**
 * A single unit of a good as a small grounded prop, for the stock piles
 * that grow beside buildings — same look as the carried version, base on
 * the ground.
 */
export function makePileProp(good: GoodId): THREE.Group {
  const pack = PACK_CARRY[good];
  const inner = (pack && medievalCarryProp(pack.prop, 0.3)) ?? carryProto(good).clone();
  if (!pack) {
    inner.position.set(0, 0, 0); // strip the carry-height offset
    inner.scale.setScalar(0.62);
  }
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
    const prop = medievalCarryProp(pack.prop, pack.span);
    if (prop) return prop;
  }
  let proto = carryPrototypes.get(good);
  if (!proto) {
    proto = carryProto(good);
    carryPrototypes.set(good, proto);
  }
  return proto.clone();
}
