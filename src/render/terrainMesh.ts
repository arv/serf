import * as THREE from 'three';
import { tileCount, tileIdx, tileX, tileY } from '../shared/grid';
import { hash2 } from '../shared/math';
import { Terrain, TileResource, playMin, playMax, type MapView } from '../sim/map';
import {
  bankMoss,
  earthTrail,
  goldOre,
  grassGold,
  grassLush,
  grassOlive,
  ironOre,
  peakSnow,
  riverbed,
  rock,
  rockDark,
  silverOre,
  stoneRoad,
  trampledEarth,
  water,
} from './palette';
import { makeGroundTexture } from './groundTexture';
import { vnoise } from './noise';
import {
  ROAD_HALF,
  TRAIL_HALF,
  newRibbonDist,
  ribbonDistances,
  ribbonStrength,
  ribbonWarpX,
  ribbonWarpZ,
  ribbonWidth,
} from './pathRibbon';
import type { HeightField } from './heightField';

/**
 * Sub-tile vertices per tile edge: painting resolution beneath the grid. Set
 * by the narrowest thing painted here — a trail ribbon is about 0.6 tiles
 * wide with a soft edge, and below ~6 steps per tile its shoulders turn into
 * visible staircases.
 */
const SEG = 6;

// Tile paint classes (per-tile pass output, consumed by the vertex pass).
const CLASS_GRASS = 0;
const CLASS_WATER = 1;
const CLASS_ROCK = 2;

/**
 * The ground: one high-resolution mesh painted like a stylized RTS map.
 * Macro layer: per-tile classes (grass, water) sampled through a noise-warped
 * lookup so shorelines wander organically. Meso layer: meadow noise blends
 * lush -> olive -> sun-dried gold patches; banks darken into moss, ground
 * near buildings is trampled to earth. Trails and roads ride on top as
 * ribbons threaded between neighboring path tiles (see pathRibbon), not as
 * filled squares. Micro layer: a generated blade-speckle detail texture
 * multiplied over everything.
 */
export class TerrainMesh {
  readonly mesh: THREE.Mesh;
  #colorAttr: THREE.BufferAttribute;
  #geometry: THREE.PlaneGeometry;
  #map: MapView;
  #heights: HeightField;
  #size: number;
  /** First playable row/column — the mesh covers the play square only;
   * the coarse margin mesh (marginMesh.ts) carries the scenery ring. */
  #p0: number;
  /** Sub-tile lattice edge: play side * SEG. */
  #grid: number;

  // Static per-vertex fields, computed once.
  #warpX: Float32Array;
  #warpZ: Float32Array;
  #pathWarpX: Float32Array;
  #pathWarpZ: Float32Array;
  #pathWidth: Float32Array;
  #meadow: Float32Array;
  #speck: Float32Array;
  #vertY: Float32Array;

  // Per-tile scratch, refilled on every repaint.
  #tileClass: Uint8Array;
  #tileEarth: Float32Array;
  #tileDeposit: Int8Array;

  constructor(map: MapView, heights: HeightField) {
    this.#map = map;
    this.#heights = heights;
    const size = map.size;
    this.#size = size;
    const p0 = playMin(map);
    this.#p0 = p0;
    const play = map.play;
    this.#grid = play * SEG;
    this.#tileClass = new Uint8Array(tileCount(size));
    this.#tileEarth = new Float32Array(tileCount(size));
    this.#tileDeposit = new Int8Array(tileCount(size));
    this.#geometry = new THREE.PlaneGeometry(play, play, this.#grid, this.#grid);
    this.#geometry.rotateX(-Math.PI / 2);
    this.#geometry.translate(p0 + play / 2, 0, p0 + play / 2);

    const pos = this.#geometry.attributes.position!;
    const count = pos.count;
    this.#colorAttr = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    this.#geometry.setAttribute('color', this.#colorAttr);

    this.#warpX = new Float32Array(count);
    this.#warpZ = new Float32Array(count);
    this.#pathWarpX = new Float32Array(count);
    this.#pathWarpZ = new Float32Array(count);
    this.#pathWidth = new Float32Array(count);
    this.#meadow = new Float32Array(count);
    this.#speck = new Float32Array(count);
    this.#vertY = new Float32Array(count);

    for (let v = 0; v < count; v++) {
      const x = pos.getX(v);
      const z = pos.getZ(v);
      const y = this.#heights.at(x, z);
      pos.setY(v, y);
      this.#vertY[v] = y;
      // Boundary warp: where class edges wander (shores, dirt).
      this.#warpX[v] = (vnoise(41, x, z, 2.1) - 0.5) * 1.1;
      this.#warpZ[v] = (vnoise(43, x, z, 2.1) - 0.5) * 1.1;
      // Paths get their own, much tighter wobble (shared with everything else
      // drawn along them) — cached here because a full repaint touches every
      // vertex and noise is the expensive part.
      this.#pathWarpX[v] = ribbonWarpX(x, z);
      this.#pathWarpZ[v] = ribbonWarpZ(x, z);
      this.#pathWidth[v] = ribbonWidth(x, z);
      // Meadow patches at three scales.
      this.#meadow[v] =
        vnoise(51, x, z, 9) * 0.5 + vnoise(53, x, z, 3.4) * 0.34 + vnoise(57, x, z, 1.2) * 0.16;
      this.#speck[v] = 0.92 + hash2(v, 977) * 0.16;
    }
    this.#geometry.computeVertexNormals();

    this.repaintAll();

    const material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      map: makeGroundTexture(play),
    });
    this.mesh = new THREE.Mesh(this.#geometry, material);
    this.mesh.receiveShadow = true;
  }

  /** Recolor every vertex from current map state. */
  repaintAll(): void {
    // --- Per-tile pass: classify + trampled-earth mask ----------------------
    // One ring past the play square too: the warped boundary lookup samples
    // the first margin tiles, and they must carry real classes.
    const lo = Math.max(0, playMin(this.#map) - 2);
    const hi = Math.min(this.#size, playMax(this.#map) + 2);
    for (let y = lo; y < hi; y++) {
      for (let x = lo; x < hi; x++) this.#recomputeTile(x, y);
    }

    // --- Per-vertex pass -----------------------------------------------------
    const pos = this.#geometry.attributes.position!;
    for (let v = 0; v < pos.count; v++) this.#paintVertex(v);
    // A full range keeps any partial ranges queued earlier in the same frame
    // from downgrading this repaint to a partial upload (three merges ranges).
    this.#colorAttr.clearUpdateRanges();
    this.#colorAttr.addUpdateRange(0, this.#colorAttr.array.length);
    this.#colorAttr.needsUpdate = true;
  }

  /**
   * Recolor only around the given changed tiles. Per-tile fields are
   * recomputed in a 1-tile ring (the trampled-earth feather reaches that
   * far); vertices are repainted in a 2-tile apron (feather, the boundary
   * warp of at most ±0.55 tiles, and the ribbon a new path tile grows into
   * its neighbors), and only the touched spans of the color buffer are
   * re-uploaded.
   */
  repaintTiles(tiles: readonly number[]): void {
    if (tiles.length === 0) return;

    const size = this.#size;
    const grid = this.#grid;
    const dirty = new Set<number>(tiles);
    const recompute = new Set<number>();
    for (const t of dirty) {
      const tx = tileX(t, size);
      const ty = tileY(t, size);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = tx + dx;
          const ny = ty + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          recompute.add(tileIdx(nx, ny, size));
        }
      }
    }
    for (const i of recompute) this.#recomputeTile(tileX(i, size), tileY(i, size));

    // Vertices live on a (grid+1)^2 lattice, SEG per tile edge, row-major —
    // vertex (row, col) sits at world (p0 + col/SEG, p0 + row/SEG).
    const dirtyVerts = new Set<number>();
    for (const t of dirty) {
      const tx = tileX(t, size) - this.#p0;
      const ty = tileY(t, size) - this.#p0;
      const c0 = Math.max(0, (tx - 2) * SEG);
      const c1 = Math.min(grid, (tx + 3) * SEG);
      const r0 = Math.max(0, (ty - 2) * SEG);
      const r1 = Math.min(grid, (ty + 3) * SEG);
      for (let r = r0; r <= r1; r++) {
        const base = r * (grid + 1);
        for (let col = c0; col <= c1; col++) dirtyVerts.add(base + col);
      }
    }
    // A stroke entirely in the scenery margin reaches no play vertex at
    // all — and flagging needsUpdate with no ranges queued would re-upload
    // the whole color buffer for nothing.
    if (dirtyVerts.size === 0) return;
    for (const v of dirtyVerts) this.#paintVertex(v);

    this.#uploadRuns(this.#colorAttr, dirtyVerts);
    this.#colorAttr.needsUpdate = true;
  }

  /**
   * Re-sample vertex heights around the given tiles (the HeightField reads
   * the live map.height, so mutate that first), refresh normals locally,
   * and repaint the same apron — repaintTiles plus elevation. This is the
   * map editor's sculpting path; the game itself never edits heights.
   *
   * Normals come from central differences on the vertex lattice rather
   * than computeVertexNormals: the full pass walks every triangle of a
   * ~590k-vertex mesh, far too slow per brush stamp, and for a smooth
   * heightfield the two estimates agree to well under a shading step.
   * Vertices just outside the apron keep their baked normals; their
   * difference stencils only read heights the edit left untouched, so no
   * seam forms at the boundary.
   */
  reheightTiles(tiles: readonly number[]): void {
    if (tiles.length === 0) return;

    const size = this.#size;
    const grid = this.#grid;
    const dirty = new Set<number>(tiles);
    // The editor's terrain brush moves class and height in one stroke, so
    // refresh the per-tile fields exactly like repaintTiles.
    const recompute = new Set<number>();
    for (const t of dirty) {
      const tx = tileX(t, size);
      const ty = tileY(t, size);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = tx + dx;
          const ny = ty + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          recompute.add(tileIdx(nx, ny, size));
        }
      }
    }
    for (const i of recompute) this.#recomputeTile(tileX(i, size), tileY(i, size));

    // Same play-relative lattice walk as repaintTiles — a dirty margin
    // tile near the boundary still refreshes the play verts its bilinear
    // support reaches, and one fully outside contributes no verts at all.
    const dirtyVerts = new Set<number>();
    for (const t of dirty) {
      const tx = tileX(t, size) - this.#p0;
      const ty = tileY(t, size) - this.#p0;
      const c0 = Math.max(0, (tx - 2) * SEG);
      const c1 = Math.min(grid, (tx + 3) * SEG);
      const r0 = Math.max(0, (ty - 2) * SEG);
      const r1 = Math.min(grid, (ty + 3) * SEG);
      for (let r = r0; r <= r1; r++) {
        const base = r * (grid + 1);
        for (let col = c0; col <= c1; col++) dirtyVerts.add(base + col);
      }
    }
    if (dirtyVerts.size === 0) return;

    const pos = this.#geometry.attributes.position!;
    for (const v of dirtyVerts) {
      const y = this.#heights.at(pos.getX(v), pos.getZ(v));
      pos.setY(v, y);
      this.#vertY[v] = y;
    }

    // Lattice spacing is 1/SEG world units; slopes read off #vertY, which
    // is already fresh for every dirty vertex and still correct beyond.
    const normalAttr = this.#geometry.attributes.normal!;
    const row = grid + 1;
    for (const v of dirtyVerts) {
      const r = (v / row) | 0;
      const c = v % row;
      const cl = Math.max(0, c - 1);
      const cr = Math.min(grid, c + 1);
      const ru = Math.max(0, r - 1);
      const rd = Math.min(grid, r + 1);
      const dydx = ((this.#vertY[r * row + cr]! - this.#vertY[r * row + cl]!) * SEG) / (cr - cl);
      const dydz = ((this.#vertY[rd * row + c]! - this.#vertY[ru * row + c]!) * SEG) / (rd - ru);
      const inv = 1 / Math.sqrt(dydx * dydx + 1 + dydz * dydz);
      normalAttr.setXYZ(v, -dydx * inv, inv, -dydz * inv);
    }

    for (const v of dirtyVerts) this.#paintVertex(v);

    this.#uploadRuns(pos as THREE.BufferAttribute, dirtyVerts);
    this.#uploadRuns(normalAttr as THREE.BufferAttribute, dirtyVerts);
    this.#uploadRuns(this.#colorAttr, dirtyVerts);
    pos.needsUpdate = true;
    normalAttr.needsUpdate = true;
    this.#colorAttr.needsUpdate = true;
  }

  /** Re-derive the culling sphere after sculpting (cheap; call on stroke end). */
  refreshBounds(): void {
    this.#geometry.computeBoundingSphere();
  }

  /**
   * Upload only the touched spans: consecutive vertex runs become ranges
   * (three merges overlapping/adjacent ones before the bufferSubData).
   */
  #uploadRuns(attr: THREE.BufferAttribute, dirtyVerts: Set<number>): void {
    const sorted = [...dirtyVerts].sort((a, z) => a - z);
    if (sorted.length === 0) return; // belt for callers' braces
    let runStart = sorted[0]!;
    let prev = sorted[0]!;
    for (let k = 1; k <= sorted.length; k++) {
      const v = sorted[k];
      if (v === prev + 1) {
        prev = v;
        continue;
      }
      attr.addUpdateRange(runStart * 3, (prev - runStart + 1) * 3);
      if (v === undefined) break;
      runStart = v;
      prev = v;
    }
  }

  /** Refresh one tile's paint class, deposit tint, and trampled-earth mask. */
  #recomputeTile(x: number, y: number): void {
    const map = this.#map;
    const size = this.#size;
    const i = tileIdx(x, y, size);
    this.#tileClass[i] =
      map.terrain[i] === Terrain.Water
        ? CLASS_WATER
        : map.terrain[i] === Terrain.Rock
          ? CLASS_ROCK
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
    if (map.buildingAt[i]! >= 0) {
      this.#tileEarth[i] = 1;
      return;
    }
    // Feather trampled earth one tile outward from building footprints.
    let near = 0;
    for (let dy = -1; dy <= 1 && !near; dy++) {
      for (let dx = -1; dx <= 1 && !near; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        if (map.buildingAt[tileIdx(nx, ny, size)]! >= 0) near = 1;
      }
    }
    this.#tileEarth[i] = near ? 0.55 : 0;
  }

  /** Color one vertex from the current per-tile fields. */
  #paintVertex(v: number): void {
    const pos = this.#geometry.attributes.position!;
    const c = SCRATCH;
    const x = pos.getX(v);
    const z = pos.getZ(v);
    const size = this.#size;
    // Warped tile lookup: organic macro boundaries.
    const tx = Math.max(0, Math.min(size - 1, Math.floor(x + this.#warpX[v]!)));
    const tz = Math.max(0, Math.min(size - 1, Math.floor(z + this.#warpZ[v]!)));
    const tile = tileIdx(tx, tz, size);
    const cls = this.#tileClass[tile];
    const y = this.#vertY[v]!;

    if (cls === CLASS_WATER) {
      c.copy(COL.bed).lerp(COL.water, Math.min(Math.max((-y - 0.2) * 1.4, 0), 1) * 0.75);
    } else {
      // Meadow: lush -> olive -> sun-dried gold.
      const m = this.#meadow[v]!;
      if (m < 0.52) c.copy(COL.lush).lerp(COL.olive, m / 0.52);
      else c.copy(COL.olive).lerp(COL.gold, (m - 0.52) / 0.48);
      // Border-ridge rock is stone all the way down: the altitude pass
      // below paints its peaks anyway, but the cliff feet the shore ease
      // pulls low would otherwise read as walkable green slope.
      if (cls === CLASS_ROCK) c.lerp(m < 0.5 ? COL.rock : COL.rockDark, 0.45);
      // Altitude: meadow dries into bare rock, and the peaks catch snow.
      if (y > 0.9) {
        const rocky = Math.min((y - 0.9) / 0.55, 1);
        c.lerp(m < 0.5 ? COL.rock : COL.rockDark, rocky * 0.9);
        if (y > 1.95) c.lerp(COL.snow, Math.min((y - 1.95) / 0.45, 1) * 0.85);
      }
      // Trampled ground near buildings.
      const e = this.#tileEarth[tile]!;
      if (e > 0) c.lerp(COL.earth, e * 0.7);
      // Deposits tint the rocky ground (never on the rim — it carries none).
      const dep = this.#tileDeposit[tile];
      if (dep === 1) c.lerp(COL.iron, 0.5);
      else if (dep === 2) c.lerp(COL.silver, 0.45);
      else if (dep === 3) c.lerp(COL.goldOre, 0.45);
    }

    // Banks sink into dark moss; anything below the waterline goes murky.
    if (y < 0.5) {
      const wet = Math.min((0.5 - y) / 1.1, 0.8);
      c.lerp(COL.moss, wet);
    }

    // Trails and roads lie on top of whatever ground they cross: a ribbon
    // threaded tile-center to tile-center, wobbled and pinched by noise so
    // its shoulders fray instead of running ruler-straight.
    if (cls !== CLASS_WATER) {
      ribbonDistances(this.#map.pathLevel, x + this.#pathWarpX[v]!, z + this.#pathWarpZ[v]!, DIST);
      const wob = this.#pathWidth[v]!;
      const trail = ribbonStrength(DIST.trail, TRAIL_HALF * wob);
      if (trail > 0) {
        c.lerp(COL.trail, trail * 0.94);
        // The middle of a trail is walked barest; the fringe keeps some turf.
        c.lerp(COL.earth, trail * trail * 0.32);
      }
      const road = ribbonStrength(DIST.road, ROAD_HALF * wob);
      if (road > 0) c.lerp(COL.road, road);
    }

    const s = this.#speck[v]!;
    this.#colorAttr.setXYZ(v, c.r * s, c.g * s, c.b * s);
  }
}

/** Palette colors used by the vertex painter, built once. */
const COL = {
  lush: new THREE.Color(grassLush),
  olive: new THREE.Color(grassOlive),
  gold: new THREE.Color(grassGold),
  earth: new THREE.Color(trampledEarth),
  moss: new THREE.Color(bankMoss),
  bed: new THREE.Color(riverbed),
  trail: new THREE.Color(earthTrail),
  road: new THREE.Color(stoneRoad),
  water: new THREE.Color(water),
  iron: new THREE.Color(ironOre),
  silver: new THREE.Color(silverOre),
  goldOre: new THREE.Color(goldOre),
  rock: new THREE.Color(rock),
  rockDark: new THREE.Color(rockDark),
  snow: new THREE.Color(peakSnow),
};
const SCRATCH = new THREE.Color();
/** Ribbon distances for the vertex being painted — one, reused. */
const DIST = newRibbonDist();
