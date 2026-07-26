import * as THREE from 'three';
import { ACTION, AUX_STRIDE, PUBLISH_INTERVAL_MS, type SabReader } from '../protocol/sabLayout';
import { clamp, hash2, lerp } from '../shared/math';
import { makeCarryProp, makeUnitModel } from './models';
import type { HeightField } from './heightField';

/** Named limb pivots of an articulated person (see models.ts person()). */
interface Rig {
  legL: THREE.Object3D | undefined;
  legR: THREE.Object3D | undefined;
  armL: THREE.Object3D | undefined;
  armR: THREE.Object3D | undefined;
  torso: THREE.Object3D | undefined;
}

interface UnitVisual {
  group: THREE.Group;
  kind: number;
  carrying: number;
  carryBox: THREE.Object3D | null;
  hpBar: THREE.Mesh | null;
  rig: Rig;
}

function rigOf(group: THREE.Group): Rig {
  return {
    legL: group.getObjectByName('legL'),
    legR: group.getObjectByName('legR'),
    armL: group.getObjectByName('armL'),
    armR: group.getObjectByName('armR'),
    torso: group.getObjectByName('torso'),
  };
}

/**
 * Procedural limb animation: what you do is what you show. Phase offsets by
 * id keep a crowd from moving in lockstep.
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
    if (rig.legL) rig.legL.rotation.x = swing * 0.62;
    if (rig.legR) rig.legR.rotation.x = -swing * 0.62;
    if (carrying) {
      // Hands steadying the load on the shoulders.
      if (rig.armL) rig.armL.rotation.x = -2.6;
      if (rig.armR) rig.armR.rotation.x = -2.6;
    } else {
      if (rig.armL) rig.armL.rotation.x = -swing * 0.4;
      if (rig.armR) rig.armR.rotation.x = swing * 0.4;
    }
    if (rig.torso) {
      rig.torso.rotation.x = 0.06;
      rig.torso.rotation.y = 0;
    }
    return;
  }

  if (action === ACTION.work) {
    // Two-beat chop/hammer: slow raise, fast fall.
    const t = (now * 0.0016 + id * 0.37) % 1;
    const lift = t < 0.7 ? t / 0.7 : 1 - (t - 0.7) / 0.3;
    if (rig.armR) rig.armR.rotation.x = -0.35 - lift * 1.75;
    if (rig.armL) rig.armL.rotation.x = -0.2 - lift * 0.25;
    if (rig.torso) {
      rig.torso.rotation.x = 0.1 + lift * 0.14;
      rig.torso.rotation.y = 0;
    }
    if (rig.legL) rig.legL.rotation.x = 0.12;
    if (rig.legR) rig.legR.rotation.x = -0.12;
    return;
  }

  if (action === ACTION.fight) {
    // Aggressive slashing: fast overhead swings with torso twist.
    const t = (now * 0.004 + id * 0.61) % 1;
    const swing = t < 0.35 ? t / 0.35 : 1 - (t - 0.35) / 0.65;
    if (rig.armR) rig.armR.rotation.x = -0.5 - swing * 1.9;
    if (rig.armL) rig.armL.rotation.x = -0.4 + swing * 0.3;
    if (rig.torso) {
      rig.torso.rotation.y = -0.2 + swing * 0.45;
      rig.torso.rotation.x = 0.08;
    }
    if (rig.legL) rig.legL.rotation.x = 0.28;
    if (rig.legR) rig.legR.rotation.x = -0.28;
    return;
  }

  // Idle: everything settles; a faint breath keeps them alive.
  const settle = Math.sin(now * 0.002 + id) * 0.03;
  if (rig.legL) rig.legL.rotation.x = 0;
  if (rig.legR) rig.legR.rotation.x = 0;
  if (rig.armL) rig.armL.rotation.x = carrying ? -2.6 : settle;
  if (rig.armR) rig.armR.rotation.x = carrying ? -2.6 : -settle;
  if (rig.torso) {
    rig.torso.rotation.x = 0.02 + settle;
    rig.torso.rotation.y = 0;
  }
}

const hpBarGeometry = new THREE.PlaneGeometry(0.5, 0.06);
const hpBarMaterials = new Map<number, THREE.MeshBasicMaterial>();

function hpBarMaterial(pct: number): THREE.MeshBasicMaterial {
  // Bucketed green->red so materials are shared.
  const bucket = Math.max(0, Math.min(4, Math.floor(pct * 5)));
  let mat = hpBarMaterials.get(bucket);
  if (!mat) {
    const color = new THREE.Color().setHSL(0.33 * (bucket / 4), 0.8, 0.45);
    mat = new THREE.MeshBasicMaterial({ color, depthTest: false });
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

  constructor(scene: THREE.Scene, reader: SabReader, heights: HeightField) {
    this.#scene = scene;
    this.#reader = reader;
    this.#heights = heights;
  }

  /** Current interpolated world position of a unit (for picking/FX). */
  positionOf(id: number, now: number): { x: number; y: number } | null {
    const { latest, prev } = this.#reader;
    const li = latest.index.get(id);
    if (li === undefined) return null;
    const alpha = this.#alpha(now);
    const pi = prev.index.get(id);
    if (pi === undefined) return { x: latest.xs[li]!, y: latest.ys[li]! };
    return {
      x: lerp(prev.xs[pi]!, latest.xs[li]!, alpha),
      y: lerp(prev.ys[pi]!, latest.ys[li]!, alpha),
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

  #alpha(now: number): number {
    return clamp((now - this.#reader.latestObservedAt) / PUBLISH_INTERVAL_MS, 0, 1);
  }

  update(now: number): void {
    this.#reader.poll(now);
    const { latest, prev } = this.#reader;
    const alpha = this.#alpha(now);

    for (let i = 0; i < latest.count; i++) {
      const id = latest.ids[i]!;
      const a = i * AUX_STRIDE;
      const kind = latest.aux[a]!;
      let visual = this.#visuals.get(id);
      if (visual && visual.kind !== kind) {
        // Population economy: a serf can become a worker (or a recruit a
        // soldier) in place — swap the model, keep the entity.
        this.#scene.remove(visual.group);
        this.#visuals.delete(id);
        visual = undefined;
      }
      if (!visual) {
        const group = makeUnitModel(kind);
        visual = { group, kind, carrying: 0, carryBox: null, hpBar: null, rig: rigOf(group) };
        this.#visuals.set(id, visual);
        this.#scene.add(visual.group);
      }

      // Health bar when damaged.
      const hpPct = latest.aux[a + 2]! / 255;
      if (hpPct < 0.995) {
        if (!visual.hpBar) {
          visual.hpBar = new THREE.Mesh(hpBarGeometry, hpBarMaterial(hpPct));
          visual.hpBar.position.y = 1.15;
          visual.hpBar.rotation.x = -Math.PI / 5;
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
          visual.group.remove(visual.carryBox);
          visual.carryBox = null;
        }
        if (carrying > 0) {
          visual.carryBox = makeCarryProp(carrying);
          if (visual.carryBox) visual.group.add(visual.carryBox);
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
      // Limb animation from what the unit is doing.
      animate(visual.rig, id, now, moving, latest.aux[a + 4]!, carrying > 0);

      const bob = moving ? Math.abs(Math.sin(now * 0.024 + id * 1.7)) * 0.03 : 0;
      const nudgeX = moving ? 0 : (hash2(id, 1) - 0.5) * 0.24;
      const nudgeY = moving ? 0 : (hash2(id, 2) - 0.5) * 0.24;
      const px = x + nudgeX;
      const pz = y + nudgeY;
      visual.group.position.set(px, this.#heights.at(px, pz) + bob, pz);
      // Keep the hp bar screen-stable regardless of unit facing.
      if (visual.hpBar) visual.hpBar.rotation.y = Math.PI / 4 - visual.group.rotation.y;
    }

    // Dispose visuals whose ids vanished from the latest publish.
    if (this.#visuals.size > latest.count) {
      for (const [id, visual] of this.#visuals) {
        if (!latest.index.has(id)) {
          this.#scene.remove(visual.group);
          this.#visuals.delete(id);
        }
      }
    }
  }
}
