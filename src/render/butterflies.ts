import * as THREE from 'three';
import {tileCount, tileX, tileY} from '../shared/grid';
import {hash2} from '../shared/math';
import {playEdgeDist, type MapView} from '../sim/map';
import * as Terrain from '../sim/terrainEnum.ts';
import * as TileResource from '../sim/tileResourceEnum.ts';
import type {HeightField} from './heightField';
import {makeButterflySprite} from './spriteTextures';

/** How many at most — ambient life, not a swarm. */
const MAX_COUNT = 36;
/** One butterfly per this many candidate meadow tiles. */
const TILES_PER_BUTTERFLY = 160;

const dummy = new THREE.Object3D();
const tint = new THREE.Color();

/**
 * A handful of butterflies drifting over the lush meadows — the cheapest
 * kind of life a valley can have. Purely render-side ambience: each one
 * wanders a small looping path around a hash-picked flowery anchor,
 * bobbing and flapping (the flap is a scale squeeze on a flat painted
 * quad — at this size the eye reads it as wings). No sim contact, no
 * per-frame allocation, and a few dozen matrix writes per frame.
 */
export class Butterflies {
  readonly mesh: THREE.InstancedMesh;
  #heights: HeightField;
  /** Per-instance anchor x/z and phase seed. */
  #anchors: Float32Array;

  constructor(map: MapView, heights: HeightField) {
    this.#heights = heights;
    const size = map.size;
    const tiles = tileCount(size);

    // Anchors: lush, open, playable-ish meadow — where the flowers are.
    const candidates: number[] = [];
    for (let i = 0; i < tiles; i++) {
      if (map.terrain[i] !== Terrain.Grass) continue;
      if (map.resource[i] !== TileResource.None) continue;
      if (map.height[i]! > 1.0) continue;
      if (playEdgeDist(map, tileX(i, size), tileY(i, size)) < -4) continue;
      if (hash2(i, 481) < 0.9) continue; // decimate before sampling spreads
      candidates.push(i);
    }
    const count = Math.min(
      MAX_COUNT,
      Math.floor((candidates.length * 10) / TILES_PER_BUTTERFLY),
    );
    this.#anchors = new Float32Array(count * 3);
    for (let k = 0; k < count; k++) {
      const i =
        candidates[Math.floor((k / Math.max(count, 1)) * candidates.length)]!;
      this.#anchors[k * 3] = tileX(i, size) + 0.5;
      this.#anchors[k * 3 + 1] = tileY(i, size) + 0.5;
      this.#anchors[k * 3 + 2] = hash2(i, 482) * 100;
    }

    const geometry = new THREE.PlaneGeometry(0.22, 0.17);
    geometry.rotateX(-Math.PI / 2); // flat: wings read from the game's high camera
    const material = new THREE.MeshBasicMaterial({
      map: makeButterflySprite(),
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, Math.max(count, 1));
    this.mesh.count = count;
    this.mesh.frustumCulled = false; // three dozen quads; culling costs more than drawing
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    for (let k = 0; k < count; k++) {
      const warm = hash2(k, 483);
      // Meadow whites, sulphur yellows, the odd copper.
      tint.setHex(warm < 0.55 ? 0xf5efdc : warm < 0.85 ? 0xf2d96a : 0xd98a4a);
      this.mesh.setColorAt(k, tint);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.update(0);
  }

  /** Move everyone along their loops; call once per rendered frame. */
  update(nowMs: number): void {
    const n = this.mesh.count;
    for (let k = 0; k < n; k++) {
      const ax = this.#anchors[k * 3]!;
      const az = this.#anchors[k * 3 + 1]!;
      const phase = this.#anchors[k * 3 + 2]!;
      const t = nowMs / 1000 + phase;
      // Two incommensurate loops so the path never quite repeats.
      const x =
        ax + Math.sin(t * 0.31) * 1.7 + Math.sin(t * 0.83 + phase) * 0.5;
      const z =
        az + Math.cos(t * 0.27 + phase) * 1.7 + Math.cos(t * 0.71) * 0.5;
      const y = this.#heights.at(x, z) + 0.55 + Math.sin(t * 1.9) * 0.18;
      dummy.position.set(x, y, z);
      // Nose along the direction of travel (cheap: the loop's derivative
      // sign is close enough at this size), wings squeezing to flap.
      dummy.rotation.set(
        0,
        Math.atan2(
          Math.cos(t * 0.31) * 0.53,
          -Math.sin(t * 0.27 + phase) * 0.46,
        ),
        0,
      );
      dummy.scale.set(0.55 + Math.abs(Math.sin(t * 9 + phase)) * 0.55, 1, 1);
      dummy.updateMatrix();
      this.mesh.setMatrixAt(k, dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Editor rebuilds inside a live context; the game drops the context. */
  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.mesh.geometry.dispose();
    const m = this.mesh.material as THREE.MeshBasicMaterial;
    m.map?.dispose();
    m.dispose();
  }
}
