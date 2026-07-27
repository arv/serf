import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BUILDING_DEFS, type BuildingTypeId } from '../sim/defs/buildings';

/**
 * Medieval/fantasy look (branch experiment): building and tree models from
 * the Quaternius "Ultimate Fantasy RTS" pack (CC0), swapped in over the
 * unchanged feudal-Japan sim. The theme is a URL switch so the two looks can
 * be compared in one build: this branch defaults to medieval; ?theme=japan
 * shows the hand-built originals.
 */

export const THEME: 'medieval' | 'japan' =
  new URLSearchParams(location.search).get('theme') === 'japan' ? 'japan' : 'medieval';

const DIR = '/models/kaykit/';

/**
 * Which KayKit Medieval Hexagon model (CC0, Kay Lousberg) plays each (still
 * Japanese-named) building. Green is the player faction; red the bandits.
 */
const BUILDING_FILES: Partial<Record<BuildingTypeId, string>> = {
  storehouse: 'building_castle_green.gltf',
  bambooHut: 'building_lumbermill_green.gltf',
  quarry: 'building_mine_green.gltf',
  well: 'building_well_green.gltf',
  ricePaddy: 'farm_plot.glb',
  sakeBrewery: 'building_tavern_green.gltf',
  // Each metal mine is its own faction-colored variant, dressed differently.
  ironMine: 'building_mine_red.gltf',
  silverMine: 'building_mine_blue.gltf',
  goldMine: 'building_mine_yellow.gltf',
  swordsmith: 'building_blacksmith_green.gltf',
  spearmaker: 'building_blacksmith_green.gltf',
  bowyer: 'building_archeryrange_green.gltf',
  dojo: 'building_barracks_green.gltf',
  terakoya: 'building_church_green.gltf',
  banditCamp: 'building_tower_B_red.gltf',
};

/** Tints so buildings sharing a model read apart (the two smiths). */
const TINTS: Partial<Record<BuildingTypeId, number>> = {
  spearmaker: 0x9a7a4e,
};

/** Prop dressing placed around a building, in its unit-square space. */
interface Decor {
  /** A pack prop scene by file stem... */
  prop?: string;
  /** ...or an ore-tinted boulder. */
  rock?: number;
  at: [number, number];
  size: number;
  rot?: number;
}

const DECOR_PROP_FILES = ['wheelbarrow', 'sack', 'resource_stone', 'resource_lumber'];

const BUILDING_DECOR: Partial<Record<BuildingTypeId, Decor[]>> = {
  bambooHut: [{ prop: 'resource_lumber', at: [0.36, 0.28], size: 0.12, rot: 0.3 }],
  quarry: [
    { prop: 'resource_stone', at: [0.34, 0.3], size: 0.14 },
    { prop: 'wheelbarrow', at: [-0.36, 0.3], size: 0.15, rot: 0.6 },
  ],
  ironMine: [
    { rock: 0x9a5f42, at: [0.35, 0.3], size: 0.2 },
    { prop: 'wheelbarrow', at: [-0.35, 0.32], size: 0.15, rot: -0.5 },
  ],
  silverMine: [
    { rock: 0xdbe4ee, at: [0.35, 0.3], size: 0.2 },
    { prop: 'sack', at: [-0.33, 0.33], size: 0.11 },
  ],
  goldMine: [
    { rock: 0xf0bc42, at: [0.35, 0.3], size: 0.2 },
    { prop: 'sack', at: [-0.33, 0.33], size: 0.11, rot: 1.1 },
  ],
};

interface Assets {
  buildings: Map<BuildingTypeId, THREE.Group>;
  /** Distinct tree species geometries (normalized: feet at 0, height 1). */
  trees: THREE.BufferGeometry[];
  /** Rock variants, same normalization. */
  rocks: THREE.BufferGeometry[];
  /** Shared palette-textured material for trees and rocks. */
  natureMaterial: THREE.Material;
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

export async function loadMedievalAssets(): Promise<boolean> {
  if (THEME !== 'medieval') return false;
  try {
    const loader = new GLTFLoader();
    const files = new Set(Object.values(BUILDING_FILES));
    const TREE_FILES = ['tree_single_A.gltf', 'tree_single_B.gltf'];
    const ROCK_FILES = ['rock_single_A.gltf', 'rock_single_B.gltf', 'rock_single_C.gltf'];
    const loaded = new Map<string, THREE.Group>();
    await Promise.all(
      [...files, ...TREE_FILES, ...ROCK_FILES, ...DECOR_PROP_FILES.map((p) => `${p}.gltf`)].map(
        async (f) => {
        const gltf = await loader.loadAsync(`${DIR}${f}`);
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
    // Normalize: base at 0, and unit HEIGHT for tall things (trees) or unit
    // FOOTPRINT for ground clutter — the pack is authored for hex tiles, so
    // rocks are wider than they are tall and must be sized by span or they
    // overhang our square tiles (and clip the workers beside them).
    const bakeNormalized = (f: string, bySpan = false): THREE.BufferGeometry => {
      const { geometry: geo, map } = bakeToGeometry(loaded.get(f)!);
      natureMap ??= map;
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
    const natureMaterial = new THREE.MeshLambertMaterial({ map: natureMap });

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

    const buildings = new Map<BuildingTypeId, THREE.Group>();
    for (const [type, file] of Object.entries(BUILDING_FILES) as [BuildingTypeId, string][]) {
      const scene = loaded.get(file)!.clone();
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
      // Dress the yard: ore boulders, carts, sacks — the mines in
      // particular read apart by their spoil, not just their roof color.
      for (const d of BUILDING_DECOR[type] ?? []) {
        let obj: THREE.Object3D | undefined;
        if (d.prop !== undefined) {
          const src = loaded.get(`${d.prop}.gltf`);
          if (src) obj = propOfSize(src, d.size);
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
        obj.position.set(d.at[0], 0, d.at[1]);
        obj.rotation.y = d.rot ?? 0;
        group.add(obj);
      }
      buildings.set(type, group);
    }

    assets = { buildings, trees, rocks, natureMaterial };
    return true;
  } catch (err) {
    console.warn('[medieval] falling back to the Japan look:', err);
    return false;
  }
}

/**
 * A medieval stand-in for this building, scaled to its footprint — or null
 * (no model / theme off), in which case the hand-built model is used.
 */
export function makeMedievalBuilding(type: BuildingTypeId): THREE.Group | null {
  const template = assets?.buildings.get(type);
  if (!template) return null;
  const def = BUILDING_DEFS[type];
  const group = template.clone();
  // Templates are unit-square and origin-centered, matching the hand-built
  // models (buildingSync positions the root at the footprint center).
  group.scale.setScalar(Math.min(def.w, def.h) * 1.06);
  return group;
}

/** Palette-textured tree-species geometries for the scatter system, or null. */
export function medievalTrees(): {
  geometries: THREE.BufferGeometry[];
  material: THREE.Material;
} | null {
  if (!assets) return null;
  return { geometries: assets.trees, material: assets.natureMaterial };
}

/** Palette-textured rock variants for the scatter system, or null. */
export function medievalRocks(): {
  geometries: THREE.BufferGeometry[];
  material: THREE.Material;
} | null {
  if (!assets) return null;
  return { geometries: assets.rocks, material: assets.natureMaterial };
}
