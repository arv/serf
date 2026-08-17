import * as THREE from 'three';
import { tileCount, tileIdx, tileX, tileY } from '../shared/grid';
import { hash2 } from '../shared/math';
import { Terrain, inPlayArea, type MapView } from '../sim/map';
import { palette } from './palette';
import { crossedQuads } from './scatterMesh';
import { ribbonCover, type RibbonCover } from './pathRibbon';
import { foliageMaterial, makeGrassSprite } from './spriteTextures';
import type { HeightField } from './heightField';

const dummy = new THREE.Object3D();
const tmpColor = new THREE.Color();
const cover: RibbonCover = { trail: 0, road: 0 };

const MAX_PER_TILE = 3;

/** One clump: its instance slot and where it stands, for ribbon tests. */
interface Clump {
  id: number;
  x: number;
  z: number;
}

/**
 * A clump is trodden away once the ribbon reaches its roots. A dirt trail
 * keeps a little turf at its fringe — that ragged margin is half of what
 * makes it read as worn rather than drawn — but paving leaves nothing:
 * where a stone reaches at all, no blade does.
 */
function onPath(map: MapView, x: number, z: number): boolean {
  ribbonCover(map.pathLevel, x, z, cover);
  if (cover.trail > 0.35 || cover.road > 0.02) return true;
  // A clump is wider than the point it is pinned at, and blades leaning out
  // over the flagstones give the game away. Test the footprint, not the pin.
  for (const [dx, dz] of LEAN) {
    ribbonCover(map.pathLevel, x + dx, z + dz, cover);
    if (cover.road > 0.02) return true;
  }
  return false;
}

/** Half the sprite's width, north/south/east/west of where it stands. */
const LEAN = [
  [0.26, 0],
  [-0.26, 0],
  [0, 0.26],
  [0, -0.26],
] as const;

/**
 * Painted grass clumps scattered across the meadows: alpha-tested crossed
 * quads with a hand-drawn blade sprite, clustered by noise so fields read
 * as patches rather than uniform carpet — realistic grass, comic surfaces.
 * Clumps disappear under new buildings, and under the ribbon a trail wears
 * through a tile — grass to either side of the track stays standing, which
 * is what makes the track read as a track.
 */
export class GrassField {
  readonly mesh: THREE.InstancedMesh;
  #byTile = new Map<number, Clump[]>();
  #cursor = 0;

  constructor(map: MapView, heights: HeightField) {
    const size = map.size;
    const tiles = tileCount(size);
    // Play-area blades only: the margin's forest floor sits under solid
    // timber and coarse paint — clumps out there are instances nobody sees.
    let grassTiles = 0;
    for (let i = 0; i < tiles; i++) {
      if (map.terrain[i] === Terrain.Grass && inPlayArea(map, i % size, (i / size) | 0)) {
        grassTiles++;
      }
    }

    this.mesh = new THREE.InstancedMesh(
      crossedQuads(0.62, 0.42),
      foliageMaterial(makeGrassSprite()),
      Math.max(grassTiles * MAX_PER_TILE, 1),
    );
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;

    // Sprites carry the hue; instance tint only nudges lush -> dry.
    const lush = new THREE.Color(0xffffff);
    const gold = new THREE.Color(0xe8d494);

    for (let i = 0; i < tiles; i++) {
      if (map.terrain[i] !== Terrain.Grass) continue;
      if (!inPlayArea(map, i % size, (i / size) | 0)) continue;
      if (map.buildingAt[i]! >= 0) continue;
      // Above the meadow line the ground is bare rock — no blades.
      if (map.height[i]! > 1.1) continue;
      const x = tileX(i, size);
      const y = tileY(i, size);
      // Cluster density: meadow patches, not a uniform lawn.
      const density = hash2(Math.floor(x / 3) * 17, Math.floor(y / 3) * 29);
      const n = Math.round(density * MAX_PER_TILE * hash2(i, 401) * 1.6);
      for (let k = 0; k < Math.min(n, MAX_PER_TILE); k++) {
        const px = x + 0.12 + hash2(i * 3 + k, 402) * 0.76;
        const pz = y + 0.12 + hash2(i * 3 + k, 403) * 0.76;
        if (onPath(map, px, pz)) continue;
        const s = 0.75 + hash2(i * 3 + k, 404) * 0.7;
        const id = this.#cursor++;
        dummy.position.set(px, heights.at(px, pz) + 0.2 * s, pz);
        dummy.rotation.set(0, hash2(i * 3 + k, 405) * Math.PI, 0);
        dummy.scale.setScalar(s);
        dummy.updateMatrix();
        this.mesh.setMatrixAt(id, dummy.matrix);
        // Tint follows the same lush -> gold idea as the terrain paint.
        tmpColor.copy(lush).lerp(gold, hash2(i * 3 + k, 406));
        this.mesh.setColorAt(id, tmpColor);
        const clump: Clump = { id, x: px, z: pz };
        const list = this.#byTile.get(i);
        if (list) list.push(clump);
        else this.#byTile.set(i, [clump]);
      }
    }
    this.mesh.count = this.#cursor;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Clear a tile's clumps outright — a building went up on it. */
  removeTile(tile: number): void {
    const clumps = this.#byTile.get(tile);
    if (!clumps) return;
    for (const clump of clumps) this.#hide(clump.id);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.#byTile.delete(tile);
  }

  /**
   * Clear the clumps a newly worn path now runs over. The ribbon of a changed
   * tile only reaches its immediate neighbors, so sweep the 3x3 around each —
   * the neighbor's half of a fresh link is drawn on the neighbor's ground.
   */
  clearUnderPaths(map: MapView, tiles: readonly number[]): void {
    const size = map.size;
    let touched = false;
    const swept = new Set<number>();
    for (const t of tiles) {
      const tx = tileX(t, size);
      const ty = tileY(t, size);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = tx + dx;
          const ny = ty + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const idx = tileIdx(nx, ny, size);
          if (swept.has(idx)) continue;
          swept.add(idx);
          const clumps = this.#byTile.get(idx);
          if (!clumps) continue;
          const kept = clumps.filter((clump) => {
            if (!onPath(map, clump.x, clump.z)) return true;
            this.#hide(clump.id);
            touched = true;
            return false;
          });
          if (kept.length > 0) this.#byTile.set(idx, kept);
          else this.#byTile.delete(idx);
        }
      }
    }
    if (touched) this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Park an instance far below the map — the cheapest way to undraw one. */
  #hide(id: number): void {
    dummy.position.set(0, -100, 0);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.setScalar(0.0001);
    dummy.updateMatrix();
    this.mesh.setMatrixAt(id, dummy.matrix);
  }
}
