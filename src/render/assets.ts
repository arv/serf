import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BUILDING_DEFS, type BuildingTypeId } from '../sim/defs/buildings';
import { factionTint, TEAM_SWATCH_UV } from './factionPalette';
import { makeBakehouse } from './procBuildings';
import { makeFishSign, makeShoal } from './procParts';

/**
 * GLB asset pipeline: building, tree, rock and prop models loaded from the
 * KayKit packs (CC0). When loading fails, callers fall back to the
 * procedural models in models.ts.
 */

const DIR = '/models/kaykit/';

/**
 * Which KayKit Medieval Hexagon model (CC0, Kay Lousberg) plays each
 * building. All load the pack's "green" variant — the variants differ only
 * in the team-color swatch, which we repaint per owner (see
 * splitTeamColorGroups).
 */
const BUILDING_FILES: Partial<Record<BuildingTypeId, string>> = {
  storehouse: 'building_castle_green.gltf',
  house: 'building_home_A_green.gltf',
  woodcutter: 'building_lumbermill_green.gltf',
  quarry: 'building_mine_green.gltf',
  well: 'building_well_green.gltf',
  wheatFarm: 'farm_plot.glb',
  mill: 'building_windmill_green.gltf',
  // (No bakery: it is the one building we model ourselves — BUILT_BUILDINGS.)
  // The EXTRA shipyard: a hull on the slipway, an anchor, barrels on the
  // quay. The one food building that needed nothing built by hand.
  fishery: 'extra/building_shipyard_green.gltf',
  brewery: 'building_tavern_green.gltf',
  // The mines share one model and read apart by their spoil (rust, silver,
  // gold boulders in BUILDING_DECOR) — the pack's color variants only vary
  // the team-color slot, which now belongs to the owning faction.
  ironMine: 'building_mine_green.gltf',
  silverMine: 'building_mine_green.gltf',
  goldMine: 'building_mine_green.gltf',
  weaponsmith: 'building_blacksmith_green.gltf',
  barracks: 'building_barracks_green.gltf',
  abbey: 'building_church_green.gltf',
  banditCamp: 'building_tower_B_red.gltf',
  // The pack ships four towers and only this one is a watchtower: a plain
  // stone shaft with a crenellated parapet around an open plank deck. The
  // other three all put something where a man should stand — B a coned
  // roof under a finial (which is the bandits'), A a roofed gallery on
  // posts, and the fourth a catapult. Being roofless is the whole point
  // here, and it reads apart from the camp at a glance besides.
  guardTower: 'building_tower_base_green.gltf',
};

/**
 * Buildings with no pack model at all, modelled by us instead (see
 * procBuildings.ts). They go through the same mill as a loaded one —
 * normalized to the unit square, dressed from BUILDING_DECOR, split for
 * team color, scaled by footprint — and differ only in where the geometry
 * came from. Both are drawn with the pack's material and both carry the
 * team slot in their atlas UVs, so nothing downstream can tell them apart.
 *
 * The bakery is here because every shell the pack could have lent it is
 * either a house or already someone else's: the blacksmith is a domed
 * stone oven, so any oven we add to a house shell reads as a second smithy
 * from the air.
 */
const BUILT_BUILDINGS: Partial<
  Record<BuildingTypeId, (piece: PieceFactory, packMaterial: THREE.Material | null) => THREE.Group>
> = {
  bakery: makeBakehouse,
};

/** Tints so buildings sharing a model read apart. Empty since the smiths
 * merged; the mechanism stays for the next shared model. */
const TINTS: Partial<Record<BuildingTypeId, number>> = {};

/** Clones a loaded pack prop, scaled to `span` across and keeping its own
 * vertical origin. Null when the name is not in DECOR_PROP_FILES. */
export type PropFactory = (name: string, span: number) => THREE.Object3D | null;

/**
 * Clones a piece cut out of a pack model (PACK_PIECES), scaled to `height`.
 * The clone is centered in x, stands on y=0 and presents its face on z=0,
 * so a wall-mounted piece is placed by the wall plane it sits in. Null when
 * the name is unknown or its source model failed to load — every caller has
 * to survive that, the same way decor does.
 */
export type PieceFactory = (name: string, height: number) => THREE.Object3D | null;

/** Prop dressing placed around a building, in its unit-square space. */
interface Decor {
  /** A pack prop scene by file stem... */
  prop?: string;
  /** Height above the footprint, for dressing that sits on a roof. */
  y?: number;
  /**
   * Size by footprint span instead of height, keeping the prop's own
   * vertical origin. The pier needs both: it is sized by how far it runs
   * out, and its pilings belong below the waterline rather than lifted onto
   * the grass the way `size` would put them.
   */
  span?: number;
  /** ...an ore-tinted boulder... */
  rock?: number;
  /** ...or something we build ourselves, for what the pack has no model of.
   * Sized by the builder, not by `size`. The builder is handed a factory so
   * it can fold pack models into what it makes (the shoal is pack fish on a
   * path we author). */
  make?: (prop: PropFactory) => THREE.Object3D;
  at: [number, number];
  size: number;
  rot?: number;
  /** Object name, for decor other systems need to find again (the pier the
   * fisherman walks out on, the shoal buildingSync swims). */
  name?: string;
}

/**
 * The guard tower's deck, in the normalized template's own units — the
 * planking the watch stands on.
 *
 * Measured off the model: one flat up-facing disc at model y=1.400 running
 * the full width of the tower, with the merlons ringing it from 1.45 to
 * 1.50 — knee height on a man, which is what standing behind battlements
 * should look like. `normalize` scales the template by 1/1.1111 (the
 * model's widest footprint span), so model units convert at *0.9.
 */
const ROOF_Y = 1.26;

/**
 * How far out on that deck a man stands. The merlons close in at model
 * radius 0.379 (template 0.341), so this keeps both men inside the
 * parapet with room to spare rather than standing in a gap.
 */
const POST_R = 0.2;

/** POST_R split across x and z, for the two posts on the diagonal. */
const POST_D = POST_R / Math.SQRT2;

const DECOR_PROP_FILES = [
  'wheelbarrow',
  'sack',
  'resource_stone',
  'resource_lumber',
  'bucket_water',
  'barrel',
  'extra/anchor',
  'extra/boatrack',
  'extra/building_docks_green',
  'fish/fish',
  // RPG Tools Bits (CC0): the tool goods, carried and piled. The scythe
  // has no model in the pack and stays procedural (models.ts carryProto).
  'tools/axe',
  'tools/pickaxe',
  'tools/hammer',
  'tools/bucket_metal',
  'tools/fishing_rod',
];

/**
 * Props that ship as self-contained .glb rather than the .gltf pairs the
 * list above suffixes: the Dungeon Remastered pack (CC0, see
 * dungeon/LICENSE.txt) embeds its texture per file. Registered in `props`
 * under the stem, so glbYardProp('dungeon/banner_red', h) works like any
 * other prop. Today that is the rally flag's banner, one per seat: the
 * pack dyes it in the faction palette's own four (factionPalette.ts —
 * green, red, blue, gold), so each flag is picked, not tinted.
 */
const GLB_PROP_FILES = [
  'dungeon/banner_green.glb',
  'dungeon/banner_red.glb',
  'dungeon/banner_blue.glb',
  'dungeon/banner_yellow.glb',
];

// No goods-shaped decor on producers whose live stock piles up outside:
// the woodcutter's baked lumber pile read as planks that were never
// hauled. Tools and scenery (wheelbarrows, ore rocks) stay.
const BUILDING_DECOR: Partial<Record<BuildingTypeId, Decor[]>> = {
  // The bakehouse carries its own oven, counter and firewood (see
  // procBuildings), so all the yard needs is the two things the recipe
  // takes in: flour from the mill and water from the well.
  bakery: [
    { prop: 'sack', at: [-0.38, 0.46], size: 0.085, rot: 0.5 },
    { prop: 'bucket_water', at: [-0.12, 0.43], size: 0.07, rot: -0.4 },
    // The oven's firewood. It used to be six hand-rolled cylinders stacked
    // against the wall, which from the camera's angle read as a bunch of
    // dark circles half-buried in the corner block beside them. The pack
    // ships a log pile — the same one the woodcutter's yard stock and a
    // serf's shoulder load are made of — so use that and stand it clear.
    { prop: 'resource_lumber', at: [0.42, -0.06], size: 0.11 },
  ],
  mill: [{ prop: 'sack', at: [-0.34, 0.34], size: 0.1, rot: 0.5 }],
  fishery: [
    // The pier runs out of the front face, so the building's facing carries
    // it toward the water (see Building.facing). Long enough to overhang the
    // footprint on purpose. It reaches *toward* the nearest water rather than
    // provably into it: placement guarantees water within a tile of the
    // footprint somewhere, and the facing points at the nearest such tile,
    // but on a corner-only shore the pier's own tile can still be dry. It
    // reads right at village zoom either way, which is the bar decor has to
    // clear.
    {
      prop: 'extra/building_docks_green',
      at: [0, 0.68],
      span: 0.8,
      size: 1,
      rot: -Math.PI / 2,
      // buildingSync finds the pier by name and tells sceneSync where it
      // runs: the fisherman walks out on it and fishes off the end.
      name: 'fisheryPier',
    },
    // On the ridge, where the pack's sailing ship was — turned 45 degrees so
    // it stands near broadside to the default camera yaw. Along either axis
    // the fish would be read end-on and vanish.
    { make: (prop) => makeFishSign(0.19, prop), at: [0.06, -0.02], y: 0.34, size: 1, rot: Math.PI / 4 },
    { prop: 'extra/anchor', at: [-0.38, 0.26], size: 0.16, rot: 0.4 },
    { prop: 'extra/boatrack', at: [0.4, 0.3], size: 0.1, rot: -0.3 },
    // A shoal working the water off the pier. buildingSync swims it while
    // the fishery is staffed — an idle fishery's water is still. (It used to
    // say "the same way it turns a staffed well's windlass"; the well keeps
    // no staff now, and sceneSync turns that crank under the serf drawing
    // from it.) The y here is template-space only: the waterline is a world
    // plane below the shore, so buildingSync re-seats the group under it
    // once the building stands on real terrain.
    { make: (prop) => makeShoal(prop), at: [0, 1.02], y: 0.02, size: 1 },
  ],
  // Two marks on the tower's roof deck, and nothing to see: buildingSync
  // finds them by name and stands a live archer on each one for every man
  // the sim says is manning the tower. Empties rather than props, because
  // what goes here is a character with a mixer, not a piece of scenery.
  //
  // Across from one another on the diagonal rather than side by side: from
  // the default camera yaw that reads as two men watching two ways, and puts
  // one to either side of the tower instead of one behind the other. On
  // the diagonal POST_R splits evenly between the two axes. Nothing stands
  // in the middle of this deck, so unlike the roofed towers there is no
  // reason to push them out to the rim.
  guardTower: [
    { make: () => new THREE.Group(), at: [-POST_D, POST_D], y: ROOF_Y, size: 1, name: 'towerPost0' },
    { make: () => new THREE.Group(), at: [POST_D, -POST_D], y: ROOF_Y, size: 1, name: 'towerPost1' },
  ],
  quarry: [{ prop: 'wheelbarrow', at: [-0.36, 0.3], size: 0.15, rot: 0.6 }],
  ironMine: [{ prop: 'wheelbarrow', at: [-0.35, 0.32], size: 0.15, rot: -0.5 }],
  silverMine: [{ prop: 'sack', at: [-0.33, 0.33], size: 0.11 }],
  goldMine: [{ prop: 'sack', at: [-0.33, 0.33], size: 0.11, rot: 1.1 }],
};

interface Assets {
  buildings: Map<BuildingTypeId, THREE.Group>;
  /** Distinct tree species geometries (normalized: feet at 0, height 1). */
  trees: THREE.BufferGeometry[];
  /** Rock variants, same normalization. */
  rocks: THREE.BufferGeometry[];
  /** Water doodads: a flat lily pad (unit span) and a reed clump (unit height). */
  lily: THREE.BufferGeometry;
  reed: THREE.BufferGeometry;
  /** Forest pack: leafy shrubs (unit span) and bare trunks (unit height). */
  bushes: THREE.BufferGeometry[];
  deadTrees: THREE.BufferGeometry[];
  /** Shared palette-textured material for trees and rocks. */
  natureMaterial: THREE.Material;
  /** The forest pack's own palette sheet. */
  forestMaterial: THREE.Material;
  /** Loaded pack prop scenes (wheelbarrow, resource piles...). */
  props: Map<string, THREE.Group>;
}

let assets: Assets | null = null;

/**
 * Flatten a gltf scene into one UV-mapped geometry so it can drive an
 * InstancedMesh with the pack's shared palette texture.
 */
function bakeToGeometry(scene: THREE.Group): {
  geometry: THREE.BufferGeometry;
  map: THREE.Texture | null;
} {
  scene.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  let map: THREE.Texture | null = null;
  scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const geo = (o.geometry as THREE.BufferGeometry).clone().toNonIndexed();
    geo.applyMatrix4(o.matrixWorld);
    for (const name of Object.keys(geo.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
    }
    map ??= (o.material as THREE.MeshStandardMaterial).map ?? null;
    parts.push(geo);
  });
  return { geometry: mergeGeometries(parts), map };
}

/**
 * Rebuild an indexed geometry without the triangles whose centroid falls
 * inside `box` (model space) — the scalpel for parts baked into a merged
 * mesh that we want to replace with animated ones.
 */
function stripTrianglesInBox(geo: THREE.BufferGeometry, box: THREE.Box3): THREE.BufferGeometry {
  const index = geo.getIndex();
  if (!index) return geo;
  const out = geo.clone();
  const pos = out.getAttribute('position');
  const kept: number[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    const c = index.getX(i + 2);
    v.set(
      (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3,
      (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3,
      (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3,
    );
    if (!box.containsPoint(v)) kept.push(a, b, c);
  }
  out.setIndex(kept);
  return out;
}

/**
 * Pieces cut back *out* of a pack model, for the buildings we model
 * ourselves (BUILT_BUILDINGS). Kay already drew a door; drawing a second
 * one that is nearly but not quite his is how a hand-built building starts
 * to look like a mod. Cutting his out and hanging it in our wall is both
 * less work and a closer match than we could author.
 *
 * A piece is a box in the source model's own space plus the atlas cells to
 * keep inside it, because the interesting details are all coplanar with the
 * wall around them and a box alone cannot separate the two. Cells are
 * `col,row` of the atlas' 8x4 swatch grid (see hexagons_medieval.png);
 * `5,0` and `6,0` are its two timbers.
 */
const PACK_PIECES: Record<
  string,
  { file: string; box: [number, number, number, number, number, number]; cells: string[] }
> = {
  // The house's front door: an arched plank leaf in a timber frame, with a
  // knob. The box stops just under the wall rail above it, and the cells
  // drop the plaster reveal behind it — both of those belong to the house
  // and would fight the wall we hang this in.
  door: {
    file: 'building_home_A_green.gltf',
    box: [-0.115, -0.01, 0.25, 0.115, 0.335, 0.4],
    cells: ['5,0', '6,0'],
  },
};

/** Which atlas cell a UV lands in, as `col,row` of the 8x4 swatch grid. */
function atlasCell(u: number, v: number): string {
  return `${Math.floor(u * 8)},${Math.floor(v * 4)}`;
}

/**
 * Cut one PACK_PIECES entry out of its loaded model: the triangles whose
 * centroid is inside the box and whose atlas cell is listed, re-origined so
 * the piece is centered in x, stands on y=0, and presents its front face on
 * z=0 — which is how a wall-mounted piece wants to arrive.
 */
function cutPackPiece(scene: THREE.Group, spec: (typeof PACK_PIECES)[string]): THREE.Mesh | null {
  const [x0, y0, z0, x1, y1, z1] = spec.box;
  const box = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
  const cells = new Set(spec.cells);
  let out: THREE.Mesh | null = null;
  scene.traverse((o) => {
    if (out || !(o instanceof THREE.Mesh)) return;
    const geo = o.geometry as THREE.BufferGeometry;
    const index = geo.getIndex();
    const pos = geo.getAttribute('position');
    const uv = geo.getAttribute('uv');
    if (!index || !uv) return;
    const kept: number[] = [];
    const v = new THREE.Vector3();
    const bounds = new THREE.Box3();
    // Whole triangles only: a centroid test alone also admits long slivers
    // of NEIGHBOURING members — the house's wall rails run through the
    // door's box, and their fragments came along with the cut and dangled
    // beside the case once the piece was scaled up. A triangle is the
    // piece's own only if all three corners are in the box (with a hair of
    // tolerance for corners exactly on it).
    const whole = box.clone().expandByScalar(0.012);
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i);
      const b = index.getX(i + 1);
      const c = index.getX(i + 2);
      v.set(
        (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3,
        (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3,
        (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3,
      );
      if (!box.containsPoint(v)) continue;
      const inWhole = [a, b, c].every((i2) =>
        whole.containsPoint(v.set(pos.getX(i2), pos.getY(i2), pos.getZ(i2))),
      );
      if (!inWhole) continue;
      const cu = (uv.getX(a) + uv.getX(b) + uv.getX(c)) / 3;
      const cv = (uv.getY(a) + uv.getY(b) + uv.getY(c)) / 3;
      if (!cells.has(atlasCell(cu, cv))) continue;
      kept.push(a, b, c);
      for (const i2 of [a, b, c]) {
        bounds.expandByPoint(new THREE.Vector3(pos.getX(i2), pos.getY(i2), pos.getZ(i2)));
      }
    }
    if (kept.length === 0) return;
    // Compact to just the vertices the cut keeps. Re-indexing a clone would
    // be shorter, but every bounds query in three reads the *position
    // attribute*, not the index — so a clone that still carries the whole
    // house's vertices reports the whole house's box, and `normalize` would
    // then size the building we hang this in around a model it cannot see.
    const remap = new Map<number, number>();
    const px: number[] = [];
    const nx: number[] = [];
    const tx: number[] = [];
    const idx: number[] = [];
    const nor = geo.getAttribute('normal');
    for (const i of kept) {
      let j = remap.get(i);
      if (j === undefined) {
        j = remap.size;
        remap.set(i, j);
        px.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        if (nor) nx.push(nor.getX(i), nor.getY(i), nor.getZ(i));
        tx.push(uv.getX(i), uv.getY(i));
      }
      idx.push(j);
    }
    const cut = new THREE.BufferGeometry();
    cut.setAttribute('position', new THREE.Float32BufferAttribute(px, 3));
    if (nor) cut.setAttribute('normal', new THREE.Float32BufferAttribute(nx, 3));
    cut.setAttribute('uv', new THREE.Float32BufferAttribute(tx, 2));
    cut.setIndex(idx);
    cut.translate(-(bounds.min.x + bounds.max.x) / 2, -bounds.min.y, -bounds.max.z);
    const m = new THREE.Mesh(cut, o.material);
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData.size = [
      bounds.max.x - bounds.min.x,
      bounds.max.y - bounds.min.y,
      bounds.max.z - bounds.min.z,
    ];
    out = m;
  });
  return out;
}

/** Feet on y=0, footprint normalized to a unit square around the origin. */
function normalize(scene: THREE.Group): THREE.Group {
  const bbox = new THREE.Box3().setFromObject(scene);
  const spanX = bbox.max.x - bbox.min.x;
  const spanZ = bbox.max.z - bbox.min.z;
  const s = 1 / Math.max(spanX, spanZ);
  const wrapper = new THREE.Group();
  scene.position.set(
    -(bbox.min.x + bbox.max.x) / 2,
    -bbox.min.y,
    -(bbox.min.z + bbox.max.z) / 2,
  );
  wrapper.scale.setScalar(s);
  wrapper.add(scene);
  const out = new THREE.Group();
  out.add(wrapper);
  return out;
}

/**
 * Load one GLTF with retries: transient fetch failures (a dev-server
 * restart mid-flight, a flaky connection) used to reject the whole asset
 * Promise.all and silently dress the entire game in the procedural
 * fallback — which wore the legacy japan look and read as a different
 * game. Three attempts with a growing pause covers the transient class;
 * a real failure still throws, and boot turns it into a visible error
 * instead of a costume change.
 */
export async function loadGltfRetry(
  loader: GLTFLoader,
  url: string,
  attempts = 3,
): Promise<Awaited<ReturnType<GLTFLoader['loadAsync']>>> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await loader.loadAsync(url);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 350 * (i + 1)));
    }
  }
  throw new Error(`asset failed after ${attempts} attempts: ${url} (${String(lastErr)})`);
}

let glbLoading: Promise<boolean> | null = null;

/**
 * Fetch and prepare the building pack, once per page.
 *
 * Several screens want it — the menu backdrop, the editor, a match, the
 * field guide — and this used to rebuild the whole cache on every call,
 * re-fetching ~3 MB and replacing the templates that live clones already
 * share. Idempotent here rather than at each call site, because the ones
 * that overlap do not know about each other.
 *
 * A failure is not cached: the next screen to ask gets a fresh attempt.
 */
export function loadGlbAssets(): Promise<boolean> {
  glbLoading ??= loadGlbAssetsOnce().then(
    (ok) => {
      if (!ok) glbLoading = null;
      return ok;
    },
    (err: unknown) => {
      glbLoading = null;
      throw err;
    },
  );
  return glbLoading;
}

async function loadGlbAssetsOnce(): Promise<boolean> {
  {
    const loader = new GLTFLoader();
    const files = new Set(Object.values(BUILDING_FILES));
    // The models we cut pieces out of. Usually already loaded as a shell of
    // their own; listed anyway so a piece can come from a model no building
    // happens to be using.
    for (const p of Object.values(PACK_PIECES)) files.add(p.file);
    const TREE_FILES = ['tree_single_A.gltf', 'tree_single_B.gltf'];
    const ROCK_FILES = ['rock_single_A.gltf', 'rock_single_B.gltf', 'rock_single_C.gltf'];
    // Natural dressing the scatter system strews on its own: lily pads on
    // still shallows, reed clumps against the banks.
    const DOODAD_FILES = ['waterlily_A.gltf', 'waterplant_A.gltf'];
    // KayKit's Forest Nature pack (CC0, see forest/LICENSE.txt), vendored
    // a few models at a time: leafy shrubs for the woodland fringes and
    // bare trunks for the dry ground. Its own palette texture, so these
    // ride a material of their own.
    // The leafy variants, not the pack's blobby ones: a 56-triangle cube
    // of a shrub reads as a green crate at this camera distance.
    const FOREST_BUSH_FILES = [
      'forest/Bush_1_E_Color1.gltf',
      'forest/Bush_1_F_Color1.gltf',
      'forest/Bush_1_G_Color1.gltf',
      'forest/Bush_2_E_Color1.gltf',
    ];
    // Slender snags only: the pack's sprawling variants are as wide as
    // they are tall and read as orange stumps at map scale.
    const FOREST_DEAD_FILES = [
      'forest/Tree_Bare_2_A_Color1.gltf',
      'forest/Tree_Bare_2_B_Color1.gltf',
    ];
    const loaded = new Map<string, THREE.Group>();
    await Promise.all(
      [
        ...files,
        ...TREE_FILES,
        ...ROCK_FILES,
        ...DOODAD_FILES,
        ...FOREST_BUSH_FILES,
        ...FOREST_DEAD_FILES,
        ...DECOR_PROP_FILES.map((p) => `${p}.gltf`),
        ...GLB_PROP_FILES,
      ].map(async (f) => {
        const gltf = await loadGltfRetry(loader, `${DIR}${f}`);
        gltf.scene.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.castShadow = true;
            o.receiveShadow = true;
            const m = o.material as THREE.MeshStandardMaterial;
            if (m?.isMeshStandardMaterial) {
              m.roughness = 0.95;
              m.metalness = 0;
            }
          }
        });
        loaded.set(f, gltf.scene);
      }),
    );

    let natureMap: THREE.Texture | null = null;
    /** The forest pack ships its own palette sheet; keep it apart. */
    let forestMap: THREE.Texture | null = null;
    // Normalize: base at 0, and unit HEIGHT for tall things (trees) or unit
    // FOOTPRINT for ground clutter — the pack is authored for hex tiles, so
    // rocks are wider than they are tall and must be sized by span or they
    // overhang our square tiles (and clip the workers beside them).
    const bakeNormalized = (
      f: string,
      bySpan = false,
      pack: 'nature' | 'forest' = 'nature',
    ): THREE.BufferGeometry => {
      const { geometry: geo, map } = bakeToGeometry(loaded.get(f)!);
      if (pack === 'forest') forestMap ??= map;
      else natureMap ??= map;
      geo.computeBoundingBox();
      const tb = geo.boundingBox!;
      geo.translate(-(tb.min.x + tb.max.x) / 2, -tb.min.y, -(tb.min.z + tb.max.z) / 2);
      const span = bySpan
        ? Math.max(tb.max.x - tb.min.x, tb.max.z - tb.min.z)
        : tb.max.y - tb.min.y;
      const s = 1 / span;
      geo.scale(s, s, s);
      return geo;
    };
    const trees = TREE_FILES.map((f) => bakeNormalized(f));
    const rocks = ROCK_FILES.map((f) => bakeNormalized(f, true));
    // Lily pads lie flat (span-normalized like rocks); reeds stand (height).
    const lily = bakeNormalized('waterlily_A.gltf', true);
    const reed = bakeNormalized('waterplant_A.gltf');
    // Shrubs are wider than tall — span-normalized, like the boulders.
    // Bare trunks are tall things, sized by height like the live trees.
    const bushes = FOREST_BUSH_FILES.map((f) => bakeNormalized(f, true, 'forest'));
    const deadTrees = FOREST_DEAD_FILES.map((f) => bakeNormalized(f, false, 'forest'));
    const natureMaterial = new THREE.MeshLambertMaterial({ map: natureMap });
    const forestMaterial = new THREE.MeshLambertMaterial({ map: forestMap });

    /** A prop clone scaled by footprint span, keeping its own y origin —
     * for props that are meant to sit into the ground rather than on it. */
    const propOfSpan = (src: THREE.Group, span: number): THREE.Group => {
      const c = src.clone();
      const bb = new THREE.Box3().setFromObject(c);
      const across = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z, 1e-6);
      c.position.set(-(bb.min.x + bb.max.x) / 2, 0, -(bb.min.z + bb.max.z) / 2);
      const g = new THREE.Group();
      g.scale.setScalar(span / across);
      g.add(c);
      return g;
    };

    /** A prop clone normalized to `size` tall, feet on the ground. */
    const propOfSize = (src: THREE.Group, size: number): THREE.Group => {
      const c = src.clone();
      const bb = new THREE.Box3().setFromObject(c);
      const h = Math.max(bb.max.y - bb.min.y, 1e-6);
      c.position.set(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
      const g = new THREE.Group();
      g.scale.setScalar(size / h);
      g.add(c);
      return g;
    };

    /**
     * Dress a normalized building's yard: ore boulders, carts, sacks — the
     * mines in particular read apart by their spoil, not just their roof
     * color. Positions are in the unit square the template was normalized
     * to, so decor is placed the same whether the shell was loaded or built.
     */
    const dress = (type: BuildingTypeId, group: THREE.Group): void => {
      for (const d of BUILDING_DECOR[type] ?? []) {
        let obj: THREE.Object3D | undefined;
        if (d.make !== undefined) {
          obj = d.make((name, span) => {
            const src = loaded.get(`${name}.gltf`);
            return src ? propOfSpan(src, span) : null;
          });
        } else if (d.prop !== undefined) {
          const src = loaded.get(`${d.prop}.gltf`);
          if (src) obj = d.span !== undefined ? propOfSpan(src, d.span) : propOfSize(src, d.size);
        } else if (d.rock !== undefined && rocks[0]) {
          const mat = natureMaterial.clone();
          mat.color.set(d.rock);
          const boulder = new THREE.Mesh(rocks[0], mat);
          boulder.castShadow = true;
          const g = new THREE.Group();
          g.scale.setScalar(d.size);
          g.add(boulder);
          obj = g;
        }
        if (!obj) continue;
        if (d.name) obj.name = d.name;
        obj.position.set(d.at[0], d.y ?? 0, d.at[1]);
        obj.rotation.y = d.rot ?? 0;
        group.add(obj);
      }
    };

    const buildings = new Map<BuildingTypeId, THREE.Group>();
    for (const [type, file] of Object.entries(BUILDING_FILES) as [BuildingTypeId, string][]) {
      const scene = loaded.get(file)!.clone();
      if (type === 'woodcutter') {
        // The pack bakes stock into the lumbermill: a two-layer log pile
        // along the west wall, three stacked planks and two loose boards
        // out front, and little billet stacks against the east and south
        // walls. None of it was ever hauled, and it stands right where the
        // real stock piles up. Cut it (boxes validated component-by-
        // component against the source mesh; the stump, the axe and the
        // board on the saw bench are workshop character and stay). Main
        // mesh only — the top mesh has a roof post grazing one box.
        const CUT: [number, number, number, number, number, number][] = [
          [-0.7, 0.008, -0.475, -0.425, 0.2, 0.235], // log pile, west wall
          [0.0, -0.02, 0.35, 0.42, 0.155, 0.58], // three stacked planks, front
          [0.08, 0.008, 0.148, 0.49, 0.09, 0.28], // two loose boards, porch
          [0.565, 0.06, -0.14, 0.6, 0.18, 0.02], // billets, east wall
          [-0.36, 0.06, -0.465, -0.19, 0.18, -0.425], // billets, south wall
          [0.036, 0.06, -0.465, 0.145, 0.18, -0.425], // lone billet, south wall
        ];
        scene.traverse((o) => {
          if (o instanceof THREE.Mesh && o.name === 'building_lumbermill_green') {
            for (const [x0, y0, z0, x1, y1, z1] of CUT) {
              o.geometry = stripTrianglesInBox(
                o.geometry as THREE.BufferGeometry,
                new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1)),
              );
            }
          }
        });
      }
      if (type === 'quarry' || type === 'ironMine' || type === 'silverMine' || type === 'goldMine') {
        // The mine model bakes three spoil boulders at its mouth — stock
        // that was never mined. Cut them (validated component-by-component
        // like the lumbermill; the rocky mounds and frame lose at most a
        // ground-level triangle each, hidden under the yard stock that
        // stands in the same spots). Live ore re-fills the yard through
        // buildingSync's YARDS table.
        const CUT: [number, number, number, number, number, number][] = [
          [-0.6, 0.01, 0.25, -0.27, 0.23, 0.57], // big boulder
          [0.24, 0.01, 0.5, 0.42, 0.13, 0.68], // small boulder, east
          [-0.73, 0.01, 0.37, -0.55, 0.16, 0.56], // small boulder, west
        ];
        scene.traverse((o) => {
          if (o instanceof THREE.Mesh && o.name === 'building_mine_green') {
            for (const [x0, y0, z0, x1, y1, z1] of CUT) {
              o.geometry = stripTrianglesInBox(
                o.geometry as THREE.BufferGeometry,
                new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1)),
              );
            }
          }
        });
      }
      if (type === 'fishery') {
        // The pack perches a finished sailing ship on the shipyard's ridge —
        // a whole vessel, masts and sails, sitting on the roof. It reads as
        // a toy on a shelf at village zoom, and the hull already under
        // construction on the slipway is the part that says shipyard. Cut
        // the roof ship; the chimney (z > 0.55) and the ridge (x > 0.45)
        // sit outside the box and survive.
        const CUT: [number, number, number, number, number, number][] = [
          [0.02, 0.72, -0.36, 0.46, 1.3, 0.46],
        ];
        scene.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            for (const [x0, y0, z0, x1, y1, z1] of CUT) {
              o.geometry = stripTrianglesInBox(
                o.geometry as THREE.BufferGeometry,
                new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1)),
              );
            }
          }
        });
      }
      if (type === 'well') {
        // The pack bakes a static windlass into the well's single mesh: an
        // axle along x resting on the side frames, a crank handle hanging
        // off its +x end, and a rope + hook over the shaft. Cut exactly
        // those parts (boxes validated triangle-by-triangle against the
        // source obj — everything else on those planes is roof, gable, or
        // lattice and must survive) and rebuild the assembly as our own
        // 'wellCrank' group, which buildingSync spins while the well is
        // staffed. The free packs ship no .blend sources, so the scalpel
        // is code.
        const CUT: [number, number, number, number, number, number][] = [
          [-0.155, 0.28, -0.05, 0.155, 0.4, 0.05], // axle mid-span + rope hook
          [-0.33, 0.29, -0.05, -0.29, 0.38, 0.05], // axle west end cap
          [0.29, 0.29, -0.05, 0.33, 0.38, 0.05], // axle east end cap
          [0.25, 0.2, -0.03, 0.35, 0.335, 0.03], // crank handle
          [-0.02, 0.1, -0.02, 0.02, 0.32, 0.02], // rope down the shaft
        ];
        scene.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            for (const [x0, y0, z0, x1, y1, z1] of CUT) {
              o.geometry = stripTrianglesInBox(
                o.geometry as THREE.BufferGeometry,
                new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1)),
              );
            }
          }
        });
        const wood = new THREE.MeshLambertMaterial({ color: 0x7a5a38 });
        const part = (geo: THREE.BufferGeometry): THREE.Mesh => {
          const m = new THREE.Mesh(geo, wood);
          m.castShadow = true;
          return m;
        };
        const crank = new THREE.Group();
        crank.name = 'wellCrank';
        // Axle along x between the side frames, where the baked one sat.
        const axle = part(new THREE.CylinderGeometry(0.028, 0.028, 0.63, 8));
        axle.rotation.z = Math.PI / 2;
        crank.add(axle);
        // Crank arm drops from the +x axle end; grip points further +x so
        // the serf standing east of the well can reach it. Short arm on
        // purpose: the grip's orbit has to stay inside the reeling hands'
        // workspace or the "cranking" reads as miming.
        const arm = part(new THREE.BoxGeometry(0.05, 0.12, 0.036));
        arm.position.set(0.3, -0.05, 0);
        crank.add(arm);
        const grip = part(new THREE.CylinderGeometry(0.022, 0.022, 0.12, 6));
        grip.name = 'wellGrip'; // sceneSync IK-glues the drawing serf's hand here
        grip.rotation.z = Math.PI / 2;
        grip.position.set(0.36, -0.09, 0);
        crank.add(grip);
        // Model units (pre-normalize): the baked axle centered at y≈0.336.
        crank.position.set(0, 0.336, 0);
        scene.add(crank);
      }
      if (type === 'mill') {
        // No surgery needed here: the pack ships the sails as their own
        // node, hub-centered with the blades in its local x/y plane — made
        // to be spun. Name it so buildingSync can find it and turn it
        // while the mill grinds.
        const fan = scene.getObjectByName('building_windmill_top_fan_green');
        if (fan) fan.name = 'millFan';
      }
      const tint = TINTS[type];
      if (tint !== undefined) {
        scene.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            const m = (o.material as THREE.MeshStandardMaterial).clone();
            m.color.lerp(new THREE.Color(tint), 0.45);
            o.material = m;
          }
        });
      }
      const group = normalize(scene);
      dress(type, group);
      splitTeamColorGroups(group);
      buildings.set(type, group);
    }

    // The buildings we model ourselves. Same normalize, same dressing, same
    // team-color split — they are UV-mapped into the pack's atlas like a
    // loaded model, so nothing downstream needs a special case.
    const pieces = new Map<string, THREE.Mesh>();
    for (const [name, spec] of Object.entries(PACK_PIECES)) {
      const src = loaded.get(spec.file);
      const piece = src ? cutPackPiece(src, spec) : null;
      if (piece) pieces.set(name, piece);
    }
    const piece: PieceFactory = (name, height) => {
      const src = pieces.get(name);
      if (!src) return null;
      const c = src.clone();
      const [, h] = src.userData.size as [number, number, number];
      c.scale.setScalar(height / Math.max(h, 1e-6));
      return c;
    };
    // The pack's own material — one texture, one set of parameters, shared
    // by every model in it. A built building draws from the same one, so
    // there is no second material in the scene pretending to match it.
    let packMaterial: THREE.Material | null = null;
    loaded.get('building_home_A_green.gltf')?.traverse((o) => {
      if (!packMaterial && o instanceof THREE.Mesh) packMaterial = o.material as THREE.Material;
    });
    for (const [type, build] of Object.entries(BUILT_BUILDINGS) as [
      BuildingTypeId,
      (piece: PieceFactory, packMaterial: THREE.Material | null) => THREE.Group,
    ][]) {
      const group = normalize(build(piece, packMaterial));
      dress(type, group);
      // Its roof is UV-mapped into the same atlas cell a pack roof uses, so
      // the ordinary team-color split finds it without a special case.
      splitTeamColorGroups(group);
      buildings.set(type, group);
    }

    const props = new Map<string, THREE.Group>();
    for (const p of DECOR_PROP_FILES) {
      const scene = loaded.get(`${p}.gltf`);
      if (scene) props.set(p, scene);
    }
    for (const p of GLB_PROP_FILES) {
      const scene = loaded.get(p);
      if (scene) props.set(p.replace(/\.glb$/, ''), scene);
    }
    assets = {
      buildings,
      trees,
      rocks,
      lily,
      reed,
      bushes,
      deadTrees,
      natureMaterial,
      forestMaterial,
      props,
    };
    return true;
  }
}

/**
 * Split a building's triangles into two draw groups: everything textured
 * as usual, plus the team-color slot KayKit reserves in the atlas. Done
 * once per building template; instances just swap group 1's material for
 * their owner's color.
 */
function splitTeamColorGroups(root: THREE.Object3D): void {
  const { u0, u1, v0, v1 } = TEAM_SWATCH_UV;
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const geo = (o.geometry as THREE.BufferGeometry).clone();
    const index = geo.getIndex();
    const uv = geo.getAttribute('uv');
    if (!index || !uv) return;
    const inSlot = (i: number): boolean => {
      const u = uv.getX(i);
      const v = uv.getY(i);
      return u >= u0 && u <= u1 && v >= v0 && v <= v1;
    };
    const plain: number[] = [];
    const team: number[] = [];
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i);
      const b = index.getX(i + 1);
      const c = index.getX(i + 2);
      // A triangle belongs to the team slot only if it lies wholly inside.
      (inSlot(a) && inSlot(b) && inSlot(c) ? team : plain).push(a, b, c);
    }
    if (team.length === 0) return; // nothing faction-colored on this mesh
    geo.setIndex([...plain, ...team]);
    geo.clearGroups();
    geo.addGroup(0, plain.length, 0);
    geo.addGroup(plain.length, team.length, 1);
    o.geometry = geo;
    // Slot 1 is a placeholder here; makeGlbBuilding fills it per owner.
    o.material = [o.material as THREE.Material, o.material as THREE.Material];
  });
}

/** Per-owner flat material for the team-color slot. */
const teamMaterials = new Map<number, THREE.MeshLambertMaterial>();

function teamMaterial(color: number): THREE.MeshLambertMaterial {
  let m = teamMaterials.get(color);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color });
    teamMaterials.set(color, m);
  }
  return m;
}

export function makeGlbBuilding(type: BuildingTypeId, owner = 0): THREE.Group | null {
  const template = assets?.buildings.get(type);
  if (!template) return null;
  const def = BUILDING_DEFS[type];
  const group = template.clone();
  // Paint the team-color slot: rival castles, mills and mines read at a
  // glance without a marker floating over them. Bandits keep the stock
  // slate, which is exactly what "no faction" should look like.
  const faction = factionTint(owner);
  if (faction !== undefined) {
    const team = teamMaterial(faction);
    group.traverse((o) => {
      if (o instanceof THREE.Mesh && Array.isArray(o.material)) {
        o.material = [o.material[0]!, team];
      }
    });
  }
  // Templates are unit-square and origin-centered, matching the hand-built
  // models (buildingSync positions the root at the footprint center). Sizing
  // by footprint is what makes a squat model stay squat, so the few the pack
  // authors too low to read carry a modelScale to lift them out of it.
  group.scale.setScalar(Math.min(def.w, def.h) * 1.06 * (def.modelScale ?? 1));
  return group;
}

/** Palette-textured tree-species geometries for the scatter system, or null. */
export function glbTrees(): {
  geometries: THREE.BufferGeometry[];
  material: THREE.Material;
} | null {
  if (!assets) return null;
  return { geometries: assets.trees, material: assets.natureMaterial };
}

/** Palette-textured rock variants for the scatter system, or null. */
export function glbRocks(): {
  geometries: THREE.BufferGeometry[];
  material: THREE.Material;
} | null {
  if (!assets) return null;
  return { geometries: assets.rocks, material: assets.natureMaterial };
}

/**
 * Water doodad geometries for the scatter system, or null before load.
 * More species (the KayKit Forest / Dungeon packs' bushes, mushrooms,
 * stumps...) slot in here: drop the .gltf/.bin pair into
 * public/models/kaykit/, add the filename to DOODAD_FILES above, bake it
 * like these two, and give ScatterMesh a placement rule.
 */
export function glbDoodads(): {
  lily: THREE.BufferGeometry;
  reed: THREE.BufferGeometry;
  material: THREE.Material;
} | null {
  if (!assets) return null;
  return { lily: assets.lily, reed: assets.reed, material: assets.natureMaterial };
}

/**
 * Forest-pack scenery for the scatter system: leafy shrubs and bare dead
 * trunks, on the pack's own palette material. Null before load.
 */
export function glbForest(): {
  bushes: THREE.BufferGeometry[];
  deadTrees: THREE.BufferGeometry[];
  material: THREE.Material;
} | null {
  if (!assets) return null;
  return { bushes: assets.bushes, deadTrees: assets.deadTrees, material: assets.forestMaterial };
}

/** Tinted nature materials for yard rocks, cached per color. */
const yardRockMaterials = new Map<number, THREE.MeshLambertMaterial>();

/** A spoil boulder for the mine yards: the scatter rock geometry under a
 * tinted nature material, scaled like BUILDING_DECOR's rock branch was —
 * live ore stock wearing the exact look of the decor it replaces. */
export function glbYardRock(color: number, size: number): THREE.Group | null {
  if (!assets || !assets.rocks[0]) return null;
  // Tinted materials are cached per color (like teamMaterials above):
  // stock piles come and go constantly, and a fresh material clone per
  // pile leaked GPU programs/uniforms on every bare remove().
  let mat = yardRockMaterials.get(color);
  if (!mat) {
    mat = (assets.natureMaterial as THREE.MeshLambertMaterial).clone();
    mat.color.set(color);
    yardRockMaterials.set(color, mat);
  }
  const boulder = new THREE.Mesh(assets.rocks[0], mat);
  boulder.castShadow = true;
  const g = new THREE.Group();
  g.scale.setScalar(size);
  g.add(boulder);
  return g;
}

/** A pack prop normalized to `height` tall, feet on the ground — the same
 * framing BUILDING_DECOR uses. For live stock that stands in for baked
 * yard decor the surgery cut out (the woodcutter's lumber stacks). */
export function glbYardProp(prop: string, height: number): THREE.Group | null {
  const src = assets?.props.get(prop);
  if (!src) return null;
  const c = src.clone();
  const bb = new THREE.Box3().setFromObject(c);
  const h = Math.max(bb.max.y - bb.min.y, 1e-6);
  c.position.set(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  const g = new THREE.Group();
  g.scale.setScalar(height / h);
  g.add(c);
  return g;
}

/**
 * A pack prop cloned and normalized for carrying: centered on the origin
 * and scaled to `span` across — so what a serf hauls matches what's piled
 * in the yards (the mill's squared beams, the quarry's stone). Null when
 * the assets aren't loaded or the prop is unknown.
 */
export function glbCarryProp(
  prop: string,
  span: number,
  rot?: [number, number, number],
): THREE.Group | null {
  const src = assets?.props.get(prop);
  if (!src) return null;
  const c = src.clone();
  // Laid before it is measured: the tools are authored standing (grip at
  // the origin, head up +Y), and a carried load lies across the arms — a
  // span read off the standing prop would be the head's width, not the
  // tool's length.
  if (rot) {
    c.rotation.set(...rot);
    c.updateMatrixWorld(true);
  }
  const bb = new THREE.Box3().setFromObject(c);
  const width = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z, 1e-6);
  c.position.set(
    -(bb.min.x + bb.max.x) / 2,
    -(bb.min.y + bb.max.y) / 2,
    -(bb.min.z + bb.max.z) / 2,
  );
  const g = new THREE.Group();
  g.scale.setScalar(span / width);
  g.add(c);
  return g;
}
