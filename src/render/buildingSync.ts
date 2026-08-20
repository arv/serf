import * as THREE from 'three';
import {
  makeGhostModel,
  makePileProp,
  makeSiteFrame,
  PILE_SCALE,
  makeRoadPile,
} from './models';
import { glbYardProp, glbYardRock, makeGlbBuilding } from './assets';
import { makeCharacter, playAnimation, type CharacterVisual } from './characters';
import { eachMaterial, mapMaterials } from './materials';
import { buildingDef } from '../sim/defs/buildings';
import { UNIT_DEFS } from '../sim/defs/units';
import { WATER_LEVEL } from '../sim/map';
import { GOODS, type GoodId } from '../sim/defs/goods';
import { hash2 } from '../shared/math';
import type { FogQuery } from './fogOfWar';
import type { BuildingSnap } from '../protocol/messages';
import type { HeightField } from './heightField';
import type { CueId } from '../audio/cues';

/** A built fishery's pier, in world space: the deck line from its landward
 * end to the fishing spot near the tip, plank height, and the yaw that
 * faces the water. Shared with sceneSync, which walks the fisherman out
 * along it. */
export interface PierInfo {
  /** Building center, the anchor a fisherman is matched to his pier by. */
  bx: number;
  bz: number;
  baseX: number;
  baseZ: number;
  spotX: number;
  spotZ: number;
  yaw: number;
  deckY: number;
}

/** How far below the waterline the shoal group is re-seated, in world
 * units — enough that the tallest swim circle and the fish bodies stay
 * submerged rather than breaking the surface. */
const SHOAL_DRAFT = 0.14;

/** UNIT_DEFS.archer.kindCode — who mans a guard tower's roof. */
const ARCHER_KIND = UNIT_DEFS.archer.kindCode;

/** Reused for the post->root coordinate hop; buildings do not move. */
const SCRATCH_POS = new THREE.Vector3();

/**
 * Drop a cloned character and free what it uniquely owns on the GPU.
 *
 * Every SkeletonUtils.clone gets its own Skeleton, and a skeleton lazily
 * allocates a float DataTexture of bone matrices at first render — so
 * removing a roof archer without this leaks one texture per man, and a
 * tower manned, emptied and manned again over a long match bleeds VRAM.
 * (Geometry and materials are shared with the loaded assets and must not
 * be touched.) The same rule sceneSync applies to its unit visuals.
 */
function disposeTree(group: THREE.Object3D): void {
  group.traverse((o) => {
    if (o instanceof THREE.SkinnedMesh) o.skeleton.dispose();
  });
}

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
  /** The mill's sail assembly, turned per frame while the mill grinds. */
  fan?: THREE.Object3D;
  /** Current sail speed, eased toward grinding/idle — heavy sails spin up
   * and coast down instead of snapping with the batch boundary. */
  fanSpeed: number;
  shoal?: THREE.Object3D;
  /** The fishery's pier decor — the deck the fisherman walks out on. */
  pier?: THREE.Object3D;
  /** Measured deck line, cached: measuring may also swing the decor 45°
   * on a corner-only shore, and that must happen exactly once. */
  pierLine?: PierInfo;
  /** Quarter turns from "front faces +z" (shore buildings turn to their
   * water); kept for deriving where the pier runs. */
  facing: number;
  staffed: boolean;
  /** Latest BuildingSnap.working — a convert batch actually ticking. */
  working: boolean;
  /** Longest footprint side, for sizing the teardown dust. */
  span: number;
  /** Empty marks on a manned building's roof, harvested from the model by
   * name — where the garrison stands. Empty for everything unmanned. */
  posts: THREE.Object3D[];
  /** The archers currently standing on those posts, one per man the sim
   * says is inside. Built here rather than fed from the unit stream:
   * a garrisoned soldier is not a unit any more (he was consumed into the
   * building), so there is nothing in the SAB to place. */
  manned: { group: THREE.Group; char: CharacterVisual | null }[];
  /** Latest BuildingSnap.firing — the roof draws instead of idling. */
  firing: boolean;
}

/** One yard-stock entry: what good, worn as which look, standing where. */
interface YardStyle {
  good: GoodId;
  /** Pack prop stacks (lumber, cut stone)... */
  prop?: string;
  /** ...or spoil boulders tinted to the ore. */
  rock?: number;
  /** Normalized template coords: x, z, yaw, per-spot scale factor. */
  spots: [number, number, number, number][];
  /** Template-space size of the biggest stack or boulder. */
  size: number;
  /** Goods per stack shown. */
  per: number;
}

/** The mine model's three cut-out boulder seats (see the surgery in
 * assets.ts) — shared by the quarry and all three mines. */
const MINE_SPOTS: [number, number, number, number][] = [
  [-0.218, 0.245, 0.4, 1],
  [0.177, 0.337, -0.3, 0.52],
  [-0.325, 0.274, 1.1, 0.54],
];

const HP_BAR_W = 1.1;

/** Grinding-speed sail rotation, rad/s — brisk enough to read as working
 * at village zoom, slow enough to stay a windmill and not a propeller. */
const MILL_FAN_SPEED = 1.5;

/** One low-poly ball shared by every dust puff; scaled per puff. */
const PUFF_GEO = new THREE.IcosahedronGeometry(1, 0);

/** Scratch color for hp tinting — callers copy out of it immediately. */
const HP_COLOR = new THREE.Color();

function hpColor(pct: number): THREE.Color {
  return HP_COLOR.setHSL(0.33 * Math.max(0, Math.min(1, pct)), 0.8, 0.45);
}

// Shared across every bar (like the unit path in sceneSync): only the fg
// material is per-bar, because #styleBar tints its color per building.
const HP_BG_GEO = new THREE.PlaneGeometry(HP_BAR_W, 0.13);
const HP_FG_GEO = new THREE.PlaneGeometry(HP_BAR_W - 0.06, 0.07);
const HP_BG_MAT = new THREE.MeshBasicMaterial({
  color: 0x140f0a,
  depthTest: false,
  userData: { noFog: true },
});

/** Damage bar floating over a building, parallel with the screen plane. */
function makeHpBar(
  topY: number,
  camQuat: THREE.Quaternion | null,
): { group: THREE.Group; fg: THREE.Mesh } {
  const group = new THREE.Group();
  const bg = new THREE.Mesh(HP_BG_GEO, HP_BG_MAT);
  const fg = new THREE.Mesh(
    HP_FG_GEO,
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
  /**
   * Presentation cue channel, injected from main. Every call is guarded
   * on `v.root.visible`: unlike sceneSync, this loop does NOT skip fogged
   * buildings (they stay in the scene, merely invisible), so an unguarded
   * cue here would announce construction inside unexplored enemy ground —
   * a maphack by ear, the exact leak the fog exists to close.
   */
  onCue: ((cue: CueId, x: number, z: number) => void) | null = null;

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
        // The site's scaffolding comes down and the finished building
        // stands: the one moment construction is worth hearing. Only for
        // a swap the player can see (fog guard — see onCue), and only on
        // a real transition: a boot or a resync builds every visual
        // fresh and must not arrive as a fanfare salvo.
        if (this.onCue && v.state === 'site' && b.state === 'built' && v.root.visible) {
          this.onCue('buildingComplete', b.x + b.w / 2, b.y + b.h / 2);
        }
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
      v.working = b.working === true;
      v.firing = b.firing === true;
      this.#syncPiles(v, b);
      this.#syncGarrison(v, b);

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
    // The rumble belongs to the dust cloud below — and only where the
    // cloud is drawn (fog guard — see onCue).
    if (this.onCue && v.root.visible) {
      this.onCue('buildingCollapse', v.root.position.x, v.root.position.z);
    }
    if (v.hpBar) {
      v.root.remove(v.hpBar.group);
      // Geometry and the bg material are shared; only fg's tinted material
      // is owned by this bar.
      (v.hpBar.fg.material as THREE.Material).dispose();
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
      // Roads are the one type without a GLB — their 'built' form is the
      // terrain itself, so the pile marker covers the site moment only.
      model = makeGlbBuilding(b.type, b.owner) ?? makeRoadPile();
      root.add(model);
    }

    // Shore buildings turn to face their water (Building.facing). Only the
    // model turns, not the root: the footprint stays axis-aligned, and the
    // root's own x/z rotation belongs to the collapse animation.
    if (b.facing) model.rotation.y = (b.facing * Math.PI) / 2;

    // The template bakes the fishery's shoal at deck height off the front
    // edge, but the water surface is a world plane well below the shore the
    // building stands on — left there, the fish circle in the air over the
    // waterline. Re-seat the group so they swim just under the surface: a
    // world-unit drop, folded back into the model's vertical scale.
    const shoal = model.getObjectByName('fisheryShoal') ?? undefined;
    if (shoal) shoal.position.y = (WATER_LEVEL - SHOAL_DRAFT - root.position.y) / model.scale.y;

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
      fan: model.getObjectByName('millFan') ?? undefined,
      fanSpeed: 0,
      shoal,
      pier: model.getObjectByName('fisheryPier') ?? undefined,
      facing: b.facing ?? 0,
      staffed: false,
      working: false,
      span: Math.max(b.w, b.h),
      posts: ['towerPost0', 'towerPost1']
        .map((n) => model.getObjectByName(n))
        .filter((o): o is THREE.Object3D => o !== undefined),
      manned: [],
      firing: false,
    };
  }

  /** Built wells' world centers, windlasses and grip handles — sceneSync
   * stands the drawing serf beside the crank, IK-glues their hand to the
   * grip, and turns the windlass under it. */
  wellCranks(): { x: number; z: number; crank: THREE.Object3D; grip: THREE.Object3D }[] {
    const out: { x: number; z: number; crank: THREE.Object3D; grip: THREE.Object3D }[] = [];
    for (const v of this.#visuals.values()) {
      if (v.state !== 'built' || !v.crank) continue;
      const grip = v.crank.getObjectByName('wellGrip');
      if (grip) out.push({ x: v.root.position.x, z: v.root.position.z, crank: v.crank, grip });
    }
    return out;
  }

  /** Terrain lookup (tile ints -> is water?), fed from main's map mirror.
   * The pier measurement uses it to tell a wet tip from a dry one. */
  #water: ((tx: number, tz: number) => boolean) | null = null;

  setWater(query: (tx: number, tz: number) => boolean): void {
    this.#water = query;
  }

  /** Built fisheries' piers, in world space: where the deck line runs
   * (landward end -> fishing spot near the tip), the height of the planks,
   * and the yaw that faces the water. sceneSync walks the resident
   * fisherman out along it and stands him at the spot, line in the water —
   * the same render-side move as the well serfs, because the sim parks him
   * on whatever tile the path found. */
  fisheryPiers(): PierInfo[] {
    const out: PierInfo[] = [];
    for (const v of this.#visuals.values()) {
      if (v.state !== 'built' || !v.pier) continue;
      out.push((v.pierLine ??= this.#measurePier(v)));
    }
    return out;
  }

  #measurePier(v: BuildingVisual): PierInfo {
    // This runs on structural updates, possibly before the next render
    // ticks world matrices — settle them before measuring.
    v.root.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(v.pier!);
    let yaw = (v.facing * Math.PI) / 2;
    let dirX = Math.sin(yaw);
    let dirZ = Math.cos(yaw);
    const cx = (box.min.x + box.max.x) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    // Facing is a quarter turn, so the deck line lies along one axis.
    const half = (Math.abs(dirX) > 0.5 ? box.max.x - box.min.x : box.max.z - box.min.z) / 2;
    const baseX = cx - dirX * half;
    const baseZ = cz - dirZ * half;
    let tipX = cx + dirX * half;
    let tipZ = cz + dirZ * half;
    // Corner-only shores: placement guarantees water touching the
    // footprint, but facing is a quarter turn — when the water sits on
    // the diagonal, a straight pier ends on grass. Swing the deck 45°
    // about its landward end toward whichever diagonal is wet. Without a
    // terrain feed (tests, or before main wires it) the tip counts as
    // wet and the pier stays straight.
    const wet = (x: number, z: number): boolean =>
      this.#water?.(Math.floor(x), Math.floor(z)) ?? true;
    if (!wet(tipX, tipZ)) {
      for (const theta of [Math.PI / 4, -Math.PI / 4]) {
        const c = Math.cos(theta);
        const s = Math.sin(theta);
        const rx = tipX - baseX;
        const rz = tipZ - baseZ;
        const tx = baseX + rx * c + rz * s;
        const tz = baseZ - rx * s + rz * c;
        if (!wet(tx, tz)) continue;
        this.#swingDecor(v, baseX, baseZ, theta);
        yaw += theta;
        dirX = Math.sin(yaw);
        dirZ = Math.cos(yaw);
        tipX = tx;
        tipZ = tz;
        break;
      }
    }
    return {
      bx: v.root.position.x,
      bz: v.root.position.z,
      baseX,
      baseZ,
      // A step short of the tip, so the toes stay on the planks.
      spotX: tipX - dirX * 0.4,
      spotZ: tipZ - dirZ * 0.4,
      yaw,
      // The docks model's plank top sits at 0.04 of its own units; after
      // the decor scale that is ~0.05 over the building's ground. The
      // pier bbox can't say (its mooring posts top out well above the
      // deck), so the constant it is.
      deckY: v.root.position.y + 0.05,
    };
  }

  /** Rotate the pier — and the shoal working the water off its end — about
   * the vertical line through the deck's landward end. The parent chain is
   * Y-rotation plus uniform scale, so a world-space angle carries into the
   * local frame unchanged. */
  #swingDecor(v: BuildingVisual, baseX: number, baseZ: number, theta: number): void {
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const p = new THREE.Vector3();
    for (const obj of [v.pier, v.shoal]) {
      if (!obj?.parent) continue;
      obj.parent.worldToLocal(p.set(baseX, 0, baseZ));
      const rx = obj.position.x - p.x;
      const rz = obj.position.z - p.z;
      obj.position.x = p.x + rx * c + rz * s;
      obj.position.z = p.z - rx * s + rz * c;
      obj.rotation.y += theta;
    }
  }

  /** Per render frame: the decor that moves. dt in seconds (pass 0 while
   * paused). Windlasses are not here — the well keeps no resident, so there
   * is nothing building-side to key them off; sceneSync turns each one under
   * the serf that came to draw from it. */
  frame(dt: number): void {
    if (dt <= 0) return;
    for (const v of this.#visuals.values()) {
      if (v.fan) {
        // The sails turn while the mill grinds — the mill keeps no resident
        // (the wind is the worker), so the cue is the batch itself
        // (BuildingSnap.working), not staffing. Speed eases toward the
        // target: heavy sails carry momentum, and the coast also bridges
        // the one-tick gap between back-to-back batches, which would
        // otherwise read as a stutter whenever a publish lands in it.
        const target = v.working && v.state === 'built' ? MILL_FAN_SPEED : 0;
        v.fanSpeed += (target - v.fanSpeed) * Math.min(1, dt * 1.6);
        if (v.fanSpeed > 0.01) v.fan.rotation.z += v.fanSpeed * dt;
      }
      if (v.shoal && v.staffed && v.state === 'built') {
        // Each fish carries its own circle, direction and depth. Advancing
        // the phase and pointing the nose down the tangent is the whole
        // motion: at village zoom a rigid fish on a slow curve reads as
        // swimming, and the model has no rig to do better with.
        for (const pivot of v.shoal.children) {
          const p = pivot.userData as { r: number; phase: number; speed: number; y: number };
          p.phase += dt * p.speed;
          pivot.position.set(Math.cos(p.phase) * p.r, p.y, Math.sin(p.phase) * p.r);
          // The model's nose is -z: rotation.y = t points it at
          // (-sin t, -cos t), while the tangent of a counter-clockwise circle
          // at phase p is (-sin p, cos p). So the half turn belongs to the
          // forward swimmer, and the one running its circle backwards is the
          // one that takes the bare -phase. Swapped, every fish in the shoal
          // travelled tail-first.
          pivot.rotation.y = -p.phase + (p.speed > 0 ? Math.PI : 0);
        }
      }
      // The watch on the roof: drawing while the tower is between volleys,
      // idle the rest of the time. Desynced by post index so two men on one
      // roof never breathe in lockstep.
      for (let i = 0; i < v.manned.length; i++) {
        const char = v.manned[i]!.char;
        if (!char) continue;
        playAnimation(char, v.firing ? 'shoot' : 'idle', i * 0.37);
        char.mixer.update(dt);
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
  /** Producers whose stock lives in the yard: goods render where the
   * model's baked stock stood before the surgeries cut it out (normalized
   * template coords x the template scale) — the same graphics the model
   * shipped with, except a carrier can walk off with them. Spots are
   * biggest-first; `per` goods fill one stack/boulder. */
  static #YARDS: Partial<Record<BuildingSnap['type'], YardStyle>> = {
    woodcutter: {
      good: 'wood',
      prop: 'resource_lumber',
      spots: [
        [0.36, 0.28, 0.3, 1],
        [0.36, -0.04, -0.25, 0.9],
        [0.08, 0.3, 0.15, 0.85],
      ],
      size: 0.12,
      per: 3,
    },
    quarry: { good: 'stone', prop: 'resource_stone', spots: MINE_SPOTS, size: 0.12, per: 3 },
    ironMine: { good: 'iron', rock: 0x9a5f42, spots: MINE_SPOTS, size: 0.153, per: 2 },
    silverMine: { good: 'silver', rock: 0xdbe4ee, spots: MINE_SPOTS, size: 0.153, per: 2 },
    goldMine: { good: 'gold', rock: 0xf0bc42, spots: MINE_SPOTS, size: 0.153, per: 2 },
  };

  #syncYard(v: BuildingVisual, b: BuildingSnap): boolean {
    const yard = BuildingSync.#YARDS[b.type];
    if (!yard || b.state !== 'built') return false;
    const n = (b.stock[yard.good] ?? 0) + (b.inputs[yard.good] ?? 0);
    const stacks = Math.min(Math.ceil(n / yard.per), yard.spots.length);
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
      const [x, z, rot, f] = yard.spots[i]!;
      const item = yard.prop
        ? glbYardProp(yard.prop, yard.size * f * s)
        : glbYardRock(yard.rock!, yard.size * f * s);
      if (!item) return true; // assets missing; nothing to show
      item.position.set(x * s, 0, z * s);
      item.rotation.y = rot;
      piles.add(item);
    }
    v.root.add(piles);
    v.piles = piles;
    return true;
  }

  /**
   * Stand the tower's archers on its roof, one per man the sim reports.
   *
   * Unlike the fisherman on his pier or the serf at the windlass — both of
   * which are real units the render merely relocates — these men have no
   * unit to relocate: staffing consumed them into the building, which is
   * exactly what makes a garrison unshootable. So the roof owns its own
   * characters, created and destroyed as the count moves.
   *
   * They hang off the root rather than off the model, because the model
   * carries the footprint's scale (a 2x2 tower is 2.12x) and a character is
   * already sized in world units. The post's world position is converted
   * back through the root to get there.
   */
  #syncGarrison(v: BuildingVisual, b: BuildingSnap): void {
    const want = v.state === 'built' ? Math.min(b.garrison ?? 0, v.posts.length) : 0;
    while (v.manned.length > want) {
      const gone = v.manned.pop()!;
      v.root.remove(gone.group);
      disposeTree(gone.group);
    }
    while (v.manned.length < want) {
      const made = makeCharacter(ARCHER_KIND, 0, b.owner);
      if (!made) break; // characters not loaded yet; try again next roster
      const post = v.posts[v.manned.length]!;
      post.getWorldPosition(SCRATCH_POS);
      v.root.worldToLocal(SCRATCH_POS);
      made.group.position.copy(SCRATCH_POS);
      // Face outward, away from the tower's middle: two men shoulder to
      // shoulder staring the same way read as a rank, not a watch.
      made.group.rotation.y = Math.atan2(SCRATCH_POS.x, SCRATCH_POS.z);
      v.root.add(made.group);
      v.manned.push({ group: made.group, char: made.visual });
    }
  }

  #syncPiles(v: BuildingVisual, b: BuildingSnap): void {
    if (this.#syncYard(v, b)) return;
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
   * every material to carry their private clip plane, and hp bars, whose
   * per-building tinted fg material is theirs alone (quads are shared). */
  #freeGpu(v: BuildingVisual): void {
    // The roof watch, whose skeletons are this visual's alone (see
    // disposeTree). Here rather than in #dispose because a razed tower
    // never goes through it — it sinks into the ground first, and the
    // teardown pass is the other caller.
    for (const man of v.manned) disposeTree(man.group);
    v.manned.length = 0;
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
      // Geometry and the bg material are shared; only fg's tinted material
      // is owned by this bar.
      (v.hpBar.fg.material as THREE.Material).dispose();
    }
  }
}
