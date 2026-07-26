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

const DIR = '/models/medieval/';

/** Which pack model plays each (still Japanese-named) building. */
const BUILDING_FILES: Partial<Record<BuildingTypeId, string>> = {
  storehouse: 'TownCenter_SecondAge_Level2',
  bambooHut: 'Houses_FirstAge_1_Level1',
  quarry: 'Mine',
  ricePaddy: 'Farm_FirstAge_Level2_Wheat',
  sakeBrewery: 'Windmill_FirstAge',
  ironMine: 'Mine',
  silverMine: 'Mine',
  goldMine: 'Mine',
  swordsmith: 'TowerHouse_SecondAge',
  spearmaker: 'Houses_SecondAge_2_Level1',
  bowyer: 'Archery_FirstAge_Level2',
  dojo: 'Barracks_FirstAge_Level2',
  terakoya: 'Temple_FirstAge_Level2',
  banditCamp: 'WatchTower_FirstAge_Level2',
  // well keeps its hand-built model — the pack has no well.
};

/** Ore-tinted copies of the Mine so the three metal mines read apart. */
const MINE_TINTS: Partial<Record<BuildingTypeId, number>> = {
  ironMine: 0x8a7a72,
  silverMine: 0xcdd4dc,
  goldMine: 0xe0b44a,
};

interface Assets {
  buildings: Map<BuildingTypeId, THREE.Group>;
  treeGeometry: THREE.BufferGeometry;
  treeMaterial: THREE.Material;
}

let assets: Assets | null = null;

/**
 * Flatten a gltf scene into one vertex-colored geometry (material base
 * colors baked per vertex) so it can drive an InstancedMesh.
 */
function bakeToGeometry(scene: THREE.Group): THREE.BufferGeometry {
  scene.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const geo = (o.geometry as THREE.BufferGeometry).clone().toNonIndexed();
    geo.applyMatrix4(o.matrixWorld);
    for (const name of Object.keys(geo.attributes)) {
      if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
    }
    const color = ((o.material as THREE.MeshStandardMaterial).color ?? new THREE.Color(1, 1, 1))
      .clone()
      .convertLinearToSRGB();
    const count = geo.getAttribute('position').count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) colors.set([color.r, color.g, color.b], i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    parts.push(geo);
  });
  return mergeGeometries(parts);
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
    const loaded = new Map<string, THREE.Group>();
    await Promise.all(
      [...files, 'Resource_Tree_Group'].map(async (f) => {
        const gltf = await loader.loadAsync(`${DIR}${f}.gltf`);
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
      const tint = MINE_TINTS[type];
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

    const treeGeo = bakeToGeometry(loaded.get('Resource_Tree_Group')!);
    // Normalize the tree clump: feet at 0, height 1.
    treeGeo.computeBoundingBox();
    const tb = treeGeo.boundingBox!;
    treeGeo.translate(-(tb.min.x + tb.max.x) / 2, -tb.min.y, -(tb.min.z + tb.max.z) / 2);
    treeGeo.scale(1 / (tb.max.y - tb.min.y), 1 / (tb.max.y - tb.min.y), 1 / (tb.max.y - tb.min.y));

    assets = {
      buildings,
      treeGeometry: treeGeo,
      treeMaterial: new THREE.MeshLambertMaterial({ vertexColors: true }),
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

/** Vertex-colored tree-clump geometry for the scatter system, or null. */
export function medievalTree(): { geometry: THREE.BufferGeometry; material: THREE.Material } | null {
  if (!assets) return null;
  return { geometry: assets.treeGeometry, material: assets.treeMaterial };
}
