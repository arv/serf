import * as THREE from 'three';
import {
  ACTION,
  AUX_STRIDE,
  PUBLISH_INTERVAL_MS,
  WORK,
  type SabReader,
} from '../protocol/sabLayout';
import { clamp, hash2, lerp } from '../shared/math';
import { makeCarryProp, makeUnitModel } from './models';
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
  #lastNow = 0;

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

  update(now: number, hoverId = -1, selected?: ReadonlySet<number>): void {
    this.#reader.poll(now);
    const { latest, prev } = this.#reader;
    const alpha = this.#alpha(now);
    const dt = this.#lastNow > 0 ? Math.min((now - this.#lastNow) / 1000, 0.1) : 1 / 60;
    this.#lastNow = now;

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
        const skinned = makeCharacter(kind);
        if (skinned) {
          visual = {
            group: skinned.group,
            kind,
            carrying: 0,
            carryBox: null,
            hpBar: null,
            char: skinned.visual,
            rig: null,
          };
        } else {
          const group = makeUnitModel(kind);
          visual = {
            group,
            kind,
            carrying: 0,
            carryBox: null,
            hpBar: null,
            char: null,
            rig: rigOf(group),
          };
        }
        this.#visuals.set(id, visual);
        this.#scene.add(visual.group);
      }

      // Health bar when damaged, hovered, or selected.
      const hpPct = latest.aux[a + 2]! / 255;
      const highlighted = id === hoverId || (selected?.has(id) ?? false);
      if ((hpPct < 0.995 || highlighted) && latest.aux[a + 4] !== ACTION.dead) {
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
      if (visual.char) {
        let key: AnimKey;
        if (dead) key = 'death';
        else if (moving) key = visual.char.jog && carrying === 0 ? 'jog' : 'walk';
        else if (action === ACTION.fight) key = visual.char.ranged ? 'shoot' : 'attack';
        else if (action === ACTION.work) key = workAnimKey(workKind);
        else key = 'idle';
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
        else animate(visual.rig, id, now, moving, action, carrying > 0);
      }

      // Body bob synced to the gait: high at mid-stance, low at heel-strike.
      // (Skinned clips carry their own bob.)
      const bob =
        moving && !visual.char ? Math.abs(Math.cos(now * 0.012 + id * 2.1)) * 0.025 : 0;
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
