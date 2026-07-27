import * as THREE from 'three';
import { makeBuildingModel, makeGhostModel, makeSiteFrame } from './models';
import { makeMedievalBuilding } from './medieval';
import type { BuildingSnap } from '../protocol/messages';
import type { HeightField } from './heightField';

interface BuildingVisual {
  root: THREE.Group;
  state: 'site' | 'built';
  frame?: THREE.Group;
  model: THREE.Group;
  /** Warcraft-style rise: a world-space clip plane reveals the model
   * bottom-up as materials arrive and progress ticks. */
  clip?: { plane: THREE.Plane; height: number; baseY: number };
}

/**
 * Mirrors the building list into the scene. Sites show a timber frame with
 * the real building rising out of it half-built (clip-plane reveal) while a
 * peasant hammers away; completion swaps in the solid model. Themes without
 * loaded GLB assets fall back to the ghost-scale-up look.
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
        const p = b.progress01 ?? 0;
        if (v.clip) {
          // Reveal the build bottom-up; a sliver shows from the start so
          // fresh sites read as more than an empty frame.
          v.clip.plane.constant = v.clip.baseY + 0.08 + v.clip.height * p;
        } else {
          v.model.scale.setScalar(0.22 + 0.78 * p);
        }
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
    let clip: BuildingVisual['clip'];
    if (b.state === 'site') {
      frame = makeSiteFrame(b.w, b.h);
      root.add(frame);
      const medieval = makeMedievalBuilding(b.type);
      if (medieval) {
        model = medieval;
        // Per-site material clones so the clip plane never touches the
        // shared templates or finished buildings.
        const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), root.position.y);
        model.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            const m = (o.material as THREE.Material).clone();
            m.clippingPlanes = [plane];
            m.clipShadows = true;
            o.material = m;
          }
        });
        const bbox = new THREE.Box3().setFromObject(model);
        clip = { plane, height: bbox.max.y - root.position.y, baseY: root.position.y };
        plane.constant = root.position.y + 0.08;
        root.add(model);
        // No cosmetic builder here: the staffing system sends a real serf
        // who becomes the builder (and then the worker) — sceneSync
        // renders them hammering like any other unit.
      } else {
        model = makeGhostModel(b.type);
        model.scale.setScalar(0.22);
        root.add(model);
      }
    } else {
      model = makeMedievalBuilding(b.type) ?? makeBuildingModel(b.type);
      root.add(model);
    }

    this.#scene.add(root);
    return { root, state: b.state, frame, model, clip };
  }

  #dispose(id: number): void {
    const v = this.#visuals.get(id);
    if (v) {
      this.#scene.remove(v.root);
      this.#visuals.delete(id);
    }
  }
}
