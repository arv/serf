import * as THREE from 'three';
import { palette } from './palette';
import { buildingDef, gatherOrigin, gatherRecipeOf } from '../sim/defs/buildings';
import type { BuildingSnap } from '../protocol/messages';
import type { HeightField } from './heightField';

/** Half-thickness of the reach outline's band, and how far it floats above
 * the ground so it doesn't fight the terrain for the same pixels. */
const BAND_HALF = 0.13;
const BAND_LIFT = 0.06;

/**
 * The ground a gatherer's worker will search, drawn as a band on the terrain.
 *
 * The rule that refuses a woodcutter with no trees in reach is invisible on
 * its own — the hut just turns red for no stated reason. This is the same
 * rule as a shape: everything inside the outline is what the worker can
 * walk to. It is a square rather than a circle because the sim's search is
 * Chebyshev; a disc would promise corners nobody ever visits.
 */
export class ReachOutline {
  #scene: THREE.Scene;
  #heights: HeightField;
  #mesh: THREE.Mesh | null = null;
  #material: THREE.MeshBasicMaterial;
  /** Per cross-section, the two band corners as offsets from the center
   * point: [ax, az, bx, bz]. Fixed for a radius, so only the heights are
   * resampled as the outline moves. */
  #offsets = new Float32Array(0);
  #positions = new Float32Array(0);
  #radius = -1;

  constructor(scene: THREE.Scene, heights: HeightField, opacity = 0.85) {
    this.#scene = scene;
    this.#heights = heights;
    this.#material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }

  show(radius: number): void {
    if (this.#mesh && this.#radius === radius) return;
    this.hide();
    this.#radius = radius;

    // The searched box spans `radius` tiles each way from the center tile,
    // so its edge sits half a tile beyond the center point.
    const hi = radius + 0.5;
    const edges = [
      band('x', -hi, -hi - BAND_HALF, hi + BAND_HALF),
      band('x', hi, -hi - BAND_HALF, hi + BAND_HALF),
      band('z', -hi, -hi + BAND_HALF, hi - BAND_HALF),
      band('z', hi, -hi + BAND_HALF, hi - BAND_HALF),
    ];

    const offsets: number[] = [];
    const indices: number[] = [];
    for (const edge of edges) {
      // Two vertices per cross-section, and the quads only ever join
      // cross-sections within the same straight run — a strip that wrapped
      // from one edge to the next would cut the corner off.
      const base = (offsets.length / 4) * 2;
      offsets.push(...edge);
      for (let i = 0; i + 1 < edge.length / 4; i++) {
        const v = base + i * 2;
        indices.push(v, v + 1, v + 3, v, v + 3, v + 2);
      }
    }
    this.#offsets = new Float32Array(offsets);
    this.#positions = new Float32Array((offsets.length / 4) * 6);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(this.#positions, 3));
    geom.setIndex(indices);
    this.#mesh = new THREE.Mesh(geom, this.#material);
    this.#mesh.visible = false;
    this.#scene.add(this.#mesh);
  }

  /** Re-lay the band around a center point, hugging the terrain under it. */
  moveTo(cx: number, cz: number, color: THREE.Color): void {
    if (!this.#mesh) return;
    const pos = this.#positions;
    const off = this.#offsets;
    for (let j = 0; j * 4 < off.length; j++) {
      for (let k = 0; k < 2; k++) {
        const x = cx + off[j * 4 + k * 2]!;
        const z = cz + off[j * 4 + k * 2 + 1]!;
        const v = (j * 2 + k) * 3;
        pos[v] = x;
        pos[v + 1] = this.#heights.at(x, z) + BAND_LIFT;
        pos[v + 2] = z;
      }
    }
    const attr = this.#mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
    this.#mesh.geometry.computeBoundingSphere();
    this.#material.color.copy(color);
    this.#mesh.visible = true;
  }

  hide(): void {
    if (this.#mesh) {
      this.#scene.remove(this.#mesh);
      this.#mesh.geometry.dispose();
      this.#mesh = null;
    }
    this.#radius = -1;
  }
}

/** Cross-sections along one straight band of the outline, roughly one per
 * tile so the strip follows a hillside instead of sinking into it. */
function band(axis: 'x' | 'z', fixed: number, from: number, to: number): number[] {
  const segments = Math.max(1, Math.ceil(Math.abs(to - from)));
  const out: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = from + ((to - from) * i) / segments;
    if (axis === 'x') out.push(t, fixed - BAND_HALF, t, fixed + BAND_HALF);
    else out.push(fixed - BAND_HALF, t, fixed + BAND_HALF, t);
  }
  return out;
}

/** The selection's own accent, so the outline reads as "this is what the
 * building I just clicked can reach" rather than as build feedback. */
const SELECTED = new THREE.Color(palette.vermillion);

/**
 * The same outline, now for a standing building: select a woodcutter,
 * quarry or mine and the ground its worker searches is drawn around it.
 *
 * The reach only ever mattered at placement time, which is precisely when
 * the player knows least about the map. Afterwards — when a woodcutter has
 * gone idle and the question is whether it has felled everything within
 * reach or is merely short of a serf — the answer was unavailable. Clicking
 * the hut now asks it.
 */
export class SelectedReach {
  #outline: ReachOutline;
  /** The selection this was last run for, gatherer or not (-1 for none).
   * Buildings neither move nor change type, so a repeat id means the band
   * on the ground is already the right one and the frame is over — a
   * standing selection costs one comparison, not a def lookup. */
  #id = -1;

  constructor(scene: THREE.Scene, heights: HeightField) {
    this.#outline = new ReachOutline(scene, heights, 0.7);
  }

  update(building: BuildingSnap | null): void {
    const id = building?.id ?? -1;
    if (id === this.#id) return;
    this.#id = id;
    const def = building && buildingDef(building.type);
    const gather = def && gatherRecipeOf(def);
    if (!building || !def || !gather) {
      this.#outline.hide();
      return;
    }
    this.#outline.show(gather.radius);
    // The worker searches from the footprint's center tile, so the outline
    // is drawn around that tile's center — not the footprint's midpoint,
    // which is half a tile off for even-sized huts.
    const origin = gatherOrigin(def, building.x, building.y);
    this.#outline.moveTo(origin.x + 0.5, origin.y + 0.5, SELECTED);
  }
}
