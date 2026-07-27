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
  ironMine: 'building_mine_green.gltf',
  silverMine: 'building_mine_green.gltf',
  goldMine: 'building_mine_green.gltf',
  swordsmith: 'building_blacksmith_green.gltf',
  spearmaker: 'building_blacksmith_green.gltf',
  bowyer: 'building_archeryrange_green.gltf',
  dojo: 'building_barracks_green.gltf',
  terakoya: 'building_church_green.gltf',
  banditCamp: 'building_tower_B_red.gltf',
};

/** Tints so buildings sharing a model read apart (mines by ore; smiths). */
const TINTS: Partial<Record<BuildingTypeId, number>> = {
  ironMine: 0x8a7a72,
  silverMine: 0xcdd4dc,
  goldMine: 0xe0b44a,
  spearmaker: 0x9a7a4e,
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
      [...files, ...TREE_FILES, ...ROCK_FILES].map(async (f) => {
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
      buildings.set(type, normalize(scene));
    }

    let natureMap: THREE.Texture | null = null;
    const bakeNormalized = (f: string): THREE.BufferGeometry => {
      const { geometry: geo, map } = bakeToGeometry(loaded.get(f)!);
      natureMap ??= map;
      // Normalize: base at 0, height 1.
      geo.computeBoundingBox();
      const tb = geo.boundingBox!;
      geo.translate(-(tb.min.x + tb.max.x) / 2, -tb.min.y, -(tb.min.z + tb.max.z) / 2);
      const s = 1 / (tb.max.y - tb.min.y);
      geo.scale(s, s, s);
      return geo;
    };
    const trees = TREE_FILES.map(bakeNormalized);
    const rocks = ROCK_FILES.map(bakeNormalized);

    assets = {
      buildings,
      trees,
      rocks,
      natureMaterial: new THREE.MeshLambertMaterial({ map: natureMap }),
    };
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
