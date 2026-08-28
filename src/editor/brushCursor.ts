import * as THREE from 'three';
import type {HeightField} from '../render/heightField';
import {foldBasis, rotatePoint} from './symmetry.ts';

/** Ring cross-sections; band half-width and ground lift (ReachOutline's). */
const SEGMENTS = 48;
const BAND_HALF = 0.09;
const BAND_LIFT = 0.06;
const MAX_RINGS = 4;

const NORMAL = new THREE.Color(0xe5c469);
const INVALID = new THREE.Color(0xd45252);

/**
 * The brush cursor: a circle of the brush's radius following the terrain
 * under the pointer — and, with kaleidoscope on, one echo ring per fold
 * image, dimmer, so every stroke shows where all its copies will land
 * before the button goes down. A disc (not ReachOutline's square) because
 * the brush kernel is Euclidean: the ring IS the set of tiles a stamp
 * reaches, under every rotation alike.
 */
export class BrushCursor {
  #scene: THREE.Scene;
  #heights: HeightField;
  #rings: {
    mesh: THREE.Mesh;
    material: THREE.MeshBasicMaterial;
    positions: Float32Array;
  }[] = [];

  constructor(scene: THREE.Scene, heights: HeightField) {
    this.#scene = scene;
    this.#heights = heights;
    for (let k = 0; k < MAX_RINGS; k++) {
      const positions = new Float32Array((SEGMENTS + 1) * 2 * 3);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(positions, 3),
      );
      const indices: number[] = [];
      for (let i = 0; i < SEGMENTS; i++) {
        const v = i * 2;
        indices.push(v, v + 1, v + 3, v, v + 3, v + 2);
      }
      geometry.setIndex(indices);
      const material = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: k === 0 ? 0.9 : 0.4,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.frustumCulled = false; // positions churn every hover; skip sphere upkeep
      mesh.renderOrder = 3;
      scene.add(mesh);
      this.#rings.push({mesh, material, positions});
    }
  }

  /** Lay the rings for a hover at (x, y) in grid space. `validAt` answers
   * per copy — on a non-symmetric map an echo can sit over ground the
   * brush will skip, and its ring must say so, not promise paint. */
  update(
    x: number,
    y: number,
    radius: number,
    folds: number,
    size: number,
    validAt: (cx: number, cy: number) => boolean,
  ): void {
    const steps = foldBasis(folds);
    for (let k = 0; k < MAX_RINGS; k++) {
      const ring = this.#rings[k]!;
      const step = steps[k];
      if (!step) {
        ring.mesh.visible = false;
        continue;
      }
      const c = rotatePoint(x, y, size, step);
      this.#lay(ring.positions, c.x, c.y, radius);
      const attr = ring.mesh.geometry.attributes
        .position as THREE.BufferAttribute;
      attr.needsUpdate = true;
      ring.material.color.copy(validAt(c.x, c.y) ? NORMAL : INVALID);
      ring.mesh.visible = true;
    }
  }

  hide(): void {
    for (const ring of this.#rings) ring.mesh.visible = false;
  }

  #lay(positions: Float32Array, cx: number, cz: number, radius: number): void {
    for (let i = 0; i <= SEGMENTS; i++) {
      const a = (i / SEGMENTS) * Math.PI * 2;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      for (let e = 0; e < 2; e++) {
        const r = radius + (e === 0 ? -BAND_HALF : BAND_HALF);
        const x = cx + dx * r;
        const z = cz + dz * r;
        const o = (i * 2 + e) * 3;
        positions[o] = x;
        positions[o + 1] = this.#heights.at(x, z) + BAND_LIFT;
        positions[o + 2] = z;
      }
    }
  }

  dispose(): void {
    for (const ring of this.#rings) {
      this.#scene.remove(ring.mesh);
      ring.mesh.geometry.dispose();
      ring.material.dispose();
    }
    this.#rings = [];
  }
}
