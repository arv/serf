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
import type { ViewBounds } from './cameraRig';
import type { FogQuery } from './fogOfWar';
import { makeCarryProp } from './models';
import {
  makeCharacter,
  playAnimation,
  setWorkTool,
  TOOL_STOWED,
  type AnimKey,
  type CharacterVisual,
} from './characters';
import type { HeightField } from './heightField';

interface UnitVisual {
  group: THREE.Group;
  kind: number;
  carrying: number;
  carryBox: THREE.Object3D | null;
  hpBar: THREE.Mesh | null;
  /** The skinned GLB character driving this unit. */
  char: CharacterVisual | null;
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

/** A standing well: where it is, the windlass that turns, and the handle a
 * drawing serf's hand is glued to. Fed from buildingSync.wellCranks(). */
interface Well {
  x: number;
  z: number;
  crank: THREE.Object3D;
  grip: THREE.Object3D;
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

  /** Built wells' world centers, windlasses + grip handles (from main's
   * structural feed). A drawing serf belongs at the windlass, but the sim
   * parks it on whichever adjacent tile the path found — so the render
   * stands it beside the crank, IK-glues its hand to the grip, and turns
   * the crank under it (see update). */
  #wells: Well[] = [];

  /** Wells whose crank has already been turned this frame, so two haulers
   * drawing at once cannot spin it twice as fast. Cleared, never
   * reallocated. */
  #spun = new Set<THREE.Object3D>();

  setWells(wells: Well[]): void {
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

  #nearestWell(x: number, y: number): Well | null {
    let well: Well | null = null;
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

  // Scratch buffers for the per-frame visual de-overlap pass. The cell
  // arrays are pooled: emptied (length = 0) and refilled each frame rather
  // than reallocated, so steady state allocates nothing per frame. An empty
  // array means "unused this frame".
  #posX = new Float32Array(MAX_UNITS);
  #posY = new Float32Array(MAX_UNITS);
  #sepTX = new Float32Array(MAX_UNITS);
  #sepTY = new Float32Array(MAX_UNITS);
  #cells = new Map<number, number[]>();
  #usedCells: number[] = [];

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
    for (const key of this.#usedCells) this.#cells.get(key)!.length = 0;
    this.#usedCells.length = 0;
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
      if (cell.length === 0) this.#usedCells.push(key);
      cell.push(i);
    }
    for (let i = 0; i < n; i++) {
      if (latest.aux[i * AUX_STRIDE + 4] === ACTION.dead) continue;
      const cx = this.#posX[i]! | 0;
      const cy = this.#posY[i]! | 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const cell = this.#cells.get((cx + dx) * 256 + cy + dy);
          if (!cell || cell.length === 0) continue;
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
    const out = { x: 0, y: 0 };
    return this.positionOfInto(id, now, out) ? out : null;
  }

  /** positionOf without the allocation: writes into `out`; false when the
   * unit is absent from the latest publish or hidden by fog. */
  positionOfInto(id: number, now: number, out: { x: number; y: number }): boolean {
    const { latest, prev } = this.#reader;
    const li = latest.index.get(id);
    if (li === undefined) return false;
    // Hidden by fog: report no position at all, which is what keeps
    // picking, hover and band-select from reaching into the dark.
    if (this.#hidden.has(id)) return false;
    // Include the visual de-overlap offset so picking and selection fx
    // land where the unit is drawn, not where the sim has it.
    const v = this.#visuals.get(id);
    const sx = v?.sepX ?? 0;
    const sy = v?.sepY ?? 0;
    const pi = prev.index.get(id);
    if (pi === undefined) {
      out.x = latest.xs[li]! + sx;
      out.y = latest.ys[li]! + sy;
      return true;
    }
    const alpha = this.#alpha(now);
    out.x = lerp(prev.xs[pi]!, latest.xs[li]!, alpha) + sx;
    out.y = lerp(prev.ys[pi]!, latest.ys[li]!, alpha) + sy;
    return true;
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
    bounds?: ViewBounds,
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
    this.#spun.clear();

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
        // Assets are guaranteed by boot (the loaders retry and then fail
        // the whole boot loudly) — a miss here is a programming error, not
        // a network condition, and the old silent fallback to the
        // procedural person hid exactly that difference.
        const skinned = makeCharacter(kind, profession, owner);
        if (!skinned) throw new Error(`no character for kind ${kind}`);
        visual = {
          group: skinned.group,
          kind: kindKey,
          carrying: 0,
          carryBox: null,
          hpBar: null,
          char: skinned.visual,
          sepX: 0,
          sepY: 0,
        };
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

      const pi = prev.index.get(id);
      const x = pi === undefined ? latest.xs[i]! : lerp(prev.xs[pi]!, latest.xs[i]!, alpha);
      const y = pi === undefined ? latest.ys[i]! : lerp(prev.ys[pi]!, latest.ys[i]!, alpha);
      // Off-screen units keep position/rotation fresh but skip everything
      // cosmetic — clip selection, mixer sampling, tools, IK, hp bars.
      // Purely visual: nothing here feeds back into the sim or picking.
      const offScreen =
        bounds !== undefined &&
        (x < bounds.minX || x > bounds.maxX || y < bounds.minZ || y > bounds.maxZ);

      // Health bar when damaged, hovered, or selected.
      if (!offScreen) {
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
      }

      // Visible carried good — the core fantasy, as the actual object:
      // pack buckets, grain sacks, lumber, ingots, casks.
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
        !offScreen && !dead && !moving && action === ACTION.work && workKind === WORK.draw
          ? this.#nearestWell(x, y)
          : null;
      // The windlass turns because someone is winding it, and only then.
      // Axle along x; one revolution per loop of the reeling clip (1.6 s),
      // both advancing on the same render dt, so the grip stays under the
      // hands glued to it. Once per well per frame — two serfs drawing at
      // one well are two buckets, not double speed.
      if (crankWell && dt > 0 && !this.#spun.has(crankWell.crank)) {
        this.#spun.add(crankWell.crank);
        crankWell.crank.rotation.x += dt * ((Math.PI * 2) / 1.6);
      }
      if (visual.char && offScreen) {
        // Culled: drop the current clip so re-entry restarts it cleanly
        // (playAnimation is a no-op while `current` matches).
        visual.char.current = null;
      } else if (visual.char) {
        const heldCarry = carrying > 0;
        let key: AnimKey;
        if (dead) key = 'death';
        else if (moving) key = heldCarry ? 'carry' : visual.char.jog ? 'jog' : 'walk';
        else if (action === ACTION.fight) key = visual.char.ranged ? 'shoot' : 'attack';
        else if (action === ACTION.work) key = crankWell ? 'idle' : workAnimKey(workKind);
        else key = heldCarry ? 'carryIdle' : 'idle';
        // Right tool for the job: mallet on sites, pickaxe at rock faces,
        // carried on the walk out too — a woodcutter heads to the trees
        // axe in fist. Only full hands stow it: cargo owns the grip.
        setWorkTool(visual.char, heldCarry ? TOOL_STOWED : workKind);
        if (dead && !visual.char.actions.has('death')) {
          // No death clip in this library: tip the body over instead.
          tipOver(visual.group, dt);
          playAnimation(visual.char, 'idle', hash2(id, 3));
        } else {
          playAnimation(visual.char, key, key === 'death' ? 0 : hash2(id, 3));
        }
        visual.char.mixer.update(dt);
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
      if (!offScreen && visual.hpBar && this.cameraQuaternion) {
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
