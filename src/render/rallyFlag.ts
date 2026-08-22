import * as THREE from 'three';
import { paper, vermillion, woodLight } from './palette';
import type { BuildingSnap } from '../protocol/messages';
import type { HeightField } from './heightField';

/**
 * The barracks' rally flag: a pole and pennant planted on the muster tile,
 * drawn only while that barracks is selected. The flag is a standing order,
 * not a building — the map is not the place to remember every order on, and
 * showing it with the card that can move it is what makes the card's
 * "soldiers muster at the flag" checkable at a glance.
 *
 * Same contract as SelectedReach: update() every frame with the selected
 * building (or null), and the mesh only moves when the answer changes —
 * terrain height never changes mid-match, so a planted pole can stand still.
 */
export class RallyFlag {
  #scene: THREE.Scene;
  #heights: HeightField;
  #group: THREE.Group | null = null;
  /** What is currently planted: selection id + flag tile (-1 = nothing). */
  #id = -1;
  #x = -1;
  #y = -1;

  constructor(scene: THREE.Scene, heights: HeightField) {
    this.#scene = scene;
    this.#heights = heights;
  }

  update(building: BuildingSnap | null): void {
    const rally = building?.rally;
    if (!building || !rally) {
      if (this.#group) this.#group.visible = false;
      this.#id = -1;
      return;
    }
    if (this.#id === building.id && this.#x === rally.x && this.#y === rally.y) return;
    this.#id = building.id;
    this.#x = rally.x;
    this.#y = rally.y;
    const group = this.#group ?? (this.#group = this.#build());
    // Tile centers are at +0.5, the same convention units walk on.
    const cx = rally.x + 0.5;
    const cy = rally.y + 0.5;
    group.position.set(cx, this.#heights.at(cx, cy), cy);
    group.visible = true;
  }

  /** One pole, one pennant, one ground ring — built on first use and
   * repositioned ever after; three keeps the buffers for the page's life. */
  #build(): THREE.Group {
    const group = new THREE.Group();

    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.035, 1.15, 6),
      new THREE.MeshLambertMaterial({ color: woodLight }),
    );
    pole.position.y = 1.15 / 2;
    group.add(pole);

    // The pennant: a banner triangle off the top of the pole, double-sided
    // so it reads from every camera bearing.
    const pennant = new THREE.BufferGeometry();
    pennant.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([0, 1.13, 0, 0.42, 1.02, 0, 0, 0.88, 0]),
        3,
      ),
    );
    pennant.computeVertexNormals();
    group.add(
      new THREE.Mesh(
        pennant,
        new THREE.MeshBasicMaterial({ color: vermillion, side: THREE.DoubleSide }),
      ),
    );
    const knob = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 8, 6),
      new THREE.MeshBasicMaterial({ color: paper }),
    );
    knob.position.y = 1.18;
    group.add(knob);

    // The ring under it borrows the selection rings' language — "this spot
    // is spoken for" — a touch wider, so a soldier standing on the tile
    // doesn't swallow it.
    const ringGeom = new THREE.RingGeometry(0.34, 0.44, 24);
    ringGeom.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(
      ringGeom,
      new THREE.MeshBasicMaterial({
        color: vermillion,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
      }),
    );
    ring.position.y = 0.05;
    group.add(ring);

    this.#scene.add(group);
    return group;
  }
}
