import * as THREE from 'three';
import { makeGhostModel } from './models';
import { eachMaterial } from './materials';
import {
  buildingDef,
  gatherOrigin,
  gatherRecipeOf,
  type BuildingTypeId,
} from '../sim/defs/buildings';
import type { HeightField } from './heightField';

const VALID = new THREE.Color(0x7fbf6a);
const INVALID = new THREE.Color(0xd45252);

/** Half-thickness of the reach outline's band, and how far it floats above
 * the ground so it doesn't fight the terrain for the same pixels. */
const BAND_HALF = 0.13;
const BAND_LIFT = 0.06;

/**
 * The ground a gatherer's worker will search, drawn under the ghost.
 *
 * The rule that refuses a woodcutter with no trees in reach is invisible on
 * its own — the hut just turns red for no stated reason. This is the same
 * rule as a shape: everything inside the outline is what the worker can
 * walk to. It is a square rather than a circle because the sim's search is
 * Chebyshev; a disc would promise corners nobody ever visits.
 */
class ReachOutline {
  #scene: THREE.Scene;
  #heights: HeightField;
  #mesh: THREE.Mesh | null = null;
  #material = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  /** Per cross-section, the two band corners as offsets from the center
   * point: [ax, az, bx, bz]. Fixed for a radius, so only the heights are
   * resampled as the ghost moves. */
  #offsets = new Float32Array(0);
  #positions = new Float32Array(0);
  #radius = -1;

  constructor(scene: THREE.Scene, heights: HeightField) {
    this.#scene = scene;
    this.#heights = heights;
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
  moveTo(cx: number, cz: number, valid: boolean): void {
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
    this.#material.color.copy(valid ? VALID : INVALID);
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

/**
 * The placement preview: a semi-transparent building model snapped to the
 * hovered tile, tinted green/red by validity.
 */
export class GhostPlacement {
  #scene: THREE.Scene;
  #heights: HeightField;
  #group: THREE.Group | null = null;
  #type: BuildingTypeId | null = null;
  /** Seat whose colors the preview wears. */
  #owner: number;
  /** Each ghost material's untinted color — the tint multiplies this, so it
   * has to survive being reapplied on every hover. */
  #base = new Map<THREE.Material, THREE.Color>();
  #valid: boolean | null = null;
  #reach: ReachOutline;

  constructor(scene: THREE.Scene, heights: HeightField, owner = 0) {
    this.#scene = scene;
    this.#heights = heights;
    this.#owner = owner;
    this.#reach = new ReachOutline(scene, heights);
  }

  show(type: BuildingTypeId): void {
    if (this.#type === type) return;
    this.hide();
    this.#type = type;
    this.#group = makeGhostModel(type, 0.55, this.#owner);
    this.#group.visible = false;
    this.#group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        eachMaterial(obj, (m) => {
          const lit = m as THREE.MeshLambertMaterial;
          if (lit.color) this.#base.set(m, lit.color.clone());
        });
      }
    });
    this.#scene.add(this.#group);
    const gather = gatherRecipeOf(buildingDef(type));
    if (gather) this.#reach.show(gather.radius);
  }

  /** Position at footprint origin tile (x,y); tint by validity. */
  moveTo(x: number, y: number, valid: boolean): void {
    if (!this.#group || !this.#type) return;
    const def = buildingDef(this.#type);
    this.#group.visible = true;
    const cx = x + def.w / 2;
    const cz = y + def.h / 2;
    this.#group.position.set(cx, this.#heights.at(cx, cz), cz);
    // The worker searches from the footprint's center tile, so the outline
    // is drawn around that tile's center — not the footprint's midpoint,
    // which is half a tile off for even-sized huts.
    const origin = gatherOrigin(def, x, y);
    this.#reach.moveTo(origin.x + 0.5, origin.y + 0.5, valid);
    if (valid === this.#valid) return;
    this.#valid = valid;
    const tint = valid ? VALID : INVALID;
    this.#group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      eachMaterial(obj, (m) => {
        const lit = m as THREE.MeshLambertMaterial;
        const base = this.#base.get(m);
        // Multiply rather than add: the buildings are brightly textured, and
        // an emissive tint on top of that washes out to pale pink instead of
        // reading as "you cannot build here".
        if (base) lit.color.copy(base).multiply(tint);
        if (!lit.emissive) return; // unlit materials can't glow
        lit.emissive.copy(tint);
        lit.emissiveIntensity = 0.22;
      });
    });
  }

  hide(): void {
    if (this.#group) {
      this.#scene.remove(this.#group);
      this.#group = null;
    }
    this.#reach.hide();
    this.#base.clear();
    this.#valid = null;
    this.#type = null;
  }
}
