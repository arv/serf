import * as THREE from 'three';
import { MAP_SIZE, TILE_COUNT, tileIdx } from '../shared/grid';
import { hash2 } from '../shared/math';
import { PathLevel, Terrain, TileResource, type MapView } from '../sim/map';
import { palette } from './palette';
import { makeGroundTexture } from './groundTexture';
import type { HeightField } from './heightField';

/** Sub-tile vertices per tile edge: painting resolution beneath the grid. */
const SEG = 3;
const GRID = MAP_SIZE * SEG;

/** Smooth value noise in [0,1] over world coords. */
function vnoise(seed: number, x: number, y: number, scale: number): number {
  const fx = x / scale;
  const fy = y / scale;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const h = (cx: number, cy: number): number => hash2(seed + cx * 149, seed * 11 + cy * 331);
  const a = h(x0, y0);
  const b = h(x0 + 1, y0);
  const c = h(x0, y0 + 1);
  const d = h(x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

// Tile paint classes (per-tile pass output, consumed by the vertex pass).
const CLASS_GRASS = 0;
const CLASS_WATER = 1;
const CLASS_TRAIL = 2;
const CLASS_ROAD = 3;

/**
 * The ground: one high-resolution mesh painted like a stylized RTS map.
 * Macro layer: per-tile classes (grass, water, trails, roads) sampled through
 * a noise-warped lookup so boundaries wander organically. Meso layer: meadow
 * noise blends lush -> olive -> sun-dried gold patches; banks darken into
 * moss, ground near buildings is trampled to earth. Micro layer: a generated
 * blade-speckle detail texture multiplied over everything.
 */
export class TerrainMesh {
  readonly mesh: THREE.Mesh;
  #colorAttr: THREE.BufferAttribute;
  #geometry: THREE.PlaneGeometry;
  #map: MapView;
  #heights: HeightField;

  // Static per-vertex fields, computed once.
  #warpX: Float32Array;
  #warpZ: Float32Array;
  #meadow: Float32Array;
  #speck: Float32Array;
  #vertY: Float32Array;

  // Per-tile scratch, refilled on every repaint.
  #tileClass = new Uint8Array(TILE_COUNT);
  #tileEarth = new Float32Array(TILE_COUNT);
  #tileDeposit = new Int8Array(TILE_COUNT);

  constructor(map: MapView, heights: HeightField) {
    this.#map = map;
    this.#heights = heights;
    this.#geometry = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, GRID, GRID);
    this.#geometry.rotateX(-Math.PI / 2);
    this.#geometry.translate(MAP_SIZE / 2, 0, MAP_SIZE / 2);

    const pos = this.#geometry.attributes.position!;
    const count = pos.count;
    this.#colorAttr = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    this.#geometry.setAttribute('color', this.#colorAttr);

    this.#warpX = new Float32Array(count);
    this.#warpZ = new Float32Array(count);
    this.#meadow = new Float32Array(count);
    this.#speck = new Float32Array(count);
    this.#vertY = new Float32Array(count);

    for (let v = 0; v < count; v++) {
      const x = pos.getX(v);
      const z = pos.getZ(v);
      const y = this.#heights.at(x, z);
      pos.setY(v, y);
      this.#vertY[v] = y;
      // Boundary warp: where class edges wander (trails, shores, dirt).
      this.#warpX[v] = (vnoise(41, x, z, 2.1) - 0.5) * 1.1;
      this.#warpZ[v] = (vnoise(43, x, z, 2.1) - 0.5) * 1.1;
      // Meadow patches at three scales.
      this.#meadow[v] =
        vnoise(51, x, z, 9) * 0.5 + vnoise(53, x, z, 3.4) * 0.34 + vnoise(57, x, z, 1.2) * 0.16;
      this.#speck[v] = 0.92 + hash2(v, 977) * 0.16;
    }
    this.#geometry.computeVertexNormals();

    this.repaintAll();

    const material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      map: makeGroundTexture(),
    });
    this.mesh = new THREE.Mesh(this.#geometry, material);
    this.mesh.receiveShadow = true;
  }

  /** Recolor every vertex from current map state. */
  repaintAll(): void {
    const map = this.#map;

    // --- Per-tile pass: classify + trampled-earth mask -----------------------
    for (let i = 0; i < TILE_COUNT; i++) {
      const level = map.pathLevel[i];
      this.#tileClass[i] =
        map.terrain[i] === Terrain.Water
          ? CLASS_WATER
          : level === PathLevel.Road
            ? CLASS_ROAD
            : level === PathLevel.Trail
              ? CLASS_TRAIL
              : CLASS_GRASS;
      const res = map.resource[i];
      this.#tileDeposit[i] =
        res === TileResource.IronDep
          ? 1
          : res === TileResource.SilverDep
            ? 2
            : res === TileResource.GoldDep
              ? 3
              : 0;
      this.#tileEarth[i] = map.buildingAt[i]! >= 0 ? 1 : 0;
    }
    // Feather trampled earth one tile outward.
    for (let y = 0; y < MAP_SIZE; y++) {
      for (let x = 0; x < MAP_SIZE; x++) {
        const i = tileIdx(x, y);
        if (this.#tileEarth[i] === 1) continue;
        let near = 0;
        for (let dy = -1; dy <= 1 && !near; dy++) {
          for (let dx = -1; dx <= 1 && !near; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= MAP_SIZE || ny >= MAP_SIZE) continue;
            if (this.#map.buildingAt[tileIdx(nx, ny)]! >= 0) near = 1;
          }
        }
        if (near) this.#tileEarth[i] = 0.55;
      }
    }

    // --- Per-vertex pass -----------------------------------------------------
    const pos = this.#geometry.attributes.position!;
    const lush = new THREE.Color(palette.grassLush);
    const olive = new THREE.Color(palette.grassOlive);
    const gold = new THREE.Color(palette.grassGold);
    const earth = new THREE.Color(palette.trampledEarth);
    const moss = new THREE.Color(palette.bankMoss);
    const bed = new THREE.Color(palette.riverbed);
    const trail = new THREE.Color(palette.earthTrail);
    const road = new THREE.Color(palette.stoneRoad);
    const water = new THREE.Color(palette.water);
    const iron = new THREE.Color(palette.ironOre);
    const silver = new THREE.Color(palette.silverOre);
    const goldOre = new THREE.Color(palette.goldOre);
    const rock = new THREE.Color(palette.rock);
    const rockDark = new THREE.Color(palette.rockDark);
    const snow = new THREE.Color(palette.peakSnow);
    const c = new THREE.Color();

    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v);
      const z = pos.getZ(v);
      // Warped tile lookup: organic macro boundaries.
      const tx = Math.max(0, Math.min(MAP_SIZE - 1, Math.floor(x + this.#warpX[v]!)));
      const tz = Math.max(0, Math.min(MAP_SIZE - 1, Math.floor(z + this.#warpZ[v]!)));
      const tile = tileIdx(tx, tz);
      const cls = this.#tileClass[tile];
      const y = this.#vertY[v]!;

      if (cls === CLASS_WATER) {
        c.copy(bed).lerp(water, Math.min(Math.max((-y - 0.2) * 1.4, 0), 1) * 0.75);
      } else if (cls === CLASS_ROAD) {
        c.copy(road);
      } else if (cls === CLASS_TRAIL) {
        c.copy(trail).lerp(earth, 0.3);
      } else {
        // Meadow: lush -> olive -> sun-dried gold.
        const m = this.#meadow[v]!;
        if (m < 0.52) c.copy(lush).lerp(olive, m / 0.52);
        else c.copy(olive).lerp(gold, (m - 0.52) / 0.48);
        // Altitude: meadow dries into bare rock, and the peaks catch snow.
        if (y > 0.9) {
          const rocky = Math.min((y - 0.9) / 0.55, 1);
          c.lerp(m < 0.5 ? rock : rockDark, rocky * 0.9);
          if (y > 1.95) c.lerp(snow, Math.min((y - 1.95) / 0.45, 1) * 0.85);
        }
        // Trampled ground near buildings.
        const e = this.#tileEarth[tile]!;
        if (e > 0) c.lerp(earth, e * 0.7);
        // Deposits tint the rocky ground.
        const dep = this.#tileDeposit[tile];
        if (dep === 1) c.lerp(iron, 0.5);
        else if (dep === 2) c.lerp(silver, 0.45);
        else if (dep === 3) c.lerp(goldOre, 0.45);
      }

      // Banks sink into dark moss; anything below the waterline goes murky.
      if (y < 0.5 && cls !== CLASS_ROAD) {
        const wet = Math.min((0.5 - y) / 1.1, 0.8);
        c.lerp(moss, wet);
      }

      const s = this.#speck[v]!;
      this.#colorAttr.setXYZ(v, c.r * s, c.g * s, c.b * s);
    }
    this.#colorAttr.needsUpdate = true;
  }
}
