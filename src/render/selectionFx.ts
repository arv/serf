import * as THREE from 'three';
import { palette } from './palette';
import type { SceneSync } from './sceneSync';
import type { HeightField } from './heightField';

/**
 * Vermillion rings under selected units. Rings are pooled and repositioned
 * every frame from interpolated unit positions.
 */
export class SelectionFx {
  #scene: THREE.Scene;
  #heights: HeightField;
  #pool: THREE.Mesh[] = [];
  #geometry = new THREE.RingGeometry(0.26, 0.34, 24);
  #material = new THREE.MeshBasicMaterial({
    color: palette.vermillion,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.9,
  });
  // Scratch for the per-ring position reads: with an army selected this
  // runs hundreds of times a frame, so it must not allocate.
  #pos = { x: 0, y: 0 };

  constructor(scene: THREE.Scene, heights: HeightField) {
    this.#scene = scene;
    this.#heights = heights;
    this.#geometry.rotateX(-Math.PI / 2);
  }

  update(selection: ReadonlySet<number>, sync: SceneSync, now: number): void {
    let used = 0;
    const pos = this.#pos;
    for (const id of selection) {
      if (!sync.positionOfInto(id, now, pos)) continue;
      let ring = this.#pool[used];
      if (!ring) {
        ring = new THREE.Mesh(this.#geometry, this.#material);
        this.#pool.push(ring);
        this.#scene.add(ring);
      }
      ring.visible = true;
      ring.position.set(pos.x, this.#heights.at(pos.x, pos.y) + 0.05, pos.y);
      used++;
    }
    for (let i = used; i < this.#pool.length; i++) this.#pool[i]!.visible = false;
  }
}
