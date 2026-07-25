import * as THREE from 'three';
import { makeBuildingModel, makeGhostModel, makeSiteFrame } from './models';
import type { BuildingSnap } from '../protocol/messages';
import type { HeightField } from './heightField';

interface BuildingVisual {
  root: THREE.Group;
  state: 'site' | 'built';
  frame?: THREE.Group;
  model: THREE.Group;
}

/**
 * Mirrors the building list into the scene. Sites show a timber frame plus a
 * ghosted model that grows with build progress; completion swaps in the solid
 * model.
 */
export class BuildingSync {
  #scene: THREE.Scene;
  #heights: HeightField;
  #visuals = new Map<number, BuildingVisual>();

  constructor(scene: THREE.Scene, heights: HeightField) {
    this.#scene = scene;
    this.#heights = heights;
  }

  update(buildings: BuildingSnap[]): void {
    const seen = new Set<number>();
    for (const b of buildings) {
      seen.add(b.id);
      let v = this.#visuals.get(b.id);
      if (v && v.state !== b.state) {
        this.#dispose(b.id);
        v = undefined;
      }
      if (!v) {
        v = this.#create(b);
        this.#visuals.set(b.id, v);
      }
      if (b.state === 'site') {
        const scale = 0.22 + 0.78 * (b.progress01 ?? 0);
        v.model.scale.setScalar(scale);
      }
    }
    for (const id of [...this.#visuals.keys()]) {
      if (!seen.has(id)) this.#dispose(id);
    }
  }

  #create(b: BuildingSnap): BuildingVisual {
    const root = new THREE.Group();
    const cx = b.x + b.w / 2;
    const cz = b.y + b.h / 2;
    root.position.set(cx, this.#heights.at(cx, cz), cz);

    let frame: THREE.Group | undefined;
    let model: THREE.Group;
    if (b.state === 'site') {
      frame = makeSiteFrame(b.w, b.h);
      root.add(frame);
      model = makeGhostModel(b.type);
      model.scale.setScalar(0.22);
      root.add(model);
    } else {
      model = makeBuildingModel(b.type);
      root.add(model);
    }

    this.#scene.add(root);
    return { root, state: b.state, frame, model };
  }

  #dispose(id: number): void {
    const v = this.#visuals.get(id);
    if (v) {
      this.#scene.remove(v.root);
      this.#visuals.delete(id);
    }
  }
}
