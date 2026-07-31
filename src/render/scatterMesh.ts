import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MAP_SIZE, TILE_COUNT, tileX, tileY } from '../shared/grid';
import { hash2 } from '../shared/math';
import { Terrain, TileResource, type MapView } from '../sim/map';
import { palette } from './palette';
import { foliageMaterial, makeBambooCulmTexture, makeBambooLeafSprite } from './spriteTextures';
import { medievalRocks, medievalTrees } from './medieval';
import type { HeightField } from './heightField';

/**
 * Two quads crossed at 90°, each doubled back-to-back — the classic
 * alpha-tested foliage carrier. Both facings are front faces (no DoubleSide,
 * so two-sided lighting can't flip normals into shadow), and every normal
 * points straight up so the cards take the same light as the ground.
 */
export function crossedQuads(width: number, height: number): THREE.BufferGeometry {
  const a = new THREE.PlaneGeometry(width, height);
  const b = a.clone();
  b.rotateY(Math.PI / 2);
  const a2 = a.clone();
  a2.rotateY(Math.PI);
  const b2 = b.clone();
  b2.rotateY(Math.PI);
  const merged = mergeGeometries([a, b, a2, b2]);
  const normals = merged.attributes.normal!;
  for (let i = 0; i < normals.count; i++) normals.setXYZ(i, 0, 1, 0);
  return merged;
}

function touchesWater(map: MapView, idx: number): boolean {
  const x = idx % MAP_SIZE;
  const y = (idx / MAP_SIZE) | 0;
  for (const [nx, ny] of [
    [x - 1, y],
    [x + 1, y],
    [x, y - 1],
    [x, y + 1],
  ] as const) {
    if (nx < 0 || ny < 0 || nx >= MAP_SIZE || ny >= MAP_SIZE) continue;
    if (map.terrain[ny * MAP_SIZE + nx] === Terrain.Water) return true;
  }
  return false;
}

interface Archetype {
  mesh: THREE.InstancedMesh;
  /** tileIdx -> instance indices belonging to that tile. */
  byTile: Map<number, number[]>;
  cursor: number;
}

const dummy = new THREE.Object3D();
const tmpColor = new THREE.Color();

const CULMS_PER_TILE = 5;
const TREES_PER_TILE = 2;

/**
 * All standing scatter (bamboo culms, boulders, ore markers) as a handful of
 * InstancedMeshes. Depletion hides a tile's instances by zeroing their
 * matrices — counts are fixed at worldgen.
 */
export class ScatterMesh {
  readonly group = new THREE.Group();
  #archetypes = new Map<string, Archetype>();
  #heights: HeightField;
  #trees = false;
  #treeSpecies = 0;
  #rockSpecies = 0;

  /** Rock archetype for a seed — a KayKit variant, or the one procedural. */
  #rockName(seed: number): string {
    if (this.#rockSpecies === 0) return 'rock';
    const i = (hash2(seed, 41) * this.#rockSpecies) | 0;
    return i === 0 ? 'rock' : `rock${i}`;
  }

  constructor(map: MapView, heights: HeightField) {
    this.#heights = heights;
    // Count instances per archetype first (instanced meshes need fixed capacity).
    let bambooTiles = 0;
    let rockTiles = 0;
    let oreTiles = 0;
    const shoreTiles: number[] = [];
    for (let i = 0; i < TILE_COUNT; i++) {
      const res = map.resource[i];
      if (res === TileResource.Bamboo) bambooTiles++;
      else if (res === TileResource.Rock) rockTiles++;
      else if (res !== TileResource.None) oreTiles++;
      // Rocky banks: grass tiles touching water, thinned by hash.
      if (map.terrain[i] === Terrain.Grass && hash2(i, 91) < 0.45 && touchesWater(map, i)) {
        shoreTiles.push(i);
      }
    }

    const lambert = (color: number) => new THREE.MeshLambertMaterial({ color });
    const flat = (color: number) =>
      new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.95 });

    // Groves: on the medieval branch a mixed wood of three vertex-colored
    // tree species; otherwise bamboo — tall whip-thin culms (5 per tile)
    // wearing a painted node-ring texture with alpha-tested leaf sprites.
    const trees = medievalTrees();
    this.#trees = trees !== null;
    this.#treeSpecies = trees?.geometries.length ?? 0;
    if (trees) {
      trees.geometries.forEach((geo, i) => {
        this.#addArchetype(`tree${i}`, geo, trees.material, bambooTiles * TREES_PER_TILE, {
          receiveShadow: false,
        });
      });
    } else {
      const culmTexture = makeBambooCulmTexture();
      culmTexture.wrapS = THREE.RepeatWrapping;
      culmTexture.wrapT = THREE.RepeatWrapping;
      culmTexture.repeat.set(1, 2.5);
      this.#addArchetype(
        'culm',
        new THREE.CylinderGeometry(0.03, 0.045, 1, 6),
        new THREE.MeshLambertMaterial({ map: culmTexture }),
        bambooTiles * CULMS_PER_TILE,
        { receiveShadow: false }, // dense groves would shadow-spam themselves
      );
      this.#addArchetype(
        'spray',
        crossedQuads(1.5, 1.1),
        foliageMaterial(makeBambooLeafSprite()),
        bambooTiles * CULMS_PER_TILE * 3,
        { castShadow: false, receiveShadow: false },
      );
    }
    // Rocks: KayKit boulder variants on the medieval branch (ore deposits
    // become metal-tinted boulders too), procedural dodecahedra + crystal
    // octahedra otherwise.
    const rocks = medievalRocks();
    this.#rockSpecies = rocks?.geometries.length ?? 0;
    if (rocks) {
      rocks.geometries.forEach((geo, i) => {
        this.#addArchetype(
          i === 0 ? 'rock' : `rock${i}`,
          geo,
          rocks.material,
          rockTiles * 2 + shoreTiles.length * 2 + oreTiles * 4,
        );
      });
    } else {
      this.#addArchetype(
        'rock',
        new THREE.DodecahedronGeometry(0.32),
        flat(0xffffff),
        rockTiles * 2 + shoreTiles.length * 2,
      );
      this.#addArchetype('ore', new THREE.OctahedronGeometry(0.16), flat(0xffffff), oreTiles * 4);
    }

    for (let i = 0; i < TILE_COUNT; i++) {
      const res = map.resource[i];
      // A resource tile with all its neighbors blocked sits in the middle
      // of a formation: nothing walks there, so its rocks may sprawl big.
      // Edge tiles keep their rocks contained — a miner stands next door.
      const interior = ((): boolean => {
        const x = tileX(i);
        const y = tileY(i);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= MAP_SIZE || ny >= MAP_SIZE) continue;
            if (map.blocked[ny * MAP_SIZE + nx] === 0) return false;
          }
        }
        return true;
      })();
      if (res === TileResource.Bamboo) this.#placeBamboo(i);
      else if (res === TileResource.Rock) this.#placeRock(i, interior);
      else if (
        res === TileResource.IronDep ||
        res === TileResource.SilverDep ||
        res === TileResource.GoldDep
      ) {
        this.#placeOre(i, res, interior);
      }
    }
    for (const i of shoreTiles) {
      this.#placeShoreRocks(i);
      this.#cosmetic.add(i); // never resource-driven; a full resync skips it
    }

    for (const a of this.#archetypes.values()) {
      a.mesh.count = a.cursor;
      a.mesh.instanceMatrix.needsUpdate = true;
      if (a.mesh.instanceColor) a.mesh.instanceColor.needsUpdate = true;
    }
  }

  #cosmetic = new Set<number>();

  /**
   * Full resync (a reconnect resends the map): hide scatter on every tile
   * the refreshed map no longer grants a resource or leaves buildable
   * (shore decor is exempt). Scatter is only ever removed — if the refresh
   * *restores* a tree we had already felled, it stays hidden until
   * regrowth; a cosmetic, self-healing gap.
   */
  resyncAll(map: { resource: Uint8Array; buildingAt: Int16Array }): void {
    for (const a of this.#archetypes.values()) {
      for (const tile of [...a.byTile.keys()]) {
        if (this.#cosmetic.has(tile)) continue;
        if (map.resource[tile] === TileResource.None || map.buildingAt[tile]! >= 0) {
          this.removeTile(tile);
        }
      }
    }
  }

  /** Hide all scatter on a tile (resource depleted / cleared for building). */
  removeTile(tile: number): void {
    dummy.position.set(0, -100, 0);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.setScalar(0.0001);
    dummy.updateMatrix();
    for (const a of this.#archetypes.values()) {
      const ids = a.byTile.get(tile);
      if (!ids) continue;
      for (const id of ids) a.mesh.setMatrixAt(id, dummy.matrix);
      a.mesh.instanceMatrix.needsUpdate = true;
      a.byTile.delete(tile);
    }
  }

  #addArchetype(
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    capacity: number,
    opts?: { castShadow?: boolean; receiveShadow?: boolean },
  ): void {
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(capacity, 1));
    mesh.castShadow = opts?.castShadow ?? true;
    mesh.receiveShadow = opts?.receiveShadow ?? true;
    mesh.count = 0;
    this.group.add(mesh);
    this.#archetypes.set(name, { mesh, byTile: new Map(), cursor: 0 });
  }

  #put(
    name: string,
    tile: number,
    x: number,
    y: number,
    z: number,
    scaleY: number,
    scaleXZ: number,
    rotY: number,
    color: number,
    colorLerp: number,
    colorTarget: number,
    rotZ = 0,
  ): void {
    const a = this.#archetypes.get(name)!;
    const id = a.cursor++;
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, rotY, rotZ);
    dummy.scale.set(scaleXZ, scaleY, scaleXZ);
    dummy.updateMatrix();
    a.mesh.setMatrixAt(id, dummy.matrix);
    tmpColor.setHex(color).lerp(new THREE.Color(colorTarget), colorLerp);
    a.mesh.setColorAt(id, tmpColor);
    const list = a.byTile.get(tile);
    if (list) list.push(id);
    else a.byTile.set(tile, [id]);
  }

  #placeBamboo(tile: number): void {
    const tx = tileX(tile);
    const ty = tileY(tile);
    if (this.#trees) {
      // A mixed stand: two trees per tile, species/size/lean/tint all
      // hash-varied so no two copses repeat.
      for (let k = 0; k < TREES_PER_TILE; k++) {
        const seed = tile * TREES_PER_TILE + k;
        const species = (hash2(seed, 11) * this.#treeSpecies) | 0;
        const jx = 0.18 + hash2(seed, 1) * 0.64;
        const jz = 0.18 + hash2(seed, 2) * 0.64;
        const h = (k === 0 ? 1.5 : 1.0) + hash2(seed, 3) * 0.8;
        // Gentle hue variation over the painted texture: mostly green
        // shifts, the odd tree going ochre.
        const warm = hash2(seed, 6);
        this.#put(
          `tree${species}`,
          tile,
          tx + jx,
          this.#heights.at(tx + jx, ty + jz),
          ty + jz,
          h,
          h * (0.8 + hash2(seed, 5) * 0.35),
          hash2(seed, 4) * Math.PI * 2,
          0xffffff,
          warm > 0.85 ? 0.35 : warm * 0.22,
          warm > 0.85 ? 0xc8a050 : 0x6a8f4a,
          (hash2(seed, 7) - 0.5) * 0.1,
        );
      }
      return;
    }
    for (let k = 0; k < CULMS_PER_TILE; k++) {
      const seed = tile * CULMS_PER_TILE + k;
      // Culms bunch toward the tile center like a real grove clump.
      const jx = 0.28 + hash2(seed, 1) * 0.44;
      const jz = 0.28 + hash2(seed, 2) * 0.44;
      const h = 2.3 + hash2(seed, 3) * 1.3;
      const x = tx + jx;
      const z = ty + jz;
      const ground = this.#heights.at(x, z);
      // Whole-culm lean: offset the top by shifting via z-rotation.
      const lean = (hash2(seed, 4) - 0.5) * 0.22;
      // Culm tint rides on the painted node texture: young jade -> older gold.
      this.#put(
        'culm',
        tile,
        x,
        ground + h / 2,
        z,
        h,
        1,
        hash2(seed, 7) * Math.PI,
        0xffffff,
        hash2(seed, 8) * 0.45,
        0xd8c878,
        lean,
      );
      // 2-3 painted leaf sprays around the upper third of the culm.
      const sprays = 2 + (hash2(seed, 9) > 0.5 ? 1 : 0);
      for (let t = 0; t < sprays; t++) {
        const th = h * (0.6 + 0.17 * t) + hash2(seed, 10 + t) * 0.2;
        const ang = hash2(seed, 20 + t) * Math.PI * 2;
        const reach = 0.1 + hash2(seed, 30 + t) * 0.16;
        this.#put(
          'spray',
          tile,
          x + Math.cos(ang) * reach - lean * (th - h / 2),
          ground + th,
          z + Math.sin(ang) * reach,
          0.75 + hash2(seed, 40 + t) * 0.5,
          0.75 + hash2(seed, 50 + t) * 0.5,
          ang,
          0xffffff,
          hash2(seed, 60 + t) * 0.4,
          0x86a060,
        );
      }
    }
  }

  #placeRock(tile: number, interior = false): void {
    const tx = tileX(tile);
    const ty = tileY(tile);
    const tex = this.#rockSpecies > 0;
    for (let k = 0; k < 2; k++) {
      // KayKit rocks are span-normalized (hex-tile authoring is wider than
      // our square tiles). Interior tiles of a formation sprawl big and
      // dramatic; edge tiles stay contained so the boulder never clips the
      // miner working on the neighboring tile.
      const spread = interior ? 0.5 : 0.2;
      const jx = tex
        ? 0.5 - spread / 2 + hash2(tile * 2 + k, 21) * spread
        : 0.25 + hash2(tile * 2 + k, 21) * 0.5;
      const jz = tex
        ? 0.5 - spread / 2 + hash2(tile * 2 + k, 22) * spread
        : 0.25 + hash2(tile * 2 + k, 22) * 0.5;
      const s = tex
        ? k === 0
          ? (interior ? 1.05 : 0.6) + hash2(tile, 23) * (interior ? 0.35 : 0.2)
          : (interior ? 0.55 : 0.35) + hash2(tile, 24) * 0.15
        : k === 0
          ? 0.9 + hash2(tile, 23) * 0.5
          : 0.4 + hash2(tile, 24) * 0.3;
      this.#put(
        this.#rockName(tile * 2 + k),
        tile,
        tx + jx,
        this.#heights.at(tx + jx, ty + jz) + (tex ? -0.02 : 0.16 * s),
        ty + jz,
        tex ? s : s * 0.75,
        s,
        hash2(tile + k, 25) * Math.PI * 2,
        tex ? 0xffffff : palette.rock,
        hash2(tile + k, 26) * (tex ? 0.25 : 0.6),
        palette.rockDark,
      );
    }
  }

  /** Boulders spilling down the bank toward the water. */
  #placeShoreRocks(tile: number): void {
    const tx = tileX(tile);
    const ty = tileY(tile);
    const tex = this.#rockSpecies > 0;
    for (let k = 0; k < 2; k++) {
      if (k === 1 && hash2(tile, 95) < 0.5) continue;
      const jx = tex ? 0.35 + hash2(tile * 2 + k, 96) * 0.3 : 0.1 + hash2(tile * 2 + k, 96) * 0.8;
      const jz = tex ? 0.35 + hash2(tile * 2 + k, 97) * 0.3 : 0.1 + hash2(tile * 2 + k, 97) * 0.8;
      const s = tex ? 0.4 + hash2(tile + k, 98) * 0.3 : 0.55 + hash2(tile + k, 98) * 0.75;
      this.#put(
        this.#rockName(tile * 2 + k + 7),
        tile,
        tx + jx,
        this.#heights.at(tx + jx, ty + jz) + (tex ? -0.03 : 0.14 * s),
        ty + jz,
        tex ? s : s * 0.6 * (1 + hash2(tile + k, 99) * 0.5),
        s,
        hash2(tile + k, 100) * Math.PI * 2,
        tex ? 0xffffff : palette.rock,
        (tex ? 0.15 : 0.3) + hash2(tile + k, 101) * (tex ? 0.15 : 0.5),
        palette.rockDark,
      );
    }
  }

  #placeOre(tile: number, res: number, interior = false): void {
    const tx = tileX(tile);
    const ty = tileY(tile);
    const tex = this.#rockSpecies > 0;
    const color =
      res === TileResource.IronDep
        ? tex
          ? 0x9a5f42 // brighter over the texture so the metal reads
          : palette.ironOre
        : res === TileResource.SilverDep
          ? tex
            ? 0xdbe4ee
            : palette.silverOre
          : tex
            ? 0xf0bc42
            : palette.goldOre;
    for (let k = 0; k < 4; k++) {
      const spread = interior ? 0.6 : 0.4;
      const jx = tex
        ? 0.5 - spread / 2 + hash2(tile * 4 + k, 31) * spread
        : 0.15 + hash2(tile * 4 + k, 31) * 0.7;
      const jz = tex
        ? 0.5 - spread / 2 + hash2(tile * 4 + k, 32) * spread
        : 0.15 + hash2(tile * 4 + k, 32) * 0.7;
      const s = tex
        ? (interior ? 0.4 : 0.26) + hash2(tile * 4 + k, 33) * 0.2
        : 0.5 + hash2(tile * 4 + k, 33) * 0.8;
      this.#put(
        tex ? this.#rockName(tile * 4 + k + 29) : 'ore',
        tile,
        tx + jx,
        this.#heights.at(tx + jx, ty + jz) + (tex ? -0.01 : 0.08 * s),
        ty + jz,
        s,
        s,
        hash2(tile * 4 + k, 34) * Math.PI,
        color,
        tex ? 0.1 : hash2(tile * 4 + k, 35) * 0.25,
        palette.rockDark,
      );
    }
  }
}
