import * as THREE from 'three';
import { TILE_COUNT, tileX, tileY } from '../shared/grid';
import { hash2 } from '../shared/math';
import { PathLevel, Terrain, type MapView } from '../sim/map';
import { palette } from './palette';
import { crossedQuads } from './scatterMesh';
import { foliageMaterial, makeGrassSprite } from './spriteTextures';
import type { HeightField } from './heightField';

const dummy = new THREE.Object3D();
const tmpColor = new THREE.Color();

const MAX_PER_TILE = 3;

/**
 * Painted grass clumps scattered across the meadows: alpha-tested crossed
 * quads with a hand-drawn blade sprite, clustered by noise so fields read
 * as patches rather than uniform carpet — realistic grass, comic surfaces.
 * Clumps disappear under new buildings and freshly worn trails.
 */
export class GrassField {
  readonly mesh: THREE.InstancedMesh;
  #byTile = new Map<number, number[]>();
  #cursor = 0;

  constructor(map: MapView, heights: HeightField) {
    let grassTiles = 0;
    for (let i = 0; i < TILE_COUNT; i++) {
      if (map.terrain[i] === Terrain.Grass) grassTiles++;
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

    for (let i = 0; i < TILE_COUNT; i++) {
      if (map.terrain[i] !== Terrain.Grass) continue;
      if (map.buildingAt[i]! >= 0 || map.pathLevel[i] !== PathLevel.None) continue;
      const x = tileX(i);
      const y = tileY(i);
      // Cluster density: meadow patches, not a uniform lawn.
      const density = hash2(Math.floor(x / 3) * 17, Math.floor(y / 3) * 29);
      const n = Math.round(density * MAX_PER_TILE * hash2(i, 401) * 1.6);
      for (let k = 0; k < Math.min(n, MAX_PER_TILE); k++) {
        const px = x + 0.12 + hash2(i * 3 + k, 402) * 0.76;
        const pz = y + 0.12 + hash2(i * 3 + k, 403) * 0.76;
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
        const list = this.#byTile.get(i);
        if (list) list.push(id);
        else this.#byTile.set(i, [id]);
      }
    }
    this.mesh.count = this.#cursor;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Clear a tile's clumps (building placed, trail worn through). */
  removeTile(tile: number): void {
    const ids = this.#byTile.get(tile);
    if (!ids) return;
    dummy.position.set(0, -100, 0);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.setScalar(0.0001);
    dummy.updateMatrix();
    for (const id of ids) this.mesh.setMatrixAt(id, dummy.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.#byTile.delete(tile);
  }
}
