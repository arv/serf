import * as THREE from 'three';
import { makeGhostModel } from './models';
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
    this.#group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        (obj.material as THREE.MeshLambertMaterial).emissive.copy(valid ? VALID : INVALID);
        (obj.material as THREE.MeshLambertMaterial).emissiveIntensity = 0.5;
      }
    });
  }

  hide(): void {
    if (this.#group) {
      this.#scene.remove(this.#group);
      this.#group = null;
    }
    this.#type = null;
  }
}
