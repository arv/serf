import * as THREE from 'three';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import type {BuildingSnap} from '../../src/protocol/messages';
import {loadGlbAssets} from '../../src/render/assets';
import {BuildingSync} from '../../src/render/buildingSync';
import {HeightField} from '../../src/render/heightField';
import {water, waterDeep, waterShore} from '../../src/render/palette';
import {TerrainMesh} from '../../src/render/terrainMesh';
import * as BuildingState from '../../src/sim/buildingStateEnum.ts';
import {
  buildingDef,
  type BuildingTypeId as BuildingTypeIdT,
} from '../../src/sim/defs/buildings';
import * as BuildingTypeId from '../../src/sim/defs/buildingTypeIdEnum.ts';
import {WATER_LEVEL} from '../../src/sim/map';
import {canPlace, createWorld, waterFacing} from '../../src/sim/world';

/**
 * Export a patch of real shoreline as a .glb: the ground, the lake, a
 * fishery on a legal site with its deck fitted, and a house up the bank.
 *
 * The sibling page exports one building on nothing. This one is _pier.html's
 * stage rather than the other pages': a generated world, `canPlace`'s own
 * legal sites and `BuildingSync`'s own deck fit against the real height
 * field — so the deck stands where a match would stand it.
 *
 * Two things cannot cross glTF and are rebuilt here rather than faked:
 *
 * - The water. `WaterMesh` is a full-map plane whose whole look (depth
 *   grading, drift, per-pixel alpha) is a shader injected through
 *   onBeforeCompile, and a shader is exactly what a .glb cannot carry. So
 *   the lake here is real geometry: a cell wherever the bed sits under the
 *   waterline, vertex-coloured from the same three palette colours by the
 *   depth beneath it. The outline you see is the shoreline, which is the
 *   thing a plane would have hidden.
 * - The ground's extent. The full lattice is 663k triangles (SEG=6 across
 *   `play` tiles); cropping to a box around the site keeps what a shoreline
 *   question needs and leaves the rest.
 *
 * Scatter is left out: `ScatterMesh` is InstancedMesh, which GLTFExporter
 * does not write.
 *
 *   ?seed=<n>    which world to trawl (default 1)
 *   ?at=x,y      a named fishery site, instead of the first legal one
 *   ?r=<tiles>   crop radius about the site (default 14)
 *   ?owner=<n>   seat colour
 */

declare global {
  interface Window {
    __GLB?: string;
    __GLB_ERROR?: string;
    __GLB_NOTE?: string;
  }
}

const status = document.getElementById('status')!;
const q = new URLSearchParams(location.search);
const SEED = Number(q.get('seed') ?? 1);
const R = Number(q.get('r') ?? 14);
const OWNER = Number(q.get('owner') ?? 0);
const AT = q.get('at')?.split(',').map(Number);

/** The snapshot BuildingSync wants — the sim's own facing, or the deck
 * would point +z on every site and the fit would be judged on a straw man. */
function snap(
  id: number,
  type: BuildingTypeIdT,
  x: number,
  y: number,
  map: Parameters<typeof waterFacing>[0],
): BuildingSnap {
  const def = buildingDef(type);
  return {
    id,
    type,
    owner: OWNER,
    x,
    y,
    w: def.w,
    h: def.h,
    facing: waterFacing(map, x, y, def.w, def.h, 1),
    hp: def.hp,
    maxHp: def.hp,
    state: BuildingState.built,
    stock: {},
    inputs: {},
    inbound: {},
    reservedOut: {},
  };
}

/**
 * The ground inside a box, as one mesh.
 *
 * Chunks index a lattice they all share, so a chunk's geometry carries the
 * whole map's attributes and cropping by chunk would export every one of
 * them. Walking the triangles and rebuilding compacted arrays keeps only
 * what the box holds — and does it per triangle, which follows the box
 * rather than the 16-tile chunk grid.
 */
function cropTerrain(
  group: THREE.Object3D,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
): THREE.Mesh | null {
  const names = ['position', 'normal', 'uv', 'color'];
  const src: Record<string, THREE.BufferAttribute> = {};
  const dst: Record<string, number[]> = {};
  let material: THREE.Material | undefined;
  const remap = new Map<number, number>();
  const index: number[] = [];

  group.traverse(o => {
    if (!(o instanceof THREE.Mesh)) return;
    const geo = o.geometry as THREE.BufferGeometry;
    const idx = geo.index;
    if (!idx) return;
    if (!material) {
      material = o.material as THREE.Material;
      for (const n of names) {
        const a = geo.attributes[n] as THREE.BufferAttribute | undefined;
        if (a) {
          src[n] = a;
          dst[n] = [];
        }
      }
    }
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let t = 0; t < idx.count; t += 3) {
      const a = idx.getX(t);
      const b = idx.getX(t + 1);
      const c = idx.getX(t + 2);
      // Centroid, so a triangle belongs to exactly one side of the edge.
      const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
      const cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
      if (cx < x0 || cx > x1 || cz < z0 || cz > z1) continue;
      for (const v of [a, b, c]) {
        let m = remap.get(v);
        if (m === undefined) {
          m = remap.size;
          remap.set(v, m);
          for (const n of names) {
            const at = src[n];
            if (!at) continue;
            for (let k = 0; k < at.itemSize; k++) {
              dst[n]!.push(at.getComponent(v, k));
            }
          }
        }
        index.push(m);
      }
    }
  });

  if (!material || !index.length) return null;
  const geo = new THREE.BufferGeometry();
  for (const n of names) {
    const at = src[n];
    if (!at) continue;
    geo.setAttribute(
      n,
      new THREE.BufferAttribute(new Float32Array(dst[n]!), at.itemSize),
    );
  }
  geo.setIndex(index);
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'land';
  return mesh;
}

/**
 * The lake inside a box: a cell wherever the bed is under the waterline,
 * two cells to the tile so the shoreline is drawn rather than stepped.
 *
 * A cell is kept when ANY corner is wet, so the surface runs right up under
 * the bank instead of stopping a cell short of it; the ground there stands
 * above the waterline and pokes through, exactly as it does under the
 * game's plane.
 */
function makeLake(
  heights: HeightField,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
): THREE.Mesh | null {
  const STEP = 0.5;
  const shore = new THREE.Color(waterShore);
  const mid = new THREE.Color(water);
  const deep = new THREE.Color(waterDeep);
  const tint = (depth: number): THREE.Color =>
    depth < 0.5
      ? shore.clone().lerp(mid, depth / 0.5)
      : mid.clone().lerp(deep, Math.min(1, (depth - 0.5) / 1.0));

  const pos: number[] = [];
  const col: number[] = [];
  const index: number[] = [];
  for (let z = z0; z < z1; z += STEP) {
    for (let x = x0; x < x1; x += STEP) {
      const corners: [number, number][] = [
        [x, z],
        [x + STEP, z],
        [x, z + STEP],
        [x + STEP, z + STEP],
      ];
      const beds = corners.map(([cx, cz]) => heights.at(cx, cz));
      if (!beds.some(h => h < WATER_LEVEL)) continue;
      const base = pos.length / 3;
      for (let i = 0; i < 4; i++) {
        const [cx, cz] = corners[i]!;
        pos.push(cx, WATER_LEVEL, cz);
        const c = tint(Math.max(0, WATER_LEVEL - beds[i]!));
        col.push(c.r, c.g, c.b);
      }
      index.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }
  }
  if (!index.length) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      roughness: 0.25,
      metalness: 0,
      side: THREE.DoubleSide,
    }),
  );
  mesh.name = 'lake';
  return mesh;
}

try {
  await loadGlbAssets();
  const world = createWorld(SEED);
  const map = world.map;
  const heights = new HeightField(map.height, map.size);

  const fp = buildingDef(BuildingTypeId.fishery).w;
  const sites: {x: number; y: number}[] = [];
  for (let y = 0; y < map.size - fp; y++) {
    for (let x = 0; x < map.size - fp; x++) {
      if (canPlace(map, BuildingTypeId.fishery, x, y)) sites.push({x, y});
    }
  }
  if (!sites.length) throw new Error(`seed ${SEED} has no legal fishery site`);
  const site = AT
    ? (sites.find(s => s.x === AT[0] && s.y === AT[1]) ??
      (() => {
        throw new Error(`(${AT[0]},${AT[1]}) is not a legal fishery site`);
      })())
    : sites[Math.floor(sites.length / 2)]!;

  // A house up the bank: the nearest legal one a clear tile off the
  // fishery, so the two read as neighbours rather than as one blob.
  let house: {x: number; y: number} | undefined;
  for (let ring = 4; ring <= 12 && !house; ring++) {
    for (let dy = -ring; dy <= ring && !house; dy++) {
      for (let dx = -ring; dx <= ring && !house; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = site.x + dx;
        const y = site.y + dy;
        if (canPlace(map, BuildingTypeId.house, x, y)) house = {x, y};
      }
    }
  }

  const cx = site.x + fp / 2;
  const cz = site.y + fp / 2;
  const x0 = cx - R;
  const x1 = cx + R;
  const z0 = cz - R;
  const z1 = cz + R;

  const scene = new THREE.Scene();
  const terrain = new TerrainMesh(map, heights);
  terrain.repaintAll();
  const land = cropTerrain(terrain.group, x0, x1, z0, z1);
  if (land) scene.add(land);
  const lake = makeLake(heights, x0, x1, z0, z1);
  if (lake) scene.add(lake);

  const snaps = [snap(1, BuildingTypeId.fishery, site.x, site.y, map)];
  if (house) {
    snaps.push(snap(2, BuildingTypeId.house, house.x, house.y, map));
  }
  const sync = new BuildingSync(scene, heights);
  sync.update(snaps);
  const pier = sync.fisheryPiers()[0];

  // Bring the site to the origin: a map tile is an arbitrary place to open
  // a DCC tool at, and 'land' and 'lake' would sit far off in world space.
  const root = new THREE.Group();
  root.name = `seed${SEED}_${site.x}_${site.y}`;
  root.position.set(-cx, 0, -cz);
  // Re-parenting mutates scene.children, so snapshot the ids first.
  const kids = scene.children.slice();
  for (const child of kids) root.add(child);
  const out = new THREE.Scene();
  out.add(root);

  const bin = await new GLTFExporter().parseAsync(out, {binary: true});
  const bytes = new Uint8Array(bin as ArrayBuffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  window.__GLB = btoa(s);
  const wet =
    pier && heights.at(pier.spotX, pier.spotZ) < WATER_LEVEL ? 'wet' : 'DRY';
  window.__GLB_NOTE =
    `seed ${SEED}: ${sites.length} legal fishery sites; ` +
    `chose (${site.x},${site.y}), deck ${wet}; ` +
    `house ${house ? `(${house.x},${house.y})` : 'NOT PLACED'}; ` +
    `crop ${R * 2}x${R * 2} tiles`;
  status.textContent = `exported (${bytes.length} bytes)`;
} catch (err) {
  window.__GLB_ERROR = String(err instanceof Error ? err.stack : err);
  status.textContent = `failed: ${String(err)}`;
}
