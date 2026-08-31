import * as THREE from 'three';
import {BANDIT_TINT, factionTint} from './factionPalette';
import type {HeightField} from './heightField';
import {vermillion} from './palette';
import type {SceneSync} from './sceneSync';

/**
 * Rings under selected units. Rings are pooled and repositioned every
 * frame from interpolated unit positions.
 *
 * Vermillion for your own, which is every ring a live match ever draws:
 * the pointer reaches nobody else's people there. A replay lets it reach
 * every seat, and there a rival's ring flies that seat's banner (the
 * bandits' the grey they raid in) — the same language the minimap's dots
 * and the rally flag's cloth already speak, and the thing that keeps
 * "twelve units selected" from being a sentence about the wrong army.
 */
export class SelectionFx {
  #scene: THREE.Scene;
  #heights: HeightField;
  #pool: THREE.Mesh[] = [];
  #geometry = new THREE.RingGeometry(0.26, 0.34, 24);
  /** One material per ring color, made on first need. A live match only
   * ever asks for the first of them. */
  #materials = new Map<number, THREE.MeshBasicMaterial>();
  // Scratch for the per-ring position reads: with an army selected this
  // runs hundreds of times a frame, so it must not allocate.
  #pos = {x: 0, y: 0};

  constructor(scene: THREE.Scene, heights: HeightField) {
    this.#scene = scene;
    this.#heights = heights;
    this.#geometry.rotateX(-Math.PI / 2);
  }

  #material(color: number): THREE.MeshBasicMaterial {
    let mat = this.#materials.get(color);
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({
        color,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
      });
      this.#materials.set(color, mat);
    }
    return mat;
  }

  /** `viewer` is the seat whose rings stay vermillion — this client's. */
  update(
    selection: ReadonlySet<number>,
    sync: SceneSync,
    now: number,
    viewer: number,
  ): void {
    let used = 0;
    const pos = this.#pos;
    for (const id of selection) {
      if (!sync.positionOfInto(id, now, pos)) continue;
      const owner = sync.ownerOf(id);
      const color =
        owner === null || owner === viewer
          ? vermillion
          : (factionTint(owner) ?? BANDIT_TINT);
      let ring = this.#pool[used];
      if (!ring) {
        ring = new THREE.Mesh(this.#geometry, this.#material(color));
        this.#pool.push(ring);
        this.#scene.add(ring);
      } else {
        ring.material = this.#material(color);
      }
      ring.visible = true;
      ring.position.set(pos.x, this.#heights.at(pos.x, pos.y) + 0.05, pos.y);
      used++;
    }
    for (let i = used; i < this.#pool.length; i++)
      this.#pool[i]!.visible = false;
  }
}
