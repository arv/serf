import * as THREE from 'three';
import {
  ACTION,
  AUX_STRIDE,
  MAX_UNITS,
  PUBLISH_INTERVAL_MS,
  WORK,
  type SabReader,
} from '../protocol/sabLayout';
import { clamp, hash2, lerp } from '../shared/math';
import type { FogQuery } from './fogOfWar';
import { GOODS } from '../sim/defs/goods';
import { makeCarryProp, makeUnitModel } from './models';
import { THEME } from './medieval';
import {
  makeCharacter,
  playAnimation,
  setWorkTool,
  type AnimKey,
  type CharacterVisual,
} from './characters';
import type { HeightField } from './heightField';

/** Named joint pivots of an articulated person (see models.ts person()). */
interface Rig {
  hips: THREE.Object3D | undefined;
  legL: THREE.Object3D | undefined;
  legR: THREE.Object3D | undefined;
  shinL: THREE.Object3D | undefined;
  shinR: THREE.Object3D | undefined;
  armL: THREE.Object3D | undefined;
  armR: THREE.Object3D | undefined;
  foreL: THREE.Object3D | undefined;
  foreR: THREE.Object3D | undefined;
  torso: THREE.Object3D | undefined;
  head: THREE.Object3D | undefined;
}

interface UnitVisual {
  group: THREE.Group;
  kind: number;
  carrying: number;
  carryBox: THREE.Object3D | null;
  hpBar: THREE.Mesh | null;
  /** Skinned GLB character when assets are loaded... */
  char: CharacterVisual | null;
  /** ...else the procedural articulated person. */
  rig: Rig | null;
  /** Smoothed visual de-overlap offset — render-only; the sim's positions
   * stay untouched (no unit collision by design). */
  sepX: number;
  sepY: number;
  /** Right-arm bone chain for the well-crank IK. undefined = not looked
   * up yet, null = this rig has no such bones. */
  arm?: ArmChain | null;
}

interface ArmChain {
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  hand: THREE.Object3D;
}

/** GLTFLoader sanitizes bone names ('upperarm.r' → 'upperarmr'). */
function findArm(group: THREE.Group): ArmChain | null {
  const bone = (n: string): THREE.Object3D | undefined =>
    group.getObjectByName(n) ?? group.getObjectByName(n.replace(/[^\w-]/g, ''));
  const upper = bone('upperarm.r');
  const lower = bone('lowerarm.r');
  const hand = bone('hand.r');
  return upper && lower && hand ? { upper, lower, hand } : null;
}

const IK_B = new THREE.Vector3();
const IK_E = new THREE.Vector3();
const IK_D = new THREE.Vector3();
const IK_Q = new THREE.Quaternion();
const IK_PQ = new THREE.Quaternion();
const IK_PQI = new THREE.Quaternion();
const IK_TARGET = new THREE.Vector3();

/** One CCD step: swing `bone` so `tip` aims at `target` (world space). */
function aimBone(bone: THREE.Object3D, tip: THREE.Object3D, target: THREE.Vector3): void {
  bone.updateWorldMatrix(true, false);
  tip.updateWorldMatrix(true, false);
  bone.getWorldPosition(IK_B);
  tip.getWorldPosition(IK_E);
  IK_E.sub(IK_B);
  IK_D.copy(target).sub(IK_B);
  if (IK_E.lengthSq() < 1e-8 || IK_D.lengthSq() < 1e-8) return;
  IK_Q.setFromUnitVectors(IK_E.normalize(), IK_D.normalize());
  bone.parent!.getWorldQuaternion(IK_PQ);
  IK_PQI.copy(IK_PQ).invert();
  // local' = parent⁻¹ · Δworld · parent · local
  bone.quaternion.premultiply(IK_PQ).premultiply(IK_Q).premultiply(IK_PQI);
}

/** CCD from the elbow out: a few passes settle the hand on the target
 * (or at full stretch toward it when out of reach). */
function ikReach(arm: ArmChain, target: THREE.Vector3): void {
  aimBone(arm.lower, arm.hand, target);
  aimBone(arm.upper, arm.hand, target);
  aimBone(arm.lower, arm.hand, target);
  aimBone(arm.upper, arm.hand, target);
  aimBone(arm.lower, arm.hand, target);
}

function rigOf(group: THREE.Group): Rig {
  return {
    hips: group.getObjectByName('hips'),
    legL: group.getObjectByName('legL'),
    legR: group.getObjectByName('legR'),
    shinL: group.getObjectByName('shinL'),
    shinR: group.getObjectByName('shinR'),
    armL: group.getObjectByName('armL'),
    armR: group.getObjectByName('armR'),
    foreL: group.getObjectByName('foreL'),
    foreR: group.getObjectByName('foreR'),
    torso: group.getObjectByName('torso'),
    head: group.getObjectByName('head'),
  };
}

const rot = (n: THREE.Object3D | undefined, x: number, y = 0, z = 0): void => {
  if (n) n.rotation.set(x, y, z);
};

/** Only the Japan theme carries water on a shoulder yoke, which rides fine
 * on the plain gait. Medieval hauls a bucket, so it needs the holding pose
 * like every other good — otherwise the bucket floats unheld. */
const YOKE_CODE = THEME === 'japan' ? GOODS.indexOf('water') + 1 : -1;

/** WORK.* byte → the tool animation to play. */
function workAnimKey(workKind: number): AnimKey {
  switch (workKind) {
    case WORK.pickaxe:
      return 'pickaxe';
    case WORK.hammer:
      return 'hammer';
    case WORK.dig:
      return 'dig';
    case WORK.tend:
      return 'tend';
    case WORK.draw:
      return 'draw';
    default:
      return 'work';
  }
}

/** Fallback "death animation" for rigs with no death clip: keel over. */
function tipOver(group: THREE.Object3D, dt: number): void {
  group.rotation.x = Math.max(group.rotation.x - dt * 4, -Math.PI / 2);
}

/** Smoothstep 0..1 — eases anticipation in and recoveries out. */
const ease = (u: number): number => u * u * (3 - 2 * u);

/**
 * Procedural skeletal animation: what you do is what you show. The model
 * faces +z, so negative rotation.x swings a hanging limb forward; knees only
 * fold positive, elbows only negative. Phase offsets by id keep a crowd from
 * moving in lockstep.
 */
function animate(
  rig: Rig,
  id: number,
  now: number,
  moving: boolean,
  action: number,
  carrying: boolean,
): void {
  const phase = now * 0.012 + id * 2.1;

  if (moving) {
    const swing = Math.sin(phase);
    // Contra-lateral gait with pelvic rotation; the torso counter-rotates
    // and the head stabilizes against both.
    rot(rig.legL, swing * 0.55);
    rot(rig.legR, -swing * 0.55);
    // Knees fold through the recovery swing, extend into heel-strike.
    rot(rig.shinL, 0.1 + Math.max(0, -Math.cos(phase)) * 0.85);
    rot(rig.shinR, 0.1 + Math.max(0, Math.cos(phase)) * 0.85);
    if (rig.hips) rig.hips.rotation.set(0, -swing * 0.08, 0);
    if (carrying) {
      // Both hands up steadying the shoulder load; heavier forward lean.
      rot(rig.armL, -2.35);
      rot(rig.armR, -2.35);
      rot(rig.foreL, -0.55);
      rot(rig.foreR, -0.55);
      rot(rig.torso, 0.14, swing * 0.05);
    } else {
      rot(rig.armL, -swing * 0.5, 0, -0.05);
      rot(rig.armR, swing * 0.5, 0, 0.05);
      // Standing elbow bend that folds further on the fore-swing.
      rot(rig.foreL, -0.3 - Math.max(0, swing) * 0.45);
      rot(rig.foreR, -0.3 - Math.max(0, -swing) * 0.45);
      rot(rig.torso, 0.07, swing * 0.1, swing * 0.03);
    }
    rot(rig.head, -0.04, -(rig.torso?.rotation.y ?? 0) * 0.7);
    return;
  }

  if (action === ACTION.work) {
    // Anticipation -> strike -> recover: slow eased windup, whip-fast fall
    // (accelerating, not linear), brief follow-through past the bottom.
    const t = (now * 0.0016 + id * 0.37) % 1;
    let lift: number; // 0 rest .. 1 overhead
    let through = 0; // follow-through carry past the strike point
    if (t < 0.55) {
      lift = ease(t / 0.55);
    } else if (t < 0.7) {
      const u = (t - 0.55) / 0.15;
      lift = 1 - u * u;
    } else {
      lift = 0;
      through = Math.sin(((t - 0.7) / 0.3) * Math.PI) * 0.3;
    }
    rot(rig.armR, -0.4 - lift * 2.0 + through);
    rot(rig.foreR, -0.25 - lift * 0.9); // elbow cocks up, extends at impact
    rot(rig.armL, -0.25 - lift * 0.35);
    rot(rig.foreL, -0.5);
    rot(rig.torso, 0.06 + (1 - lift) * 0.22, -0.12 + lift * 0.18);
    rot(rig.head, 0.16 - (1 - lift) * 0.08); // eyes on the work
    // Planted working stance, knees loaded.
    rot(rig.legL, 0.26);
    rot(rig.shinL, 0.3);
    rot(rig.legR, -0.3);
    rot(rig.shinR, 0.22);
    if (rig.hips) rig.hips.rotation.set(0, 0.08, 0);
    return;
  }

  if (action === ACTION.fight) {
    // Kenjutsu cut: coil over the rear shoulder, explosive diagonal cut
    // driven from the hips, settle back to guard.
    const t = (now * 0.004 + id * 0.61) % 1;
    let raise: number; // 0 low .. 1 coiled overhead
    let drive: number; // 0 coiled back .. 1 hips driven through the cut
    if (t < 0.45) {
      raise = ease(t / 0.45);
      drive = 0;
    } else if (t < 0.58) {
      const u = (t - 0.45) / 0.13;
      raise = 1 - u * u;
      drive = u;
    } else {
      raise = 0;
      drive = 1 - ease(Math.min(1, ((t - 0.58) / 0.42) * 1.4));
    }
    rot(rig.armR, -0.55 - raise * 1.95, -raise * 0.25);
    rot(rig.foreR, -0.2 - raise * 1.0);
    // Off hand up in guard.
    rot(rig.armL, -0.85, 0.15);
    rot(rig.foreL, -1.05);
    rot(rig.torso, 0.1 + drive * 0.14, -0.25 - raise * 0.2 + drive * 0.8);
    rot(rig.head, 0.04, -(rig.torso?.rotation.y ?? 0) * 0.55); // eyes on target
    // Front-back stance; the lead knee loads through the cut.
    rot(rig.legL, -0.4 + drive * 0.12);
    rot(rig.shinL, 0.35 + drive * 0.25);
    rot(rig.legR, 0.45 - drive * 0.1);
    rot(rig.shinR, 0.12);
    if (rig.hips) rig.hips.rotation.set(0, -0.15 + drive * 0.3, 0);
    return;
  }

  // Idle: weight settles onto one hip with a slow sway, quiet breath, and
  // an occasional glance around.
  const breath = Math.sin(now * 0.002 + id);
  const sway = Math.sin(now * 0.0009 + id * 1.3);
  rot(rig.legL, 0.02 - sway * 0.02, 0, sway * 0.03);
  rot(rig.legR, -0.02 + sway * 0.02, 0, sway * 0.03);
  rot(rig.shinL, 0.06 + Math.max(0, sway) * 0.05);
  rot(rig.shinR, 0.06 + Math.max(0, -sway) * 0.05);
  if (rig.hips) rig.hips.rotation.set(0, 0, sway * 0.035);
  if (carrying) {
    rot(rig.armL, -2.35);
    rot(rig.armR, -2.35);
    rot(rig.foreL, -0.55);
    rot(rig.foreR, -0.55);
  } else {
    rot(rig.armL, breath * 0.03, 0, -0.06);
    rot(rig.armR, -breath * 0.03, 0, 0.06);
    rot(rig.foreL, -0.22 - breath * 0.02);
    rot(rig.foreR, -0.22 - breath * 0.02);
  }
  rot(rig.torso, 0.03 + breath * 0.02, sway * 0.05, -sway * 0.025);
  rot(rig.head, breath * 0.015, Math.sin(now * 0.0006 + id * 2.7) * 0.35);
}

const hpBarGeometry = new THREE.PlaneGeometry(0.5, 0.06);
const hpBarMaterials = new Map<number, THREE.MeshBasicMaterial>();

function hpBarMaterial(pct: number): THREE.MeshBasicMaterial {
  // Bucketed green->red so materials are shared.
  const bucket = Math.max(0, Math.min(4, Math.floor(pct * 5)));
  let mat = hpBarMaterials.get(bucket);
  if (!mat) {
    const color = new THREE.Color().setHSL(0.33 * (bucket / 4), 0.8, 0.45);
    mat = new THREE.MeshBasicMaterial({ color, depthTest: false, userData: { noFog: true } });
    hpBarMaterials.set(bucket, mat);
  }
  return mat;
}

/**
 * The only module that creates/destroys unit visuals. Reconciles against the
 * latest SAB publish each frame: new ids get models, vanished ids are
 * disposed, everyone else is positioned at lerp(prev, latest, alpha) where
 * alpha runs on the render clock between publishes.
 */
export class SceneSync {
  #scene: THREE.Scene;
  #reader: SabReader;
  #heights: HeightField;
  #visuals = new Map<number, UnitVisual>();
  #lastNow = 0;
  /** Animation clock: advances only while the game is running. */
  #animNow = 0;
  /** Live reference to the (fixed-angle) camera orientation, set at boot;
   * hp bars copy it to stay parallel with the screen plane. */
  cameraQuaternion: THREE.Quaternion | null = null;

  /** Built wells' world centers + grip handles (from main's structural
   * feed). A drawing serf belongs at the windlass, but the sim parks
   * staffed workers on whichever adjacent tile the path found — so the
   * render stands them beside the crank and IK-glues their hand to the
   * grip (see update). */
  #wells: { x: number; z: number; grip: THREE.Object3D }[] = [];

  setWells(wells: { x: number; z: number; grip: THREE.Object3D }[]): void {
    this.#wells = wells;
  }

  /** Fog test; enemies standing in unlit ground are not drawn at all. */
  #fog: FogQuery | null = null;

  setFog(fog: FogQuery): void {
    this.#fog = fog;
  }

  /** Ids currently hidden by fog — picking and selection skip them. */
  #hidden = new Set<number>();

  /** Seat viewing the scene — everyone else is an enemy to the fog. */
  #owner: number;

  #nearestWell(x: number, y: number): { x: number; z: number; grip: THREE.Object3D } | null {
    let well: { x: number; z: number; grip: THREE.Object3D } | null = null;
    let best = 2.25; // the worker stands adjacent: within 1.5 tiles
    for (const w of this.#wells) {
      const dx = w.x - x;
      const dz = w.z - y;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) {
        best = d2;
        well = w;
      }
    }
    return well;
  }

  // Scratch buffers for the per-frame visual de-overlap pass.
  #posX = new Float32Array(MAX_UNITS);
  #posY = new Float32Array(MAX_UNITS);
  #sepTX = new Float32Array(MAX_UNITS);
  #sepTY = new Float32Array(MAX_UNITS);
  #cells = new Map<number, number[]>();

  /**
   * Soft visual separation: units drawn closer than SEP_RADIUS get pushed
   * apart a little (capped, smoothed by the caller). Purely cosmetic — the
   * sim has no unit collision by design, so hauling and combat never jam.
   */
  #computeSeparation(
    latest: { count: number; xs: Float32Array; ys: Float32Array; aux: Uint8Array; index: Map<number, number>; ids: Int32Array },
    prev: { xs: Float32Array; ys: Float32Array; index: Map<number, number> },
    alpha: number,
  ): void {
    const SEP_RADIUS = 0.44;
    const MAX_PUSH = 0.34;
    const n = latest.count;
    this.#cells.clear();
    for (let i = 0; i < n; i++) {
      const id = latest.ids[i]!;
      const pi = prev.index.get(id);
      this.#posX[i] = pi === undefined ? latest.xs[i]! : lerp(prev.xs[pi]!, latest.xs[i]!, alpha);
      this.#posY[i] = pi === undefined ? latest.ys[i]! : lerp(prev.ys[pi]!, latest.ys[i]!, alpha);
      this.#sepTX[i] = 0;
      this.#sepTY[i] = 0;
      if (latest.aux[i * AUX_STRIDE + 4] === ACTION.dead) continue; // corpses lie still
      const key = (this.#posX[i]! | 0) * 256 + (this.#posY[i]! | 0);
      let cell = this.#cells.get(key);
      if (!cell) this.#cells.set(key, (cell = []));
      cell.push(i);
    }
    for (let i = 0; i < n; i++) {
      if (latest.aux[i * AUX_STRIDE + 4] === ACTION.dead) continue;
      const cx = this.#posX[i]! | 0;
      const cy = this.#posY[i]! | 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const cell = this.#cells.get((cx + dx) * 256 + cy + dy);
          if (!cell) continue;
          for (const j of cell) {
            if (j === i) continue;
            const ddx = this.#posX[i]! - this.#posX[j]!;
            const ddy = this.#posY[i]! - this.#posY[j]!;
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 >= SEP_RADIUS * SEP_RADIUS) continue;
            const d = Math.sqrt(d2);
            if (d < 1e-4) {
              // Exactly stacked: split along a stable per-pair direction.
              const ang = hash2(latest.ids[i]! * 31 + latest.ids[j]!, 5) * Math.PI * 2;
              this.#sepTX[i]! += Math.cos(ang) * SEP_RADIUS * 0.5;
              this.#sepTY[i]! += Math.sin(ang) * SEP_RADIUS * 0.5;
            } else {
              const push = (SEP_RADIUS - d) * 0.5;
              this.#sepTX[i]! += (ddx / d) * push;
              this.#sepTY[i]! += (ddy / d) * push;
            }
          }
        }
      }
      // Cap so crowds squash instead of exploding outward.
      const m2 = this.#sepTX[i]! * this.#sepTX[i]! + this.#sepTY[i]! * this.#sepTY[i]!;
      if (m2 > MAX_PUSH * MAX_PUSH) {
        const s = MAX_PUSH / Math.sqrt(m2);
        this.#sepTX[i]! *= s;
        this.#sepTY[i]! *= s;
      }
    }
  }

  constructor(scene: THREE.Scene, reader: SabReader, heights: HeightField, owner = 0) {
    this.#scene = scene;
    this.#reader = reader;
    this.#heights = heights;
    this.#owner = owner;
  }

  /** Current interpolated world position of a unit (for picking/FX). */
  positionOf(id: number, now: number): { x: number; y: number } | null {
    const { latest, prev } = this.#reader;
    const li = latest.index.get(id);
    if (li === undefined) return null;
    const alpha = this.#alpha(now);
    const pi = prev.index.get(id);
    // Hidden by fog: report no position at all, which is what keeps
    // picking, hover and band-select from reaching into the dark.
    if (this.#hidden.has(id)) return null;
    // Include the visual de-overlap offset so picking and selection fx
    // land where the unit is drawn, not where the sim has it.
    const v = this.#visuals.get(id);
    const sx = v?.sepX ?? 0;
    const sy = v?.sepY ?? 0;
    if (pi === undefined) return { x: latest.xs[li]! + sx, y: latest.ys[li]! + sy };
    return {
      x: lerp(prev.xs[pi]!, latest.xs[li]!, alpha) + sx,
      y: lerp(prev.ys[pi]!, latest.ys[li]!, alpha) + sy,
    };
  }

  /** All unit ids in the latest publish (for band select). */
  get latestIds(): Map<number, number> {
    return this.#reader.latest.index;
  }

  ownerOf(id: number): number | null {
    const li = this.#reader.latest.index.get(id);
    if (li === undefined) return null;
    return this.#reader.latest.aux[li * AUX_STRIDE + 1]!;
  }

  /** Unit kind code (UNIT_DEFS kindCode), for kind-aware selection. */
  kindOf(id: number): number | null {
    const li = this.#reader.latest.index.get(id);
    if (li === undefined) return null;
    return this.#reader.latest.aux[li * AUX_STRIDE]!;
  }

  /** A corpse: still published, for the length of the death animation. */
  isDead(id: number): boolean {
    const li = this.#reader.latest.index.get(id);
    if (li === undefined) return false;
    return this.#reader.latest.aux[li * AUX_STRIDE + 4] === ACTION.dead;
  }

  #alpha(now: number): number {
    return clamp((now - this.#reader.latestObservedAt) / PUBLISH_INTERVAL_MS, 0, 1);
  }

  update(
    now: number,
    hoverId = -1,
    selected?: ReadonlySet<number>,
    paused = false,
  ): void {
    this.#reader.poll(now);
    const { latest, prev } = this.#reader;
    const alpha = this.#alpha(now);
    const realDt = this.#lastNow > 0 ? Math.min((now - this.#lastNow) / 1000, 0.1) : 1 / 60;
    this.#lastNow = now;
    // A paused game holds its pose: clips stop advancing and the procedural
    // animation clock stops, while interpolation keeps using the real clock
    // (no new publishes arrive, so units simply sit still).
    const dt = paused ? 0 : realDt;
    this.#animNow += dt * 1000;
    const animNow = this.#animNow;
    this.#computeSeparation(latest, prev, alpha);
    this.#hidden.clear();

    for (let i = 0; i < latest.count; i++) {
      const id = latest.ids[i]!;
      const a = i * AUX_STRIDE;
      const kind = latest.aux[a]!;
      const profession = latest.aux[a + 6]!;
      const owner = latest.aux[a + 1]!;
      // Kind, profession, and faction together pick the body (farmer vs
      // plain worker; rival cloth tints). BANDIT (255) folds to slot 15.
      const kindKey = kind | (profession << 8) | ((owner & 0x0f) << 12);
      let visual = this.#visuals.get(id);
      if (visual && visual.kind !== kindKey) {
        // Population economy: a serf can become a worker (or a recruit a
        // soldier) in place — swap the model, keep the entity.
        this.#removeVisual(id, visual);
        visual = undefined;
      }
      if (!visual) {
        const skinned = makeCharacter(kind, profession, owner);
        if (skinned) {
          visual = {
            group: skinned.group,
            kind: kindKey,
            carrying: 0,
            carryBox: null,
            hpBar: null,
            char: skinned.visual,
            rig: null,
            sepX: 0,
            sepY: 0,
          };
        } else {
          const group = makeUnitModel(kind);
          visual = {
            group,
            kind: kindKey,
            carrying: 0,
            carryBox: null,
            hpBar: null,
            char: null,
            rig: rigOf(group),
            sepX: 0,
            sepY: 0,
          };
        }
        this.#visuals.set(id, visual);
        this.#scene.add(visual.group);
      }

      // Enemies vanish in unlit ground. Only current visibility counts —
      // a raider you saw a minute ago is long gone, so unlike a building
      // there is nothing sensible to remember.
      if (this.#fog && latest.aux[a + 1] !== this.#owner) {
        const lit = this.#fog.visibleAt(latest.xs[i]!, latest.ys[i]!);
        visual.group.visible = lit;
        if (!lit) {
          this.#hidden.add(id);
          continue;
        }
      }

      // Health bar when damaged, hovered, or selected.
      const hpPct = latest.aux[a + 2]! / 255;
      const highlighted = id === hoverId || (selected?.has(id) ?? false);
      if ((hpPct < 0.995 || highlighted) && latest.aux[a + 4] !== ACTION.dead) {
        if (!visual.hpBar) {
          visual.hpBar = new THREE.Mesh(hpBarGeometry, hpBarMaterial(hpPct));
          visual.hpBar.position.y = 1.15;
          visual.hpBar.renderOrder = 10;
          visual.group.add(visual.hpBar);
        }
        visual.hpBar.material = hpBarMaterial(hpPct);
        visual.hpBar.scale.x = Math.max(hpPct, 0.05);
      } else if (visual.hpBar) {
        visual.group.remove(visual.hpBar);
        visual.hpBar = null;
      }

      // Visible carried good — the core fantasy, as the actual object:
      // shoulder-pole pails, rice bales, bamboo bundles, ingots, jugs.
      const carrying = latest.aux[a + 3]!;
      if (carrying !== visual.carrying) {
        if (visual.carryBox) {
          visual.carryBox.parent?.remove(visual.carryBox);
          visual.carryBox = null;
        }
        if (carrying > 0) {
          visual.carryBox = makeCarryProp(carrying);
          if (visual.carryBox) {
            const anchor = visual.char?.carryAnchor;
            if (anchor) {
              // Held in front at the chest anchor, riding the gait.
              visual.carryBox.position.set(0, 0, 0);
              anchor.add(visual.carryBox);
            } else {
              visual.group.add(visual.carryBox);
            }
          }
        }
        visual.carrying = carrying;
      }
      const pi = prev.index.get(id);
      const x = pi === undefined ? latest.xs[i]! : lerp(prev.xs[pi]!, latest.xs[i]!, alpha);
      const y = pi === undefined ? latest.ys[i]! : lerp(prev.ys[pi]!, latest.ys[i]!, alpha);

      // Moving? -> walk bob. Standing? -> deterministic de-stacking nudge.
      let moving = false;
      if (pi !== undefined) {
        const dx = latest.xs[i]! - prev.xs[pi]!;
        const dy = latest.ys[i]! - prev.ys[pi]!;
        if (dx * dx + dy * dy > 1e-6) {
          moving = true;
          visual.group.rotation.y = Math.atan2(dx, dy);
        }
      }
      // Animation from what the unit is doing: skinned clips when the GLB
      // assets are loaded, the procedural gait engine otherwise.
      const action = latest.aux[a + 4]!;
      const workKind = latest.aux[a + 5]!;
      const dead = action === ACTION.dead;
      if (dead) moving = false; // corpses don't turn or bob
      // Drawing at a well with a crank: the serf stands beside the windlass
      // and their hand is IK-glued to the grip, so the base pose is a calm
      // idle — the cranking motion IS the crank's.
      const crankWell =
        !dead && !moving && action === ACTION.work && workKind === WORK.draw
          ? this.#nearestWell(x, y)
          : null;
      if (visual.char) {
        const heldCarry = carrying > 0 && carrying !== YOKE_CODE;
        let key: AnimKey;
        if (dead) key = 'death';
        else if (moving)
          key = heldCarry ? 'carry' : visual.char.jog && carrying === 0 ? 'jog' : 'walk';
        else if (action === ACTION.fight) key = visual.char.ranged ? 'shoot' : 'attack';
        else if (action === ACTION.work) key = crankWell ? 'idle' : workAnimKey(workKind);
        else key = heldCarry ? 'carryIdle' : 'idle';
        // Right tool for the job: mallet on sites, pickaxe at rock faces.
        setWorkTool(visual.char, !moving && action === ACTION.work ? workKind : 0);
        if (dead && !visual.char.actions.has('death')) {
          // No death clip in this library: tip the body over instead.
          tipOver(visual.group, dt);
          playAnimation(visual.char, 'idle', hash2(id, 3));
        } else {
          playAnimation(visual.char, key, key === 'death' ? 0 : hash2(id, 3));
        }
        visual.char.mixer.update(dt);
      } else if (visual.rig) {
        if (dead) tipOver(visual.group, dt);
        else animate(visual.rig, id, animNow, moving, action, carrying > 0);
      }

      // Body bob synced to the gait: high at mid-stance, low at heel-strike.
      // (Skinned clips carry their own bob.)
      const bob =
        moving && !visual.char ? Math.abs(Math.cos(animNow * 0.012 + id * 2.1)) * 0.025 : 0;
      // The crank operator's mark: north-east of the handle, side-on to the
      // well, facing south — from the fixed camera the grip and the glued
      // hand stay in front of the body. The snap rides the smoothed
      // de-overlap channel, so picking (positionOf) already follows it.
      if (crankWell) {
        this.#sepTX[i] = crankWell.x + 0.64 - x;
        this.#sepTY[i] = crankWell.z - 0.12 - y;
        visual.group.rotation.y = 0; // face +z, crank at the right hand
      }
      // Ease into this frame's de-overlap offset (corpses keep theirs).
      if (!dead) {
        const k = Math.min(1, dt * 10);
        visual.sepX += (this.#sepTX[i]! - visual.sepX) * k;
        visual.sepY += (this.#sepTY[i]! - visual.sepY) * k;
      }
      const px = x + visual.sepX;
      const pz = y + visual.sepY;
      visual.group.position.set(px, this.#heights.at(px, pz) + bob, pz);
      // Glue the cranking hand to the grip — after the group transform is
      // final for this frame, override the clip's right arm with a CCD
      // reach toward the grip's current world position.
      if (crankWell && visual.char) {
        // Explicitly undefined: ??= assigns on null too, so a rig without
        // the bones re-ran findArm's six name lookups every single frame,
        // which is the one thing the null in the cache is there to stop.
        if (visual.arm === undefined) visual.arm = findArm(visual.group);
        if (visual.arm) {
          crankWell.grip.getWorldPosition(IK_TARGET);
          ikReach(visual.arm, IK_TARGET);
        }
      }
      // Keep the hp bar screen-stable regardless of unit facing.
      if (visual.hpBar && this.cameraQuaternion) {
        // Screen-parallel billboard: cancel the unit's facing, then adopt
        // the (fixed) camera orientation.
        visual.hpBar.quaternion
          .copy(visual.group.quaternion)
          .invert()
          .multiply(this.cameraQuaternion);
      }
    }

    // Dispose visuals whose ids vanished from the latest publish.
    if (this.#visuals.size > latest.count) {
      for (const [id, visual] of this.#visuals) {
        if (!latest.index.has(id)) {
          this.#removeVisual(id, visual);
        }
      }
    }
  }

  /**
   * Remove a unit visual AND free what it uniquely owns on the GPU. The
   * GLB clone shares geometry and materials with the loaded assets, but
   * every SkeletonUtils.clone gets its own Skeleton — and a skeleton
   * lazily allocates a float DataTexture of bone matrices at first
   * render. Removing without disposing leaks one such texture per unit;
   * a long session of combat churn bleeds VRAM until the GPU process
   * dies (Android Chrome's sad-face tab is exactly this).
   */
  #removeVisual(id: number, visual: UnitVisual): void {
    this.#scene.remove(visual.group);
    visual.group.traverse((o) => {
      if (o instanceof THREE.SkinnedMesh) o.skeleton.dispose();
    });
    this.#visuals.delete(id);
  }
}
