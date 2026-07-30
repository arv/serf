import * as THREE from 'three';
import { makeBuildingModel, makeGhostModel, makePileProp, makeSiteFrame } from './models';
import { makeMedievalBuilding } from './medieval';
import { buildingDef } from '../sim/defs/buildings';
import { GOODS, type GoodId } from '../sim/defs/goods';
import { hash2 } from '../shared/math';
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
  /** Physical stock piles against the front wall. */
  piles?: THREE.Group;
  /** Serialized pile contents — rebuilt only when the counts change. */
  pileKey: string;
  /** The well's windlass, spun per frame while the well is staffed. */
  crank?: THREE.Object3D;
  staffed: boolean;
}

const HP_BAR_W = 1.1;

function hpColor(pct: number): THREE.Color {
  return new THREE.Color().setHSL(0.33 * Math.max(0, Math.min(1, pct)), 0.8, 0.45);
}

/** Damage bar floating over a building, parallel with the screen plane. */
function makeHpBar(
  topY: number,
  camQuat: THREE.Quaternion | null,
): { group: THREE.Group; fg: THREE.Mesh } {
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
  if (camQuat) group.quaternion.copy(camQuat);
  else group.rotation.y = Math.PI / 4;
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
  /** Fixed camera orientation for screen-parallel hp bars (set at boot). */
  cameraQuaternion: THREE.Quaternion | null = null;

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

      v.staffed = b.staffing === 'staffed';
      this.#syncPiles(v, b);

      // Damage bar: appears once hurt (hover() shows it on healthy ones).
      v.pct = b.maxHp > 0 ? b.hp / b.maxHp : 1;
      if (v.pct < 1 && !v.hpBar) {
        v.hpBar = makeHpBar(v.topY, this.cameraQuaternion);
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
      const medieval = makeMedievalBuilding(b.type, b.owner);
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
      model = makeMedievalBuilding(b.type, b.owner) ?? makeBuildingModel(b.type);
      root.add(model);
    }

    const topY = clip ? clip.height : new THREE.Box3().setFromObject(model).max.y;
    this.#scene.add(root);
    return {
      root,
      state: b.state,
      frame,
      model,
      clip,
      topY,
      pct: 1,
      pileKey: '',
      crank: model.getObjectByName('wellCrank') ?? undefined,
      staffed: false,
    };
  }

  /** Built wells' world centers and grip handles — sceneSync IK-glues the
   * drawing serf's hand to the grip and stands them beside it. */
  wellCranks(): { x: number; z: number; grip: THREE.Object3D }[] {
    const out: { x: number; z: number; grip: THREE.Object3D }[] = [];
    for (const v of this.#visuals.values()) {
      if (v.state !== 'built' || !v.crank) continue;
      const grip = v.crank.getObjectByName('wellGrip');
      if (grip) out.push({ x: v.root.position.x, z: v.root.position.z, grip });
    }
    return out;
  }

  /** Per render frame: turn the staffed wells' windlasses. dt in seconds
   * (pass 0 while paused). */
  frame(dt: number): void {
    if (dt <= 0) return;
    for (const v of this.#visuals.values()) {
      if (v.crank && v.staffed && v.state === 'built') {
        // Axle runs along x, resting on the side frames. One revolution per
        // loop of the worker's reeling clip (1.6 s) — both advance on render
        // dt, so the grip and the cranking hands stay frequency-locked.
        v.crank.rotation.x += dt * ((Math.PI * 2) / 1.6);
      }
    }
  }

  /**
   * The Settlers fantasy: every good a building holds exists physically,
   * piled against its front wall — the same props the serfs carry. Piles
   * track the true sim counts, so a good vanishes from the stack at the
   * exact publish where a carrier picks it up. Sites show the materials
   * delivered so far.
   */
  #syncPiles(v: BuildingVisual, b: BuildingSnap): void {
    const def = buildingDef(b.type);
    const shown: [GoodId, number][] = [];
    for (const g of GOODS) {
      let n: number;
      if (b.state === 'site') {
        // Delivered materials wait by the frame, then drain into the
        // structure as the build progresses.
        const delivered =
          ((def.cost as Partial<Record<GoodId, number>>)[g] ?? 0) - (b.siteNeeds?.[g] ?? 0);
        n = Math.round(delivered * (1 - (b.progress01 ?? 0)));
      } else {
        n = (b.stock[g] ?? 0) + (b.inputs[g] ?? 0);
      }
      if (n > 0) shown.push([g, Math.min(n, 8)]);
    }
    const key = shown.map(([g, n]) => `${g}${n}`).join('.');
    if (key === v.pileKey) return;
    v.pileKey = key;
    if (v.piles) {
      v.root.remove(v.piles);
      v.piles = undefined;
    }
    if (shown.length === 0) return;

    const piles = new THREE.Group();
    // Just outside the front wall, Settlers-style — goods wait at the door
    // (they're ankle-high; carriers step over them).
    piles.position.set(0, 0, b.h / 2 + 0.3);
    shown.forEach(([good, n], col) => {
      const cx = (col - (shown.length - 1) / 2) * 0.42;
      for (let i = 0; i < n; i++) {
        const prop = makePileProp(good);
        const row = i % 3;
        const layer = (i / 3) | 0;
        prop.position.set(
          cx + (hash2(b.id * 31 + i, col) - 0.5) * 0.06,
          layer * 0.12,
          row * 0.17 - 0.17,
        );
        prop.rotation.y = (hash2(b.id * 17 + i, col + 9) - 0.5) * 0.7;
        piles.add(prop);
      }
    });
    v.root.add(piles);
    v.piles = piles;
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
        v.hpBar = makeHpBar(v.topY, this.cameraQuaternion);
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
