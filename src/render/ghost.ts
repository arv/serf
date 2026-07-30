import * as THREE from 'three';
import { makeGhostModel } from './models';
import { eachMaterial } from './materials';
import { buildingDef, type BuildingTypeId } from '../sim/defs/buildings';
import type { HeightField } from './heightField';

const VALID = new THREE.Color(0x7fbf6a);
const INVALID = new THREE.Color(0xd45252);

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

  constructor(scene: THREE.Scene, heights: HeightField, owner = 0) {
    this.#scene = scene;
    this.#heights = heights;
    this.#owner = owner;
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
  }

  /** Position at footprint origin tile (x,y); tint by validity. */
  moveTo(x: number, y: number, valid: boolean): void {
    if (!this.#group || !this.#type) return;
    const def = buildingDef(this.#type);
    this.#group.visible = true;
    const cx = x + def.w / 2;
    const cz = y + def.h / 2;
    this.#group.position.set(cx, this.#heights.at(cx, cz), cz);
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
    this.#base.clear();
    this.#valid = null;
    this.#type = null;
  }
}
