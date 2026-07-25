import * as THREE from 'three';
import { PUBLISH_INTERVAL_MS, type SabReader } from '../protocol/sabLayout';
import { clamp, hash2, lerp } from '../shared/math';
import { makeCarryProp, makeUnitModel } from './models';
import type { HeightField } from './heightField';

interface UnitVisual {
  group: THREE.Group;
  kind: number;
  carrying: number;
  carryBox: THREE.Object3D | null;
  hpBar: THREE.Mesh | null;
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
    return this.#reader.latest.aux[li * 4 + 1]!;
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
      const kind = latest.aux[i * 4]!;
      let visual = this.#visuals.get(id);
      if (visual && visual.kind !== kind) {
        // Population economy: a serf can become a worker (or a recruit a
        // soldier) in place — swap the model, keep the entity.
        this.#scene.remove(visual.group);
        this.#visuals.delete(id);
        visual = undefined;
      }
      if (!visual) {
        visual = { group: makeUnitModel(kind), kind, carrying: 0, carryBox: null, hpBar: null };
        this.#visuals.set(id, visual);
        this.#scene.add(visual.group);
      }

      // Health bar when damaged.
      const hpPct = latest.aux[i * 4 + 2]! / 255;
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
      const carrying = latest.aux[i * 4 + 3]!;
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
      const bob = moving ? Math.abs(Math.sin(now * 0.012 + id * 1.7)) * 0.045 : 0;
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
