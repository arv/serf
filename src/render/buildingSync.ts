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
  /** Model height above ground, for floating the hp bar. */
  topY: number;
  hpBar?: { group: THREE.Group; fg: THREE.Mesh };
  /** Latest hp fraction, for hover bars on healthy buildings. */
  pct: number;
}

const HP_BAR_W = 1.1;

function hpColor(pct: number): THREE.Color {
  return new THREE.Color().setHSL(0.33 * Math.max(0, Math.min(1, pct)), 0.8, 0.45);
}

/** Damage bar floating over a building, angled to the fixed camera yaw. */
function makeHpBar(topY: number): { group: THREE.Group; fg: THREE.Mesh } {
  const group = new THREE.Group();
  const bg = new THREE.Mesh(
    new THREE.PlaneGeometry(HP_BAR_W, 0.13),
    new THREE.MeshBasicMaterial({ color: 0x140f0a, depthTest: false }),
  );
  const fg = new THREE.Mesh(
    new THREE.PlaneGeometry(HP_BAR_W - 0.06, 0.07),
    new THREE.MeshBasicMaterial({ color: 0x3faf46, depthTest: false }),
  );
  bg.renderOrder = 90;
  fg.renderOrder = 91;
  group.add(bg, fg);
  group.rotation.y = Math.PI / 4;
  group.position.y = topY + 0.45;
  return { group, fg };
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

      // Damage bar: appears once hurt (hover() shows it on healthy ones).
      v.pct = b.maxHp > 0 ? b.hp / b.maxHp : 1;
      if (v.pct < 1 && !v.hpBar) {
        v.hpBar = makeHpBar(v.topY);
        v.root.add(v.hpBar.group);
      }
      this.#styleBar(v, b.id === this.#hoverId || b.id === this.#selectedId);
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
        // Note: root isn't in the scene yet, so this bbox is root-local —
        // max.y IS the model height above its own base.
        const bbox = new THREE.Box3().setFromObject(model);
        clip = { plane, height: bbox.max.y, baseY: root.position.y };
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

    const topY = clip ? clip.height : new THREE.Box3().setFromObject(model).max.y;
    this.#scene.add(root);
    return { root, state: b.state, frame, model, clip, topY, pct: 1 };
  }

  #hoverId = -1;
  #selectedId = -1;

  #styleBar(v: BuildingVisual, highlighted: boolean): void {
    if (!v.hpBar) return;
    v.hpBar.group.visible = v.pct < 1 || highlighted;
    const fg = v.hpBar.fg;
    fg.scale.x = Math.max(v.pct, 0.02);
    fg.position.x = (-(HP_BAR_W - 0.06) * (1 - fg.scale.x)) / 2;
    (fg.material as THREE.MeshBasicMaterial).color.copy(hpColor(v.pct));
  }

  /** Hovered or selected buildings show their hp bar even at full health. */
  highlight(hover: number, selected: number): void {
    if (hover === this.#hoverId && selected === this.#selectedId) return;
    this.#hoverId = hover;
    this.#selectedId = selected;
    for (const [id, v] of this.#visuals) {
      const lit = id === hover || id === selected;
      if (lit && !v.hpBar) {
        v.hpBar = makeHpBar(v.topY);
        v.root.add(v.hpBar.group);
      }
      this.#styleBar(v, lit);
    }
  }

  #dispose(id: number): void {
    const v = this.#visuals.get(id);
    if (v) {
      this.#scene.remove(v.root);
      this.#visuals.delete(id);
    }
  }
}
