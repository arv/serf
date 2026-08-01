import * as THREE from 'three';
import {
  makeBuildingModel,
  makeGhostModel,
  makePileProp,
  makeSiteFrame,
  PILE_SCALE,
} from './models';
import { glbYardProp, makeGlbBuilding } from './assets';
import { eachMaterial, mapMaterials } from './materials';
import { buildingDef } from '../sim/defs/buildings';
import { GOODS, type GoodId } from '../sim/defs/goods';
import { hash2 } from '../shared/math';
import type { FogQuery } from './fogOfWar';
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
  /** Longest footprint side, for sizing the teardown dust. */
  span: number;
}

const HP_BAR_W = 1.1;

/** One low-poly ball shared by every dust puff; scaled per puff. */
const PUFF_GEO = new THREE.IcosahedronGeometry(1, 0);

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
    new THREE.MeshBasicMaterial({ color: 0x140f0a, depthTest: false, userData: { noFog: true } }),
  );
  const fg = new THREE.Mesh(
    new THREE.PlaneGeometry(HP_BAR_W - 0.06, 0.07),
    new THREE.MeshBasicMaterial({ color: 0x3faf46, depthTest: false, userData: { noFog: true } }),
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
 * peasant hammers away; completion swaps in the solid model. Without loaded
 * GLB assets it falls back to the ghost-scale-up look.
 */
export class BuildingSync {
  #scene: THREE.Scene;
  #heights: HeightField;
  /** Seat viewing the scene — everyone else is an enemy to the fog. */
  #owner: number;
  #visuals = new Map<number, BuildingVisual>();
  /** Fixed camera orientation for screen-parallel hp bars (set at boot). */
  cameraQuaternion: THREE.Quaternion | null = null;
  /** Fog test; enemy buildings hide until their ground has been explored. */
  #fog: FogQuery | null = null;

  setFog(fog: FogQuery): void {
    this.#fog = fog;
  }

  constructor(scene: THREE.Scene, heights: HeightField, owner = 0) {
    this.#scene = scene;
    this.#heights = heights;
    this.#owner = owner;
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

      // Enemy buildings are remembered: once you have seen a camp it stays
      // on the map even when the light moves off it, because it is not
      // going anywhere. (Units get the opposite rule — see sceneSync.)
      if (this.#fog && b.owner !== this.#owner) {
        v.root.visible = this.#fog.exploredAt(b.x + b.w / 2, b.y + b.h / 2);
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
      // Gone from the roster: sold or razed. Instead of popping out of
      // existence the model goes down into the ground under a puff of
      // dust (see frame). The site->built swap above stays instant — that
      // building is not leaving, it is arriving.
      if (!seen.has(id)) this.#beginTeardown(id);
    }
  }

  #beginTeardown(id: number): void {
    const v = this.#visuals.get(id);
    if (!v) return;
    this.#visuals.delete(id);
    if (v.hpBar) {
      v.root.remove(v.hpBar.group);
      v.hpBar.group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          eachMaterial(o, (m) => m.dispose());
        }
      });
      v.hpBar = undefined;
    }
    // The cloud: a fistful of low-poly puffs bursting out past the walls,
    // each with its own heading, size, tumble and moment to join — chaos,
    // not choreography. A single tidy expanding ring read as a decal.
    const dust = new THREE.Group();
    dust.position.copy(v.root.position);
    const n = 8 + Math.round(v.span * 4);
    const puffs = [];
    for (let i = 0; i < n; i++) {
      const grey = 0.55 + hash2(id * 3 + i, 21) * 0.3;
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(grey + 0.09, grey + 0.03, grey * 0.82),
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(PUFF_GEO, mat);
      mesh.visible = false;
      dust.add(mesh);
      puffs.push({
        mesh,
        angle: (i / n) * Math.PI * 2 + (hash2(id + i, 3) - 0.5) * 1.2,
        r0: v.span * (0.25 + hash2(id + i, 5) * 0.3),
        vr: v.span * (0.5 + hash2(id + i, 9) * 0.7),
        size: v.span * (0.1 + hash2(id + i, 13) * 0.16),
        delay: hash2(id + i, 17) * 0.4,
        spinX: (hash2(id + i, 19) - 0.5) * 9,
        spinZ: (hash2(id + i, 23) - 0.5) * 9,
      });
    }
    this.#scene.add(dust);
    this.#dying.push({
      visual: v,
      t: 0,
      baseY: v.root.position.y,
      tiltX: (hash2(id, 7) - 0.5) * 0.22,
      tiltZ: (hash2(id, 11) - 0.5) * 0.22,
      dust,
      puffs,
    });
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
      const glb = makeGlbBuilding(b.type, b.owner);
      if (glb) {
        model = glb;
        // Per-site material clones so the clip plane never touches the
        // shared templates or finished buildings.
        const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), root.position.y);
        const clipped = (m: THREE.Material): THREE.Material => {
          const c = m.clone();
          c.clippingPlanes = [plane];
          c.clipShadows = true;
          return c;
        };
        model.traverse((o) => {
          if (o instanceof THREE.Mesh) mapMaterials(o, clipped);
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
      model = makeGlbBuilding(b.type, b.owner) ?? makeBuildingModel(b.type);
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
      span: Math.max(b.w, b.h),
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
    if (this.#dying.length === 0) return;
    const DURATION = 1.15;
    for (const d of this.#dying) {
      d.t = Math.min(d.t + dt / DURATION, 1);
      // Ease-in sink: slow shudder first, then the drop.
      const sink = d.t * d.t;
      const { root } = d.visual;
      root.position.y = d.baseY - sink * (d.visual.topY + 0.4);
      root.rotation.x = d.tiltX * d.t;
      root.rotation.z = d.tiltZ * d.t;
      for (const p of d.puffs) {
        // Each puff lives on its own clock: nothing until its delay, then
        // a burst out and up, a slow tumble, and a shrink into nothing.
        const tau = Math.min(Math.max((d.t - p.delay) / (1 - p.delay), 0), 1);
        p.mesh.visible = tau > 0;
        if (tau <= 0) continue;
        const r = p.r0 + p.vr * tau;
        p.mesh.position.set(
          Math.cos(p.angle) * r,
          0.12 + Math.sin(tau * Math.PI) * p.size * 2.2,
          Math.sin(p.angle) * r,
        );
        p.mesh.scale.setScalar(p.size * (0.5 + tau * 1.1) * (1 - tau * tau * 0.6));
        p.mesh.rotation.x += p.spinX * dt;
        p.mesh.rotation.z += p.spinZ * dt;
        (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - tau) * (1 - tau);
      }
    }
    for (let i = this.#dying.length - 1; i >= 0; i--) {
      const d = this.#dying[i]!;
      if (d.t < 1) continue;
      this.#scene.remove(d.visual.root, d.dust);
      for (const p of d.puffs) (p.mesh.material as THREE.Material).dispose();
      this.#freeGpu(d.visual);
      this.#dying.splice(i, 1);
    }
  }

  /**
   * The Settlers fantasy: every good a building holds exists physically,
   * piled against its front wall — the same props the serfs carry. Piles
   * track the true sim counts, so a good vanishes from the stack at the
   * exact publish where a carrier picks it up. Sites show the materials
   * delivered so far.
   */
  /** The woodcutter's yard: its wood stock renders as the pack's own
   * lumber stacks, standing exactly where the model's baked pile stood
   * before the surgery cut it out (normalized decor coords x the template
   * scale) — same graphics, same spot, but now the pile is real. */
  #syncWoodYard(v: BuildingVisual, b: BuildingSnap): boolean {
    if (b.type !== 'woodcutter' || b.state !== 'built') return false;
    const SPOTS: [number, number, number][] = [
      [0.36, 0.28, 0.3],
      [0.36, -0.04, -0.25],
      [0.08, 0.3, 0.15],
    ];
    const n = (b.stock.wood ?? 0) + (b.inputs.wood ?? 0);
    const stacks = Math.min(Math.ceil(n / 3), SPOTS.length);
    const key = `yard${stacks}`;
    if (key === v.pileKey) return true;
    v.pileKey = key;
    if (v.piles) {
      v.root.remove(v.piles);
      v.piles = undefined;
    }
    if (stacks === 0) return true;
    const s = Math.min(b.w, b.h) * 1.06;
    const piles = new THREE.Group();
    for (let i = 0; i < stacks; i++) {
      const [x, z, rot] = SPOTS[i]!;
      const stack = glbYardProp('resource_lumber', 0.12 * s);
      if (!stack) return true; // assets missing; nothing to show
      stack.position.set(x * s, 0, z * s);
      stack.rotation.y = rot;
      piles.add(stack);
    }
    v.root.add(piles);
    v.piles = piles;
    return true;
  }

  #syncPiles(v: BuildingVisual, b: BuildingSnap): void {
    if (this.#syncWoodYard(v, b)) return;
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
      // The lattice grows with the props (PILE_SCALE), or the fatter
      // stacks interpenetrate.
      const cx = (col - (shown.length - 1) / 2) * 0.42 * PILE_SCALE;
      for (let i = 0; i < n; i++) {
        const prop = makePileProp(good);
        const row = i % 3;
        const layer = (i / 3) | 0;
        prop.position.set(
          cx + (hash2(b.id * 31 + i, col) - 0.5) * 0.06,
          layer * 0.12 * PILE_SCALE,
          (row * 0.17 - 0.17) * PILE_SCALE,
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

  /** Visuals mid-teardown: the building already left the roster, the model
   * is sinking into its own dust. Purely cosmetic — picking, fog and the
   * mirror all forgot the building the moment the roster did. */
  #dying: {
    visual: BuildingVisual;
    t: number;
    baseY: number;
    tiltX: number;
    tiltZ: number;
    dust: THREE.Group;
    puffs: {
      mesh: THREE.Mesh;
      angle: number;
      r0: number;
      vr: number;
      size: number;
      /** Fraction of the teardown before this puff joins in. */
      delay: number;
      spinX: number;
      spinZ: number;
    }[];
  }[] = [];

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
    if (!v) return;
    this.#scene.remove(v.root);
    this.#freeGpu(v);
    this.#visuals.delete(id);
  }

  /** Free what this visual uniquely owns on the GPU. Models share the
   * template geometry/materials — except construction sites, which clone
   * every material to carry their private clip plane, and hp bars, which
   * own their two quads outright. */
  #freeGpu(v: BuildingVisual): void {
    if (v.clip) {
      v.model.traverse((o) => {
        // eachMaterial, not `.dispose()` on the field: faction-colored
        // buildings carry material arrays, and the bare call threw here —
        // which didn't just leak, it aborted update() mid-frame. The
        // finished building vanished (site removed, built model never
        // made), the broken visual stayed in the map, and every later
        // frame re-threw at the same building, freezing building sync,
        // stock, and the outcome banner for the rest of the match.
        if (o instanceof THREE.Mesh) eachMaterial(o, (m) => m.dispose());
      });
    }
    if (v.hpBar) {
      v.hpBar.group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          eachMaterial(o, (m) => m.dispose());
        }
      });
    }
  }
}
