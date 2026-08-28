import * as THREE from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {tileCount, tileX, tileY} from '../shared/grid';
import {hash2} from '../shared/math';
import {WATER_LEVEL, playEdgeDist, type MapView} from '../sim/map';
import * as Terrain from '../sim/terrainEnum.ts';
import * as TileResource from '../sim/tileResourceEnum.ts';
import {glbDoodads, glbForest, glbRocks, glbTrees} from './assets';
import type {HeightField} from './heightField';
import {goldOre, ironOre, rock, rockDark, silverOre} from './palette';
import {
  foliageMaterial,
  makeBushSprite,
  makeFlowerSprite,
  makeStalkTexture,
  makeLeafSprite,
} from './spriteTextures';

/**
 * Two quads crossed at 90°, each doubled back-to-back — the classic
 * alpha-tested foliage carrier. Both facings are front faces (no DoubleSide,
 * so two-sided lighting can't flip normals into shadow), and every normal
 * points straight up so the cards take the same light as the ground.
 */
export function crossedQuads(
  width: number,
  height: number,
): THREE.BufferGeometry {
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
  const size = map.size;
  const x = tileX(idx, size);
  const y = tileY(idx, size);
  for (const [nx, ny] of [
    [x - 1, y],
    [x + 1, y],
    [x, y - 1],
    [x, y + 1],
  ] as const) {
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
    if (map.terrain[ny * size + nx] === Terrain.Water) return true;
  }
  return false;
}

/** Does a standing grove border this tile? (Where the scrub gathers.) */
function touchesWood(map: MapView, idx: number): boolean {
  const size = map.size;
  const x = tileX(idx, size);
  const y = tileY(idx, size);
  for (const [nx, ny] of [
    [x - 1, y],
    [x + 1, y],
    [x, y - 1],
    [x, y + 1],
  ] as const) {
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
    if (map.resource[ny * size + nx] === TileResource.Wood) return true;
  }
  return false;
}

/** Is this water tile against a grassy bank? (Where the reeds stand.) */
function touchesGrass(map: MapView, idx: number): boolean {
  const size = map.size;
  const x = tileX(idx, size);
  const y = tileY(idx, size);
  for (const [nx, ny] of [
    [x - 1, y],
    [x + 1, y],
    [x, y - 1],
    [x, y + 1],
  ] as const) {
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
    if (map.terrain[ny * size + nx] === Terrain.Grass) return true;
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
 * All standing scatter (tree stands, boulders, ore markers) as a handful of
 * InstancedMeshes. Depletion hides a tile's instances by zeroing their
 * matrices — counts are fixed at worldgen.
 */
export class ScatterMesh {
  readonly group = new THREE.Group();
  #archetypes = new Map<string, Archetype>();
  #heights: HeightField;
  #map: MapView;
  #size: number;
  #trees = false;
  #treeSpecies = 0;
  #rockSpecies = 0;
  #doodads = false;
  #forest = false;
  #bushSpecies = 0;
  #deadSpecies = 0;

  /**
   * Does scatter on this tile pay for the shadow pass? The playable field
   * and the first margin rows do — their shadows land where the player
   * looks. The deep margin's timber is thousands of instances of pure
   * horizon; skipping their shadow pass is what makes drawing the whole
   * ring affordable.
   */
  #nearShadow(tile: number): boolean {
    return (
      playEdgeDist(
        this.#map,
        tileX(tile, this.#size),
        tileY(tile, this.#size),
      ) >= -8
    );
  }

  /** Rock archetype for a seed — a KayKit variant, or the one procedural. */
  #rockName(seed: number): string {
    if (this.#rockSpecies === 0) return 'rock';
    const i = (hash2(seed, 41) * this.#rockSpecies) | 0;
    return i === 0 ? 'rock' : `rock${i}`;
  }

  constructor(map: MapView, heights: HeightField) {
    this.#heights = heights;
    this.#map = map;
    this.#size = map.size;
    const tiles = tileCount(map.size);
    // Count instances per archetype first (instanced meshes need fixed capacity).
    let groveTiles = 0;
    let farGroveTiles = 0;
    let rockTiles = 0;
    let oreTiles = 0;
    const shoreTiles: number[] = [];
    // Border-ridge dressing: boulders strewn over the rim rock, thinned by
    // hash so the range reads craggy rather than tiled — and thinned much
    // harder in the deep margin, where whole ranges are rock.
    const ridgeTiles: number[] = [];
    // Natural doodads, all derived from the tiles (nothing to author or
    // save): lily pads drifting on open shallows, reed clumps against the
    // banks, stray pebbles in the meadows, scrub bushes thickening the
    // forest fringes, wildflowers on the lush ground.
    const lilyTiles: number[] = [];
    const reedTiles: number[] = [];
    const pebbleTiles: number[] = [];
    const bushTiles: number[] = [];
    const flowerTiles: number[] = [];
    const deadTreeTiles: number[] = [];
    for (let i = 0; i < tiles; i++) {
      const res = map.resource[i];
      if (res === TileResource.Wood) {
        if (this.#nearShadow(i)) groveTiles++;
        else farGroveTiles++;
      } else if (res === TileResource.Rock) rockTiles++;
      else if (res !== TileResource.None) oreTiles++;
      // Rocky banks: grass tiles touching water, thinned by hash.
      if (
        map.terrain[i] === Terrain.Grass &&
        hash2(i, 91) < 0.45 &&
        touchesWater(map, i)
      ) {
        shoreTiles.push(i);
      } else if (
        map.terrain[i] === Terrain.Grass &&
        res === TileResource.None &&
        map.pathLevel[i] === 0
      ) {
        if (hash2(i, 427) < 0.05) pebbleTiles.push(i);
        // Scrub gathers where the woods thin out (a grove next door) and
        // strays sparsely across the open meadow.
        else if (hash2(i, 461) < (touchesWood(map, i) ? 0.28 : 0.02))
          bushTiles.push(i);
        // A bare trunk here and there on the dry high ground, and the odd
        // snag standing at a treeline. Rare on purpose: one is scenery,
        // a field of them is a graveyard.
        else if (
          hash2(i, 491) <
          (map.height[i]! > 0.75 ? 0.012 : touchesWood(map, i) ? 0.02 : 0.002)
        ) {
          deadTreeTiles.push(i);
        } else if (map.height[i]! < 1.0 && hash2(i, 463) < 0.06)
          flowerTiles.push(i);
      }
      if (
        map.terrain[i] === Terrain.Rock &&
        hash2(i, 93) < (this.#nearShadow(i) ? 0.3 : 0.12)
      ) {
        ridgeTiles.push(i);
      }
      if (map.terrain[i] === Terrain.Water) {
        const bed = map.height[i]!;
        if (touchesGrass(map, i)) {
          if (bed > -0.95 && hash2(i, 421) < 0.35) reedTiles.push(i);
        } else if (bed > -0.8 && hash2(i, 422) < 0.08) {
          lilyTiles.push(i);
        }
      }
    }

    const lambert = (color: number) => new THREE.MeshLambertMaterial({color});
    const flat = (color: number) =>
      new THREE.MeshStandardMaterial({
        color,
        flatShading: true,
        roughness: 0.95,
      });

    // Groves: a mixed wood of GLB tree species when the pack loaded;
    // otherwise tall whip-thin procedural stalks (5 per tile) wearing a
    // painted node-ring texture with alpha-tested leaf sprites.
    const trees = glbTrees();
    this.#trees = trees !== null;
    this.#treeSpecies = trees?.geometries.length ?? 0;
    if (trees) {
      trees.geometries.forEach((geo, i) => {
        this.#addArchetype(
          `tree${i}`,
          geo,
          trees.material,
          groveTiles * TREES_PER_TILE,
          {
            receiveShadow: false,
          },
        );
        // The horizon's stands: identical geometry, no shadow pass.
        this.#addArchetype(
          `treeFar${i}`,
          geo,
          trees.material,
          farGroveTiles * TREES_PER_TILE,
          {
            castShadow: false,
            receiveShadow: false,
          },
        );
      });
    } else {
      const culmTexture = makeStalkTexture();
      culmTexture.wrapS = THREE.RepeatWrapping;
      culmTexture.wrapT = THREE.RepeatWrapping;
      culmTexture.repeat.set(1, 2.5);
      this.#addArchetype(
        'culm',
        new THREE.CylinderGeometry(0.03, 0.045, 1, 6),
        new THREE.MeshLambertMaterial({map: culmTexture}),
        groveTiles * CULMS_PER_TILE,
        {receiveShadow: false}, // dense groves would shadow-spam themselves
      );
      this.#addArchetype(
        'spray',
        crossedQuads(1.5, 1.1),
        foliageMaterial(makeLeafSprite()),
        groveTiles * CULMS_PER_TILE * 3,
        {castShadow: false, receiveShadow: false},
      );
    }
    // Rocks: KayKit boulder variants when the pack loaded (ore deposits
    // become metal-tinted boulders too), procedural dodecahedra + crystal
    // octahedra otherwise.
    const rocks = glbRocks();
    this.#rockSpecies = rocks?.geometries.length ?? 0;
    if (rocks) {
      rocks.geometries.forEach((geo, i) => {
        this.#addArchetype(
          i === 0 ? 'rock' : `rock${i}`,
          geo,
          rocks.material,
          rockTiles * 2 +
            shoreTiles.length * 2 +
            ridgeTiles.length * 2 +
            oreTiles * 4 +
            pebbleTiles.length * 2,
        );
      });
    } else {
      this.#addArchetype(
        'rock',
        new THREE.DodecahedronGeometry(0.32),
        flat(0xffffff),
        rockTiles * 2 +
          shoreTiles.length * 2 +
          ridgeTiles.length * 2 +
          pebbleTiles.length * 2,
      );
      this.#addArchetype(
        'ore',
        new THREE.OctahedronGeometry(0.16),
        flat(0xffffff),
        oreTiles * 4,
      );
    }
    // Water doodads ride the same palette texture; no shadow pass — a lily
    // pad's shadow lands on water that doesn't receive it anyway.
    const doodads = glbDoodads();
    this.#doodads = doodads !== null;
    if (doodads) {
      this.#addArchetype(
        'lily',
        doodads.lily,
        doodads.material,
        lilyTiles.length * 2,
        {
          castShadow: false,
          receiveShadow: false,
        },
      );
      this.#addArchetype(
        'reed',
        doodads.reed,
        doodads.material,
        reedTiles.length * 2,
        {
          castShadow: false,
          receiveShadow: false,
        },
      );
    }
    // Scrub and deadfall: the forest pack's own models when it loaded,
    // painted crossed quads otherwise. (Squashing a live tree to shrub
    // height was the first idea and looked it — flattening the trunk with
    // the canopy reads as a stepped-on tree, not a bush.)
    const forest = glbForest();
    this.#forest = forest !== null;
    this.#bushSpecies = forest?.bushes.length ?? 0;
    this.#deadSpecies = forest?.deadTrees.length ?? 0;
    if (forest) {
      forest.bushes.forEach((geo, i) => {
        this.#addArchetype(
          `bush${i}`,
          geo,
          forest.material,
          bushTiles.length * 2,
          {
            receiveShadow: false,
          },
        );
      });
      forest.deadTrees.forEach((geo, i) => {
        this.#addArchetype(
          `dead${i}`,
          geo,
          forest.material,
          deadTreeTiles.length,
          {
            receiveShadow: false,
          },
        );
      });
    } else {
      this.#addArchetype(
        'bush',
        crossedQuads(1.05, 0.8),
        foliageMaterial(makeBushSprite()),
        bushTiles.length * 2,
        {receiveShadow: false},
      );
    }
    this.#addArchetype(
      'flower',
      crossedQuads(0.5, 0.4),
      foliageMaterial(makeFlowerSprite()),
      flowerTiles.length * 2,
      {castShadow: false, receiveShadow: true},
    );

    for (let i = 0; i < tiles; i++) {
      const res = map.resource[i];
      // A resource tile with all its neighbors blocked sits in the middle
      // of a formation: nothing walks there, so its rocks may sprawl big.
      // Edge tiles keep their rocks contained — a miner stands next door.
      const interior = ((): boolean => {
        const size = map.size;
        const x = tileX(i, size);
        const y = tileY(i, size);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
            if (map.blocked[ny * size + nx] === 0) return false;
          }
        }
        return true;
      })();
      if (res === TileResource.Wood) this.#placeGrove(i);
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
    for (const i of ridgeTiles) {
      this.#placeShoreRocks(i); // same craggy dressing, on the rim rock
      this.#cosmetic.add(i);
    }
    for (const i of pebbleTiles) {
      this.#placePebbles(i);
      this.#cosmetic.add(i);
    }
    for (const i of bushTiles) {
      this.#placeBushes(i);
      this.#cosmetic.add(i);
    }
    if (this.#forest) {
      for (const i of deadTreeTiles) {
        this.#placeDeadTree(i);
        this.#cosmetic.add(i);
      }
    }
    for (const i of flowerTiles) {
      this.#placeFlowers(i);
      this.#cosmetic.add(i);
    }
    if (this.#doodads) {
      for (const i of lilyTiles) {
        this.#placeLilies(i);
        this.#cosmetic.add(i);
      }
      for (const i of reedTiles) {
        this.#placeReeds(i);
        this.#cosmetic.add(i);
      }
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
  resyncAll(map: {resource: Uint8Array; buildingAt: Int16Array}): void {
    for (const a of this.#archetypes.values()) {
      for (const tile of [...a.byTile.keys()]) {
        if (this.#cosmetic.has(tile)) continue;
        if (
          map.resource[tile] === TileResource.None ||
          map.buildingAt[tile]! >= 0
        ) {
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
    opts?: {castShadow?: boolean; receiveShadow?: boolean},
  ): void {
    const mesh = new THREE.InstancedMesh(
      geometry,
      material,
      Math.max(capacity, 1),
    );
    mesh.castShadow = opts?.castShadow ?? true;
    mesh.receiveShadow = opts?.receiveShadow ?? true;
    mesh.count = 0;
    this.group.add(mesh);
    this.#archetypes.set(name, {mesh, byTile: new Map(), cursor: 0});
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

  #placeGrove(tile: number): void {
    const tx = tileX(tile, this.#size);
    const ty = tileY(tile, this.#size);
    if (this.#trees) {
      // A mixed stand: two trees per tile, species/size/lean/tint all
      // hash-varied so no two copses repeat.
      const far = this.#nearShadow(tile) ? '' : 'Far';
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
          `tree${far}${species}`,
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
      // Stalks bunch toward the tile center like a real grove clump.
      const jx = 0.28 + hash2(seed, 1) * 0.44;
      const jz = 0.28 + hash2(seed, 2) * 0.44;
      const h = 2.3 + hash2(seed, 3) * 1.3;
      const x = tx + jx;
      const z = ty + jz;
      const ground = this.#heights.at(x, z);
      // Whole-stalk lean: offset the top by shifting via z-rotation.
      const lean = (hash2(seed, 4) - 0.5) * 0.22;
      // Stalk tint rides on the painted node texture: young jade -> older gold.
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
      // 2-3 painted leaf sprays around the upper third of the stalk.
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
    const tx = tileX(tile, this.#size);
    const ty = tileY(tile, this.#size);
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
        tex ? 0xffffff : rock,
        hash2(tile + k, 26) * (tex ? 0.25 : 0.6),
        rockDark,
      );
    }
  }

  /** Scrub: a leafy clump, sized between grass and a young tree. */
  #placeBushes(tile: number): void {
    const tx = tileX(tile, this.#size);
    const ty = tileY(tile, this.#size);
    const modeled = this.#forest;
    for (let k = 0; k < 2; k++) {
      if (k === 1 && hash2(tile, 465) < 0.55) continue;
      const jx = 0.2 + hash2(tile * 2 + k, 467) * 0.6;
      const jz = 0.2 + hash2(tile * 2 + k, 468) * 0.6;
      // The models are span-normalized (a unit footprint), so this is how
      // much of a tile a shrub covers — well under half, or it reads as a
      // hedge. The sprite is sized by its own height instead.
      const s = modeled
        ? 0.34 + hash2(tile + k, 469) * 0.24
        : 0.62 + hash2(tile + k, 469) * 0.5;
      const warm = hash2(tile + k, 470);
      const species = (hash2(tile * 2 + k, 466) * this.#bushSpecies) | 0;
      this.#put(
        modeled ? `bush${species}` : 'bush',
        tile,
        tx + jx,
        // A model's feet are its origin; the sprite is centered, so it
        // lifts half its height to stand ON the ground, not sunk in it.
        this.#heights.at(tx + jx, ty + jz) + (modeled ? -0.02 : 0.4 * s),
        ty + jz,
        modeled ? s * (0.9 + hash2(tile + k, 473) * 0.4) : s,
        s,
        hash2(tile + k, 472) * Math.PI * (modeled ? 2 : 1),
        0xffffff,
        // The forest pack's foliage is a bright lime against this game's
        // deeper woodland greens, so the models are pulled well down
        // toward the valley's own palette; the odd shrub turns dusty.
        modeled
          ? warm > 0.88
            ? 0.6
            : 0.45 + warm * 0.25
          : warm > 0.86
            ? 0.3
            : warm * 0.18,
        modeled && warm > 0.88 ? 0xa89a5e : modeled ? 0x4f7a34 : 0x86a860,
      );
    }
  }

  /** A bare trunk: dry-ground scenery, one per tile, never in a stand. */
  #placeDeadTree(tile: number): void {
    const tx = tileX(tile, this.#size);
    const ty = tileY(tile, this.#size);
    const species = (hash2(tile, 492) * this.#deadSpecies) | 0;
    const jx = 0.3 + hash2(tile, 493) * 0.4;
    const jz = 0.3 + hash2(tile, 494) * 0.4;
    const h = 1.3 + hash2(tile, 495) * 0.9;
    this.#put(
      `dead${species}`,
      tile,
      tx + jx,
      this.#heights.at(tx + jx, ty + jz),
      ty + jz,
      h,
      h * (0.75 + hash2(tile, 496) * 0.3),
      hash2(tile, 497) * Math.PI * 2,
      0xffffff,
      // Instance color multiplies the palette, so it can darken bark but
      // never desaturate it: the pack's bare wood is a hot orange, and
      // only a heavy, cool multiply brings it down to weathered timber.
      0.7 + hash2(tile, 498) * 0.2,
      0x655e50,
      (hash2(tile, 499) - 0.5) * 0.09,
    );
  }

  /** Wildflower clumps on the lush meadow, tinted bloom by bloom. */
  #placeFlowers(tile: number): void {
    const tx = tileX(tile, this.#size);
    const ty = tileY(tile, this.#size);
    for (let k = 0; k < 2; k++) {
      if (k === 1 && hash2(tile, 475) < 0.5) continue;
      const jx = 0.15 + hash2(tile * 2 + k, 476) * 0.7;
      const jz = 0.15 + hash2(tile * 2 + k, 477) * 0.7;
      const s = 0.7 + hash2(tile + k, 478) * 0.5;
      this.#put(
        'flower',
        tile,
        tx + jx,
        this.#heights.at(tx + jx, ty + jz) + 0.18 * s,
        ty + jz,
        s,
        s,
        hash2(tile + k, 479) * Math.PI,
        0xffffff,
        hash2(tile + k, 480) * 0.25,
        0xf0e0b0,
      );
    }
  }

  /** A stray pebble or two in the open meadow — ground texture, not stone
   * worth quarrying, so they stay well under boulder scale. */
  #placePebbles(tile: number): void {
    const tx = tileX(tile, this.#size);
    const ty = tileY(tile, this.#size);
    const tex = this.#rockSpecies > 0;
    for (let k = 0; k < 2; k++) {
      if (k === 1 && hash2(tile, 431) < 0.6) continue;
      const jx = 0.15 + hash2(tile * 2 + k, 432) * 0.7;
      const jz = 0.15 + hash2(tile * 2 + k, 433) * 0.7;
      const s = tex
        ? 0.09 + hash2(tile + k, 434) * 0.08
        : 0.18 + hash2(tile + k, 434) * 0.14;
      this.#put(
        this.#rockName(tile * 2 + k + 13),
        tile,
        tx + jx,
        this.#heights.at(tx + jx, ty + jz) + (tex ? -0.005 : 0.03 * s),
        ty + jz,
        tex ? s : s * 0.6,
        s,
        hash2(tile + k, 435) * Math.PI * 2,
        tex ? 0xffffff : rock,
        0.2 + hash2(tile + k, 436) * 0.3,
        rockDark,
      );
    }
  }

  /** Lily pads drifting on still, open shallows, at the water surface. */
  #placeLilies(tile: number): void {
    const tx = tileX(tile, this.#size);
    const ty = tileY(tile, this.#size);
    for (let k = 0; k < 2; k++) {
      if (k === 1 && hash2(tile, 441) < 0.45) continue;
      const jx = 0.15 + hash2(tile * 2 + k, 442) * 0.7;
      const jz = 0.15 + hash2(tile * 2 + k, 443) * 0.7;
      const s = 0.3 + hash2(tile + k, 444) * 0.22;
      this.#put(
        'lily',
        tile,
        tx + jx,
        WATER_LEVEL + 0.015,
        ty + jz,
        s,
        s,
        hash2(tile + k, 445) * Math.PI * 2,
        0xffffff,
        hash2(tile + k, 446) * 0.25,
        0x9fd0a0,
      );
    }
  }

  /** Reed clumps rooted on the bank's shallow bed, breaching the surface. */
  #placeReeds(tile: number): void {
    const tx = tileX(tile, this.#size);
    const ty = tileY(tile, this.#size);
    for (let k = 0; k < 2; k++) {
      if (k === 1 && hash2(tile, 451) < 0.4) continue;
      const jx = 0.2 + hash2(tile * 2 + k, 452) * 0.6;
      const jz = 0.2 + hash2(tile * 2 + k, 453) * 0.6;
      const bed = this.#heights.at(tx + jx, ty + jz);
      // A clump must reach the air; the deepest beds keep open water.
      const h = 0.75 + hash2(tile + k, 454) * 0.4;
      if (bed + h < WATER_LEVEL + 0.25) continue;
      this.#put(
        'reed',
        tile,
        tx + jx,
        bed,
        ty + jz,
        h,
        0.55 + hash2(tile + k, 455) * 0.3,
        hash2(tile + k, 456) * Math.PI * 2,
        0xffffff,
        hash2(tile + k, 457) * 0.35,
        0xd8c878,
      );
    }
  }

  /** Boulders spilling down the bank toward the water. */
  #placeShoreRocks(tile: number): void {
    const tx = tileX(tile, this.#size);
    const ty = tileY(tile, this.#size);
    const tex = this.#rockSpecies > 0;
    for (let k = 0; k < 2; k++) {
      if (k === 1 && hash2(tile, 95) < 0.5) continue;
      const jx = tex
        ? 0.35 + hash2(tile * 2 + k, 96) * 0.3
        : 0.1 + hash2(tile * 2 + k, 96) * 0.8;
      const jz = tex
        ? 0.35 + hash2(tile * 2 + k, 97) * 0.3
        : 0.1 + hash2(tile * 2 + k, 97) * 0.8;
      const s = tex
        ? 0.4 + hash2(tile + k, 98) * 0.3
        : 0.55 + hash2(tile + k, 98) * 0.75;
      this.#put(
        this.#rockName(tile * 2 + k + 7),
        tile,
        tx + jx,
        this.#heights.at(tx + jx, ty + jz) + (tex ? -0.03 : 0.14 * s),
        ty + jz,
        tex ? s : s * 0.6 * (1 + hash2(tile + k, 99) * 0.5),
        s,
        hash2(tile + k, 100) * Math.PI * 2,
        tex ? 0xffffff : rock,
        (tex ? 0.15 : 0.3) + hash2(tile + k, 101) * (tex ? 0.15 : 0.5),
        rockDark,
      );
    }
  }

  #placeOre(tile: number, res: number, interior = false): void {
    const tx = tileX(tile, this.#size);
    const ty = tileY(tile, this.#size);
    const tex = this.#rockSpecies > 0;
    const color =
      res === TileResource.IronDep
        ? tex
          ? 0x9a5f42 // brighter over the texture so the metal reads
          : ironOre
        : res === TileResource.SilverDep
          ? tex
            ? 0xdbe4ee
            : silverOre
          : tex
            ? 0xf0bc42
            : goldOre;
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
        rockDark,
      );
    }
  }
}
