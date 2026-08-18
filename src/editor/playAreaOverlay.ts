import * as THREE from 'three';
import { ReachOutline } from '../render/reachOutline';
import type { HeightField } from '../render/heightField';
import { inPlayArea, playMax, playMin, type MapView } from '../sim/map.ts';

/** The boundary band wears the editor's own accent. */
const BOUNDS_GOLD = new THREE.Color(0xe5c469);
/** How hard the scenery ring is pressed back. */
const VEIL_OPACITY = 0.22;
/** Veil floats just off the ground so it never z-fights the terrain. */
const VEIL_LIFT = 0.045;

/**
 * The play-area boundary, drawn: a gold band along the playable square's
 * edge (ReachOutline's square is exactly this shape — a Chebyshev band
 * that hugs the terrain), plus a translucent dark veil over the scenery
 * ring so "where the game actually happens" reads at a glance. The veil
 * follows the heightfield one vertex per tile — a flat sheet would slide
 * off the margin's hills in the isometric view and dim the wrong pixels
 * along the boundary.
 *
 * Editor-only, toggleable (B): authors flip it off to judge how the
 * scenery reads without the annotation.
 */
export class PlayAreaOverlay {
  #scene: THREE.Scene;
  #heights: HeightField;
  #map: MapView;
  #band: ReachOutline;
  #veil: THREE.Mesh;
  #veilPos: THREE.BufferAttribute;
  #visible = true;

  constructor(scene: THREE.Scene, heights: HeightField, map: MapView) {
    this.#scene = scene;
    this.#heights = heights;
    this.#map = map;

    this.#band = new ReachOutline(scene, heights, 0.8);

    // Veil: the lattice over the whole grid, faces only for margin cells.
    const size = map.size;
    const row = size + 1;
    const positions = new Float32Array(row * row * 3);
    const indices: number[] = [];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (inPlayArea(map, x, y)) continue;
        const a = y * row + x;
        indices.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    this.#veilPos = new THREE.BufferAttribute(positions, 3);
    geometry.setAttribute('position', this.#veilPos);
    geometry.setIndex(indices);
    const material = new THREE.MeshBasicMaterial({
      color: 0x05070a,
      transparent: true,
      opacity: VEIL_OPACITY,
      depthWrite: false,
    });
    this.#veil = new THREE.Mesh(geometry, material);
    // After the water surface, so a margin sea dims like margin land.
    this.#veil.renderOrder = 1;
    this.#veil.frustumCulled = false; // ring geometry, cheap and always near
    scene.add(this.#veil);

    this.refresh();
  }

  /** Re-sample both pieces off the live heightfield (after sculpting). */
  refresh(): void {
    const size = this.#map.size;
    const row = size + 1;
    const p0 = playMin(this.#map);
    const p1 = playMax(this.#map);
    const arr = this.#veilPos.array as Float32Array;
    for (let y = 0; y <= size; y++) {
      for (let x = 0; x <= size; x++) {
        // Play-interior vertices carry no faces; skip their height reads.
        const inPlayInterior = x > p0 && x < p1 && y > p0 && y < p1;
        const v = (y * row + x) * 3;
        arr[v] = x;
        arr[v + 1] = inPlayInterior ? 0 : this.#heights.at(x, y) + VEIL_LIFT;
        arr[v + 2] = y;
      }
    }
    this.#veilPos.needsUpdate = true;
    this.#veil.geometry.computeBoundingSphere();
    this.setVisible(this.#visible);
  }

  setVisible(visible: boolean): void {
    this.#visible = visible;
    this.#veil.visible = visible;
    if (visible) {
      // hide() frees the band's geometry, so re-showing lays it fresh —
      // which is also what re-hugs the terrain after sculpting.
      const mid = this.#map.size / 2;
      // The square's edge sits at radius + 0.5 from the center point; the
      // play boundary is play/2 out from the grid middle.
      this.#band.show(this.#map.play / 2 - 0.5);
      this.#band.moveTo(mid, mid, BOUNDS_GOLD);
    } else {
      this.#band.hide();
    }
  }

  dispose(): void {
    this.#band.hide(); // frees its geometry and drops it from the scene
    this.#scene.remove(this.#veil);
    this.#veil.geometry.dispose();
    (this.#veil.material as THREE.Material).dispose();
  }
}
