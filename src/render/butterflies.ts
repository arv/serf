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
/** Filled by {@link wander}; shared so the per-frame path stays allocation-free. */
const drift = {x: 0, z: 0, yaw: 0};

/**
 * Where the butterfly anchored at (ax, az) is at time `t`, and the yaw that
 * puts its head into the direction of travel. Two incommensurate loops per
 * axis so the path never quite repeats; each velocity line below is the
 * exact derivative of the position line above it. Neither loop is small
 * enough to drop: the second is the shorter one but proportionally the
 * faster, so it still carries about four fifths of the first's share of the
 * velocity, and a heading that keeps only the first can end up a half turn
 * from the way the butterfly is actually going.
 *
 * `yaw` follows the same convention as the footprint quad's: the sprite's
 * head points along +Z at yaw 0, which is what the geometry below is
 * rotated to do. Fills and returns the shared {@link drift}.
 */
export function wander(
  ax: number,
  az: number,
  phase: number,
  t: number,
): Readonly<typeof drift> {
  drift.x = ax + 1.7 * Math.sin(t * 0.31) + 0.5 * Math.sin(t * 0.83 + phase);
  const vx =
    1.7 * 0.31 * Math.cos(t * 0.31) + 0.5 * 0.83 * Math.cos(t * 0.83 + phase);
  drift.z = az + 1.7 * Math.cos(t * 0.27 + phase) + 0.5 * Math.cos(t * 0.71);
  const vz =
    -1.7 * 0.27 * Math.sin(t * 0.27 + phase) - 0.5 * 0.71 * Math.sin(t * 0.71);
  drift.yaw = Math.atan2(vx, vz);
  return drift;
}

/**
 * The painted quad, lying flat so the wings read from the game's high
 * camera. The butterfly's head is drawn at the top of its sprite canvas,
 * which the texture's flipY puts at v = 1 and flattening alone would aim at
 * -Z; the half turn brings it round to +Z, so a heading yaw means here what
 * it means for the footprint quad. Without it every butterfly flies tail
 * first. The wingspan stays on the quad's x axis either way, which is the
 * axis {@link Butterflies.update} squeezes to flap.
 */
export function butterflyQuad(): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(0.22, 0.17);
  geometry.rotateX(-Math.PI / 2);
  geometry.rotateY(Math.PI);
  return geometry;
}

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

    const geometry = butterflyQuad();
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
      const {x, z, yaw} = wander(ax, az, phase, t);
      const y = this.#heights.at(x, z) + 0.55 + Math.sin(t * 1.9) * 0.18;
      dummy.position.set(x, y, z);
      // Nose into the direction of travel, wings squeezing to flap.
      dummy.rotation.set(0, yaw, 0);
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
