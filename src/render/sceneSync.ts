import * as THREE from 'three';
import {animCue, LOOP_CUES} from '../audio/animCues';
import type {CueId} from '../audio/cues';
import {
  ACTION,
  AUX_STRIDE,
  MAX_UNITS,
  PUBLISH_INTERVAL_MS,
  WORK,
  type SabReader,
} from '../protocol/sabLayout';
import type {Enum} from '../shared/enum.ts';
import {clamp, hash2, lerp} from '../shared/math';
import {UNIT_DEFS} from '../sim/defs/units';
import * as UnitTypeId from '../sim/defs/unitTypeIdEnum.ts';
import * as AnimKey from './animKeyEnum.ts';
import {crossedRelease} from './arrows';
import type {FieldInfo, PierInfo} from './buildingSync';
import type {ViewBounds} from './cameraRig';
import {
  TARGET_HEIGHT,
  gaitAnimKey,
  updateBow,
  makeCharacter,
  playAnimation,
  setGaitSpeed,
  setWorkTool,
  TOOL_STOWED,
  type CharacterVisual,
} from './characters';
import type {FogQuery} from './fogOfWar';
import type {HeightField} from './heightField';
import {makeCarryProp} from './models';

type AnimKey = Enum<typeof AnimKey>;

interface UnitVisual {
  group: THREE.Group;
  kind: number;
  carrying: number;
  carryBox: THREE.Object3D | null;
  /** The skinned GLB character driving this unit. */
  char: CharacterVisual | null;
  /** Smoothed visual de-overlap offset — render-only; the sim's positions
   * stay untouched. The sim keeps soldiers apart itself (separation.ts);
   * this is what keeps serfs, who walk through everyone, from being drawn
   * inside one another. */
  sepX: number;
  sepY: number;
  /** Low-passed observed ground speed feeding the gait rate (0 = never
   * moved). Raw publish deltas step at path starts/ends and task
   * boundaries, and legs snapping rate with them read as a hiccup. */
  speedSm: number;
  /**
   * The audio layer's own last-clip memory — deliberately NOT
   * `char.current`, which the off-screen cull nulls so re-entry restarts
   * the clip cleanly. Audio must not inherit that: a null-and-replay on
   * every camera pan would machine-gun re-entry cues. This one survives
   * culling and only ever changes on screen (animCues.ts owns the
   * transition rules).
   */
  audioKey: AnimKey | null;
  /** A clip restart whose entry-cycle impacts are still owed: the restart
   * happened on a paused frame (dt 0), where scheduling would strike over
   * a frozen battlefield. Consumed on the first advancing frame. */
  entryPending: boolean;
  /** Last on-screen world position, for the mixer-loop percussion —
   * the 'loop' event fires inside mixer.update, after the per-unit loop's
   * locals are gone. */
  ax: number;
  az: number;
  /** The mixer 'loop' listener, kept for symmetric removal. */
  loopCb?: (e: {action: THREE.AnimationAction}) => void;
  /** The shoot clip's time last frame, while this unit is loosing —
   * how the arrow spawn sees the release phase go by (undefined
   * whenever the unit is not shooting, so a stale time can never read
   * as a crossing). */
  shootT?: number;
  /** Right-arm bone chain for the well-crank IK. undefined = not looked
   * up yet, null = this rig has no such bones. */
  arm?: ArmChain | null;
  /** Mowing-walk state (the farmer on his field): which circuit point he
   * is walking toward, the ping-pong direction, ground left to cover
   * before the next stroke, and the anim-clock time his current stroke
   * runs to (undefined = not mid-stroke). */
  mowI?: number;
  mowDir?: 1 | -1;
  mowStepLeft?: number;
  mowSwingUntil?: number;
  /** Low-pass on the farm's working flag: a convert batch ends with one
   * idle tick before the next begins, and honest per-publish reading made
   * the farmer hiccup to a stand every ten seconds. Work seen now keeps
   * him mowing this long; a truly stalled farm still stops him inside
   * half a second. */
  mowWorkUntil?: number;
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

/** The render-walk speed of a worker moved by the render rather than the
 * sim — out along the pier, along the farm's mowing lanes — the worker's
 * own sim gait, so the commute reads like every other one. */
const RENDER_WALK_SPEED = UNIT_DEFS[UnitTypeId.worker].speed;

/** Ground a mowing farmer covers between scythe strokes: step, swing,
 * step — the working rhythm, in world units. */
const MOW_STEP = 0.55;

/** How long the farm's working flag coasts (ms) — see mowWorkUntil. */
const MOW_WORK_COAST = 400;

/** GLTFLoader sanitizes bone names ('upperarm.r' → 'upperarmr'). */
function findArm(group: THREE.Group): ArmChain | null {
  const bone = (n: string): THREE.Object3D | undefined =>
    group.getObjectByName(n) ?? group.getObjectByName(n.replace(/[^\w-]/g, ''));
  const upper = bone('upperarm.r');
  const lower = bone('lowerarm.r');
  const hand = bone('hand.r');
  return upper && lower && hand ? {upper, lower, hand} : null;
}

const IK_B = new THREE.Vector3();
const IK_E = new THREE.Vector3();
const IK_D = new THREE.Vector3();
const IK_Q = new THREE.Quaternion();
const IK_PQ = new THREE.Quaternion();
const IK_PQI = new THREE.Quaternion();
const IK_TARGET = new THREE.Vector3();

/** One CCD step: swing `bone` so `tip` aims at `target` (world space). */
function aimBone(
  bone: THREE.Object3D,
  tip: THREE.Object3D,
  target: THREE.Vector3,
): void {
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
      return AnimKey.pickaxe;
    case WORK.hammer:
      return AnimKey.hammer;
    case WORK.dig:
      return AnimKey.dig;
    case WORK.tend:
      return AnimKey.tend;
    case WORK.draw:
      return AnimKey.draw;
    case WORK.fish:
      return AnimKey.fish;
    case WORK.mow:
      return AnimKey.mow;
    default:
      return AnimKey.work;
  }
}

/** Fallback "death animation" for rigs with no death clip: keel over. */
function tipOver(group: THREE.Object3D, dt: number): void {
  group.rotation.x = Math.max(group.rotation.x - dt * 4, -Math.PI / 2);
}

const hpBarGeometry = new THREE.PlaneGeometry(0.5, 0.06);

/** Just clear of a villager's head — derived, so it cannot drift from him. */
const HP_BAR_Y = TARGET_HEIGHT * 0.943;

/**
 * The same bucketed green->red ramp the bars have always used, resolved
 * once instead of on demand. The bucketing used to exist so that five
 * materials could be shared between bars; the bars are one instanced mesh
 * now and the colour rides per instance, but the five steps stay exactly
 * as they were — this is a draw-call change, not a palette change.
 */
const HP_BUCKET_COLORS = Array.from({length: 5}, (_, bucket) =>
  new THREE.Color().setHSL(0.33 * (bucket / 4), 0.8, 0.45),
);

function hpBucket(pct: number): number {
  return Math.max(0, Math.min(4, Math.floor(pct * 5)));
}

/** White, so the per-instance colour comes through unmultiplied. */
const hpBarMaterial = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  depthTest: false,
  userData: {noFog: true},
});

// Scratch for composing one bar's instance matrix.
const HP_POS = new THREE.Vector3();
const HP_SCALE = new THREE.Vector3(1, 1, 1);
const HP_MATRIX = new THREE.Matrix4();
/** Stands in for the camera before boot has handed one over. */
const HP_IDENTITY = new THREE.Quaternion();

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
  /** Live reference to the camera's orientation, set at boot — the very
   * quaternion the rig turns, so the bars follow a turned camera; hp bars
   * copy it to stay parallel with the screen plane. */
  cameraQuaternion: THREE.Quaternion | null = null;

  /**
   * Presentation cue channel, injected from main like the fog and wells —
   * the render sync decides *when* something is worth hearing (it alone
   * knows position, culling and clip phase), the audio layer decides
   * whether it actually sounds. `delaySec` schedules ahead: a mixer
   * 'loop' event fires at the clip's wrap point, but the axe lands
   * mid-clip, and Web Audio keeps that appointment exactly.
   */
  onCue: ((cue: CueId, x: number, z: number, delaySec: number) => void) | null =
    null;

  /**
   * Arrow channel, injected like onCue: the sync knows the instant a
   * ranged unit's string hand lets go (the same clip phase the bow twang
   * fires on) and where archer and mark stand; the arrows layer owns the
   * flight from there. Ground coordinates, from the archer to the target
   * point rebuilt from the publish's facing + targetDist bytes.
   */
  onArrow:
    | ((fromX: number, fromZ: number, toX: number, toZ: number) => void)
    | null = null;

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

  /** Built fisheries' piers (from main's structural feed). The resident
   * fisherman belongs at the end of his pier, but the sim parks him on
   * whichever adjacent tile the path found — so the render walks him out
   * along the deck and stands him there, line in the water. */
  #piers: PierInfo[] = [];

  setPiers(piers: PierInfo[]): void {
    this.#piers = piers;
  }

  /** Built wheat farms' fields (from the same structural feed). The
   * resident farmer belongs in his rows: while the farm works, the
   * render walks him along the field's mowing circuit and swings the
   * scythe at each stop — the sim keeps him parked like the fisherman. */
  #fields: FieldInfo[] = [];

  setFields(fields: FieldInfo[]): void {
    this.#fields = fields;
  }

  /** Fog test; enemies standing in unlit ground are not drawn at all. */
  #fog: FogQuery | null = null;

  setFog(fog: FogQuery): void {
    this.#fog = fog;
  }

  /** Ids currently hidden by fog — picking and selection skip them. */
  #hidden = new Set<number>();

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

  #nearestPier(x: number, y: number): PierInfo | null {
    let pier: PierInfo | null = null;
    let best = 9; // parked on the ring around a 3x3 footprint: within 3 tiles
    for (const p of this.#piers) {
      const dx = p.bx - x;
      const dz = p.bz - y;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) {
        best = d2;
        pier = p;
      }
    }
    return pier;
  }

  #nearestField(x: number, y: number): FieldInfo | null {
    let field: FieldInfo | null = null;
    let best = 9; // same ring as the pier: the farm is 3x3 too
    for (const f of this.#fields) {
      const dx = f.bx - x;
      const dz = f.bz - y;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) {
        best = d2;
        field = f;
      }
    }
    return field;
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
   * Where each unit sat in the previous publish, by its index in the
   * latest one; -1 for a unit that is new this publish. Filled by
   * #computeSeparation, which already has to do the lookup, so the frame
   * loop below can skip a hashed Map.get per unit per frame.
   */
  #prevIdx = new Int32Array(MAX_UNITS);
  /**
   * Every unit health bar in one draw call.
   *
   * A bar is a quad the size of a postage stamp, and each one used to be
   * its own Mesh parented to its unit — so band-selecting an army added a
   * draw call per soldier, and the five hp colours split even those into
   * separate material groups. As one InstancedMesh it is a single call at
   * any army size, with the colour per instance.
   *
   * Rebuilt from scratch each frame: `#hpBarCount` is the write cursor,
   * and `count` at the end is how many of the buffer three should draw.
   * Frustum culling is off because the bounding sphere describes the
   * geometry at the origin, not where the instances actually are.
   */
  #hpBars = new THREE.InstancedMesh(hpBarGeometry, hpBarMaterial, MAX_UNITS);
  #hpBarCount = 0;

  /**
   * Soft visual separation: units drawn closer than SEP_RADIUS get pushed
   * apart a little (capped, smoothed by the caller). Purely cosmetic. The
   * sim holds soldiers further apart than this on its own (separation.ts,
   * SEPARATION), so for them it is a no-op; civilians have no collision in
   * the sim — hauling must never jam — and this is all that keeps two serfs
   * on one tile from being drawn as one.
   */
  #computeSeparation(
    latest: {
      count: number;
      xs: Float32Array;
      ys: Float32Array;
      aux: Uint8Array;
      index: Map<number, number>;
      ids: Int32Array;
    },
    prev: {xs: Float32Array; ys: Float32Array; index: Map<number, number>},
    alpha: number,
  ): void {
    // Both are body-width measures, so they ride the villager's height
    // rather than sitting as literals that quietly stop matching him.
    const SEP_RADIUS = TARGET_HEIGHT * 0.361;
    const MAX_PUSH = TARGET_HEIGHT * 0.279;
    const n = latest.count;
    for (const key of this.#usedCells) this.#cells.get(key)!.length = 0;
    this.#usedCells.length = 0;
    for (let i = 0; i < n; i++) {
      const id = latest.ids[i]!;
      const pi = prev.index.get(id);
      this.#prevIdx[i] = pi === undefined ? -1 : pi;
      this.#posX[i] =
        pi === undefined
          ? latest.xs[i]!
          : lerp(prev.xs[pi]!, latest.xs[i]!, alpha);
      this.#posY[i] =
        pi === undefined
          ? latest.ys[i]!
          : lerp(prev.ys[pi]!, latest.ys[i]!, alpha);
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
              const ang =
                hash2(latest.ids[i]! * 31 + latest.ids[j]!, 5) * Math.PI * 2;
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
      const m2 =
        this.#sepTX[i]! * this.#sepTX[i]! + this.#sepTY[i]! * this.#sepTY[i]!;
      if (m2 > MAX_PUSH * MAX_PUSH) {
        const s = MAX_PUSH / Math.sqrt(m2);
        this.#sepTX[i]! *= s;
        this.#sepTY[i]! *= s;
      }
    }
  }

  constructor(scene: THREE.Scene, reader: SabReader, heights: HeightField) {
    this.#scene = scene;
    this.#reader = reader;
    this.#heights = heights;
    // Same draw state the per-unit meshes carried: over everything, never
    // depth-tested, never fogged.
    this.#hpBars.renderOrder = 10;
    this.#hpBars.frustumCulled = false;
    this.#hpBars.count = 0;
    scene.add(this.#hpBars);
  }

  /** Current interpolated world position of a unit (for picking/FX). */
  positionOf(id: number, now: number): {x: number; y: number} | null {
    const out = {x: 0, y: 0};
    return this.positionOfInto(id, now, out) ? out : null;
  }

  /** positionOf without the allocation: writes into `out`; false when the
   * unit is absent from the latest publish or hidden by fog. */
  positionOfInto(
    id: number,
    now: number,
    out: {x: number; y: number},
  ): boolean {
    const {latest, prev} = this.#reader;
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

  /**
   * Which publish the reads below are answering from. The worker publishes
   * twenty times a second and the loop runs at sixty-odd: anything derived
   * from the buffer rather than interpolated across it — the selection
   * card's roster — can sit out the frames in between.
   */
  get publishSeq(): number {
    return this.#reader.latest.publishSeq;
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

  /** Unit kind (UnitTypeId — its own SAB byte), for kind-aware selection. */
  kindOf(id: number): number | null {
    const li = this.#reader.latest.index.get(id);
    if (li === undefined) return null;
    return this.#reader.latest.aux[li * AUX_STRIDE]!;
  }

  /**
   * How much of this unit is left, as the raw aux byte (0..255 = none..full).
   * A fraction of the unit's OWN full health, which is not their kind's —
   * armour research musters a soldier above it. The selection card turns it
   * back into hitpoints against `maxHpOf`, the same arithmetic the hp bar
   * over their head does, drawn in words for the one (or twenty) the player
   * has picked up.
   */
  hpPctOf(id: number): number | null {
    const li = this.#reader.latest.index.get(id);
    if (li === undefined) return null;
    return this.#reader.latest.aux[li * AUX_STRIDE + 2]!;
  }

  /**
   * This unit's own full health, in hitpoints — what `hpPctOf` is a fraction
   * OF. Armour research musters a soldier above his kind's number (a knight
   * at 120 against a base of 80), so the kind's def cannot answer this; the
   * sim publishes the man's own (UnitSnapshot.maxHp). Saturates at 255. Null
   * when the unit is not in the latest publish.
   */
  maxHpOf(id: number): number | null {
    const li = this.#reader.latest.index.get(id);
    if (li === undefined) return null;
    return this.#reader.latest.aux[li * AUX_STRIDE + 9]!;
  }

  /**
   * Holding ground (UnitTaskKind.hold), as the sim last published it. The
   * card lights its Hold button off this; false for a man who is not, for
   * one mid-swing (he publishes `fight` while an enemy is in reach, stance
   * or no stance), and for an id not in the latest publish.
   */
  isHolding(id: number): boolean {
    const li = this.#reader.latest.index.get(id);
    if (li === undefined) return false;
    return this.#reader.latest.aux[li * AUX_STRIDE + 4] === ACTION.hold;
  }

  /** A corpse: still published, for the length of the death animation. */
  isDead(id: number): boolean {
    const li = this.#reader.latest.index.get(id);
    if (li === undefined) return false;
    return this.#reader.latest.aux[li * AUX_STRIDE + 4] === ACTION.dead;
  }

  /**
   * Nearest living enemy of `owner` within `radius` of (x, z), from the
   * latest publish — the render-side stand-in for the sim's tower
   * acquisition, for volleys whose shooter is not a unit: a garrisoned
   * soldier was consumed into his building, and which enemy the tower
   * picked never reaches the client. Nearest is not always the sim's
   * exact pick (its scoring also favors countered classes), but both
   * stand inside the same volley radius, which is all a half-second
   * flight can be wrong by. Fog-hidden units are skipped so a volley
   * never points into ground the viewer cannot see into. False when
   * nobody qualifies; `out` is untouched then.
   */
  nearestEnemyInto(
    x: number,
    z: number,
    owner: number,
    radius: number,
    out: {x: number; y: number},
  ): boolean {
    const {latest} = this.#reader;
    let bestSq = radius * radius;
    let found = false;
    for (let i = 0; i < latest.count; i++) {
      const a = i * AUX_STRIDE;
      if (latest.aux[a + 1] === owner) continue;
      if (latest.aux[a + 4] === ACTION.dead) continue;
      if (this.#hidden.has(latest.ids[i]!)) continue;
      const dx = latest.xs[i]! - x;
      const dz = latest.ys[i]! - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > bestSq) continue;
      bestSq = d2;
      out.x = latest.xs[i]!;
      out.y = latest.ys[i]!;
      found = true;
    }
    return found;
  }

  #alpha(now: number): number {
    return clamp(
      (now - this.#reader.latestObservedAt) / PUBLISH_INTERVAL_MS,
      0,
      1,
    );
  }

  update(
    now: number,
    hoverId = -1,
    selected?: ReadonlySet<number>,
    paused = false,
    bounds?: ViewBounds,
  ): void {
    this.#reader.poll(now);
    const {latest, prev} = this.#reader;
    const alpha = this.#alpha(now);
    const realDt =
      this.#lastNow > 0 ? Math.min((now - this.#lastNow) / 1000, 0.1) : 1 / 60;
    this.#lastNow = now;
    // A paused game holds its pose: clips stop advancing and the procedural
    // animation clock stops, while interpolation keeps using the real clock
    // (no new publishes arrive, so units simply sit still).
    const dt = paused ? 0 : realDt;
    this.#animNow += dt * 1000;
    const animNow = this.#animNow;
    this.#computeSeparation(latest, prev, alpha);
    // The bars are rebuilt from scratch every frame, so the cursor starts
    // over. camQuat is the screen plane: the rig's live orientation.
    this.#hpBarCount = 0;
    const camQuat = this.cameraQuaternion ?? HP_IDENTITY;
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
          char: skinned.visual,
          sepX: 0,
          sepY: 0,
          speedSm: 0,
          audioKey: null,
          entryPending: false,
          ax: latest.xs[i]!,
          az: latest.ys[i]!,
        };
        this.#visuals.set(id, visual);
        this.#scene.add(visual.group);
        this.#attachLoopCues(visual);
      }

      // Enemies vanish in unlit ground. Only current visibility counts —
      // a raider you saw a minute ago is long gone, so unlike a building
      // there is nothing sensible to remember.
      // Whose side is exempt is the fog's own question — it is the seat
      // the map is drawn through, and in a replay that seat moves.
      if (this.#fog && latest.aux[a + 1] !== this.#fog.owner) {
        const lit = this.#fog.visibleAt(latest.xs[i]!, latest.ys[i]!);
        visual.group.visible = lit;
        if (!lit) {
          this.#hidden.add(id);
          continue;
        }
      }

      // Both the lookup and the two lerps were already done, for this same
      // unit on this same frame, by #computeSeparation (which runs first
      // and stores them). -1 is its "not in the previous publish" marker.
      const prevI = this.#prevIdx[i]!;
      const pi = prevI < 0 ? undefined : prevI;
      const x = this.#posX[i]!;
      const y = this.#posY[i]!;
      // Off-screen units skip everything cosmetic — clip selection, mixer
      // sampling, tools, IK, hp bars. Purely visual: nothing here feeds
      // back into the sim or picking.
      const offScreen =
        bounds !== undefined &&
        (x < bounds.minX ||
          x > bounds.maxX ||
          y < bounds.minZ ||
          y > bounds.maxZ);
      // ...and they leave the scene graph too. Skipping the work above
      // still left every one of them a visible object, so the renderer
      // walked its whole rig each frame — every bone, every skinned mesh,
      // a bounding-sphere frustum test apiece — to conclude it was not on
      // screen. `visible = false` makes three stop at the group.
      //
      // Safe because nothing outside this loop reads the scene graph for a
      // unit: picking is analytic (input/picking.ts) and goes through
      // positionOfInto, which reads the publish buffers. Note this is NOT
      // the fog rule — a fogged enemy is added to #hidden and vanishes from
      // picking too, which is the point of fog; being off-camera must
      // never do that, or a drag-select would drop what it caught.
      //
      // Enemies already had `visible` set from the fog above, and a unit
      // that failed that test never reaches here.
      visual.group.visible = !offScreen;

      // Health bar when damaged, hovered, or selected. Decided here, where
      // the hp and the highlight are to hand; written into the instanced
      // mesh below, once this unit's final position is known. The byte is
      // the man's own fraction (UnitSnapshot.hpPct), so an armoured soldier's
      // bar drops on his first wound rather than at his kind's full health.
      let barPct = -1;
      if (!offScreen) {
        const hpPct = latest.aux[a + 2]! / 255;
        const highlighted = id === hoverId || (selected?.has(id) ?? false);
        if ((hpPct < 0.995 || highlighted) && latest.aux[a + 4] !== ACTION.dead)
          barPct = hpPct;
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
          // Feed the gait the speed actually covered — the base kind speed
          // its rate was seeded with misses road/trail multipliers and the
          // serfSpeed tech. prev and latest are adjacent publishes, one
          // interval apart, the same window the interpolation draws by.
          // Low-passed (~quarter-second) because a walk's first and last
          // windows are partial: raw, they'd yank the legs slow for one
          // publish at every start and stop.
          if (visual.char) {
            const sp = Math.hypot(dx, dy) * (1000 / PUBLISH_INTERVAL_MS);
            visual.speedSm =
              visual.speedSm > 0
                ? visual.speedSm + (sp - visual.speedSm) * Math.min(1, dt * 4)
                : sp;
            setGaitSpeed(visual.char, visual.speedSm);
          }
        }
      }
      // Animation from what the unit is doing: skinned clips when the GLB
      // assets are loaded, the procedural gait engine otherwise.
      const action = latest.aux[a + 4]!;
      const workKind = latest.aux[a + 5]!;
      const dead = action === ACTION.dead;
      if (dead) moving = false; // corpses don't turn or bob
      // A fighter who has stopped to swing has no movement delta to face by,
      // so it would keep the yaw it walked in with and hack at the air beside
      // its enemy. The sim sends the bearing to whatever it is actually
      // hitting; a chaser is still moving, so this only lands once it stands.
      if (!moving && !dead && action === ACTION.fight) {
        visual.group.rotation.y = (latest.aux[a + 7]! / 256) * Math.PI * 2;
      }
      // Drawing at a well with a crank: the serf stands beside the windlass
      // and their hand is IK-glued to the grip, so the base pose is a calm
      // idle — the cranking motion IS the crank's.
      const crankWell =
        !offScreen &&
        !dead &&
        !moving &&
        action === ACTION.work &&
        workKind === WORK.draw
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
      // The fisherman's post is the end of his pier: while he holds it
      // (mid-batch or stalled on a full buffer alike), the render walks
      // him out along the deck and stands him at the spot, line in the
      // water. Render-side like the well crank — the sim keeps him parked
      // on whatever adjacent tile the path found.
      const pier =
        !offScreen &&
        !dead &&
        !moving &&
        action !== ACTION.fight &&
        workKind === WORK.fish
          ? this.#nearestPier(x, y)
          : null;
      let fishing = false;
      let onDeck = false;
      if (pier) {
        const curX = x + visual.sepX;
        const curZ = y + visual.sepY;
        const dirX = Math.sin(pier.yaw);
        const dirZ = Math.cos(pier.yaw);
        // Where he stands relative to the deck line, from the landward end.
        const along = (curX - pier.baseX) * dirX + (curZ - pier.baseZ) * dirZ;
        const drift = Math.abs(
          (curX - pier.baseX) * dirZ - (curZ - pier.baseZ) * dirX,
        );
        onDeck = along > -0.1 && drift < 0.3;
        // Two legs, not a beeline: converge on the landward end first — a
        // straight run at the tip would cut the corner through open water.
        const tx = onDeck ? pier.spotX : pier.baseX;
        const tz = onDeck ? pier.spotZ : pier.baseZ;
        const dx = tx - curX;
        const dz = tz - curZ;
        const dist = Math.hypot(dx, dz);
        fishing = onDeck && dist < 0.08;
        if (fishing) {
          visual.sepX = this.#sepTX[i] = pier.spotX - x;
          visual.sepY = this.#sepTY[i] = pier.spotZ - y;
          visual.group.rotation.y = pier.yaw; // face the water
        } else if (dist > 1e-4) {
          // Walk, don't slide: advance at the worker's own gait, written
          // straight through the de-overlap channel (easing toward a
          // moving target would glide him at a fraction of the speed).
          const step = Math.min(dist, RENDER_WALK_SPEED * dt);
          visual.sepX = this.#sepTX[i] = curX + (dx / dist) * step - x;
          visual.sepY = this.#sepTY[i] = curZ + (dz / dist) * step - y;
          visual.group.rotation.y = Math.atan2(dx, dz);
          // Render-side walk, so no publish delta to measure: it advances
          // at exactly RENDER_WALK_SPEED, tell the legs the same.
          if (visual.char) setGaitSpeed(visual.char, RENDER_WALK_SPEED);
        }
      }
      // The farmer's post is his rows: while he holds it, the render
      // walks him along the field's mowing circuit — step, stroke, step,
      // the working rhythm — and stands him mid-field when the farm
      // stalls. Render-side like the pier walk; the sim keeps him parked
      // on whatever adjacent tile the path found.
      const field =
        !offScreen &&
        !dead &&
        !moving &&
        action !== ACTION.fight &&
        workKind === WORK.mow
          ? this.#nearestField(x, y)
          : null;
      let mowSwing = false;
      let mowStep = false;
      let onFieldPad = false;
      if (field && visual.char) {
        // One idle tick separates every finished batch from the next, so
        // the raw flag flickers; work seen now coasts a beat (and a truly
        // stalled farm still stops the scythe inside half a second).
        if (action === ACTION.work)
          visual.mowWorkUntil = animNow + MOW_WORK_COAST;
        const working = animNow < (visual.mowWorkUntil ?? 0);
        const curX = x + visual.sepX;
        const curZ = y + visual.sepY;
        onFieldPad =
          curX > field.minX &&
          curX < field.maxX &&
          curZ > field.minZ &&
          curZ < field.maxZ;
        if (visual.mowI === undefined || visual.mowI >= field.points.length) {
          visual.mowI = 0;
          visual.mowDir = 1;
          visual.mowStepLeft = MOW_STEP;
        }
        // Hold the spot by default — the eased channel would otherwise
        // drift him back toward the sim's parked tile on any frame that
        // does not walk (a stroke, a stall, the beat a lane turns on).
        // The walking branch below overwrites this with its own step.
        this.#sepTX[i] = visual.sepX;
        this.#sepTY[i] = visual.sepY;
        if (
          visual.mowSwingUntil !== undefined &&
          animNow < visual.mowSwingUntil
        ) {
          // Mid-stroke: stand into it and let the clip's own sweep do the
          // moving. Even a stall waits for the stroke to land — a scythe
          // stopped mid-arc reads as a glitch.
          mowSwing = true;
        } else if (!working && onFieldPad) {
          // The farm is stalled — no water, output full, paused. He
          // stands where the last stroke left him, scythe grounded: an
          // idle farmer mid-field is the stall made visible, the same
          // signal the mill's easing sails give.
          visual.mowSwingUntil = undefined;
        } else {
          visual.mowSwingUntil = undefined;
          const target = field.points[visual.mowI]!;
          // Two legs from off the plot: in over the open front first —
          // a beeline from the parked tile would clip through the flank
          // fences.
          const tx = onFieldPad ? target.x : field.gateX;
          const tz = onFieldPad ? target.z : field.gateZ;
          const dx = tx - curX;
          const dz = tz - curZ;
          const dist = Math.hypot(dx, dz);
          if (onFieldPad && dist < 0.08) {
            // Lane's end: turn onto the next leg, ping-ponging the round.
            let next = visual.mowI + (visual.mowDir ?? 1);
            if (next < 0 || next >= field.points.length) {
              visual.mowDir = (visual.mowDir ?? 1) === 1 ? -1 : 1;
              next = visual.mowI + visual.mowDir;
            }
            visual.mowI = next;
          } else if (dist > 1e-4) {
            const step = Math.min(dist, RENDER_WALK_SPEED * dt);
            visual.sepX = this.#sepTX[i] = curX + (dx / dist) * step - x;
            visual.sepY = this.#sepTY[i] = curZ + (dz / dist) * step - y;
            visual.group.rotation.y = Math.atan2(dx, dz);
            setGaitSpeed(visual.char, RENDER_WALK_SPEED);
            mowStep = step > 1e-4;
            // A stroke every MOW_STEP of ground — but only working the
            // rows, never on the walk in through the gate.
            if (working && onFieldPad) {
              visual.mowStepLeft = (visual.mowStepLeft ?? MOW_STEP) - step;
              if (visual.mowStepLeft <= 0) {
                visual.mowStepLeft = MOW_STEP;
                const clip = visual.char.actions.get(AnimKey.mow)?.getClip();
                // One full sweep, plus the crossfade's grace so the
                // follow-through lands before the legs come back.
                visual.mowSwingUntil =
                  animNow + ((clip?.duration ?? 1.1) + 0.12) * 1000;
              }
            }
          }
        }
      }
      if (visual.char && offScreen) {
        // Culled: drop the current clip so re-entry restarts it cleanly
        // (playAnimation is a no-op while `current` matches).
        visual.char.current = null;
        // ...and the shoot clock with it: re-entry restarts the clip at a
        // fresh offset, and a time held from before the cull could read
        // as a release crossing that never happened.
        visual.shootT = undefined;
      } else if (visual.char) {
        const heldCarry = carrying > 0;
        let key: AnimKey;
        // The gait is a Gait, not an AnimKey — the numbers collide
        // (Gait.walk === AnimKey.idle), so it goes through gaitAnimKey.
        if (dead) key = AnimKey.death;
        else if (moving)
          key = heldCarry ? AnimKey.carry : gaitAnimKey(visual.char.gait);
        else if (pier)
          key = fishing ? AnimKey.fish : gaitAnimKey(visual.char.gait);
        else if (field)
          key = mowSwing
            ? AnimKey.mow
            : mowStep
              ? gaitAnimKey(visual.char.gait)
              : AnimKey.idle;
        else if (action === ACTION.fight)
          key = visual.char.ranged ? AnimKey.shoot : AnimKey.attack;
        else if (action === ACTION.work)
          key = crankWell ? AnimKey.idle : workAnimKey(workKind);
        else key = heldCarry ? AnimKey.carryIdle : AnimKey.idle;
        // Right tool for the job: mallet on sites, pickaxe at rock faces,
        // carried on the walk out too — a woodcutter heads to the trees
        // axe in fist. Only full hands stow it: cargo owns the grip.
        setWorkTool(visual.char, heldCarry ? TOOL_STOWED : workKind);
        // Whether playAnimation below actually (re)starts the clip: a
        // state change, or the first frame back from a cull (which nulled
        // `current`). Read before the call — it sets `current` to key.
        const restarted = visual.char.current !== key;
        if (dead && !visual.char.actions.has(AnimKey.death)) {
          // No death clip in this library: tip the body over instead.
          tipOver(visual.group, dt);
          playAnimation(visual.char, AnimKey.idle, hash2(id, 3));
        } else {
          playAnimation(
            visual.char,
            key,
            // Death holds its final pose from the top; a mowing stroke
            // begins at its wind-up — a swing entered mid-arc reads as a
            // twitch, and the stop's dwell is timed to the whole clip.
            key === AnimKey.death || key === AnimKey.mow ? 0 : hash2(id, 3),
          );
        }
        const fn = this.onCue;
        // State-entry sound, from audio's own memory — char.current is
        // nulled by the cull above and would re-announce every re-entry.
        if (fn && visual.audioKey !== key) {
          const cue = animCue(visual.audioKey, key);
          if (cue) fn(cue, x, y, 0);
        }
        visual.audioKey = key;
        // Where this unit is, for the loop-event percussion firing inside
        // mixer.update below (the closure outlives this frame's locals).
        visual.ax = x;
        visual.az = y;
        visual.char.mixer.update(dt);
        // The archer's string and nocked arrow follow the posed hand.
        if (visual.char.bow) updateBow(visual.char);
        // The 'loop' event only covers cycles after the first wrap, so a
        // percussive clip (re)started this frame would play its whole
        // first cycle mute — for Pickaxing that is two silent swings and
        // nearly four seconds. Schedule the entry cycle's remaining
        // impacts here. Gated on the restart, not the audioKey change: a
        // culled worker scrolling back into view restarts his clip too,
        // and his first swing back on screen deserves its sound as much
        // as watching him take it up did. Three fine points: it runs
        // after mixer.update, measuring delays from the clip's actual
        // post-advance position (`action.time`) rather than one frame
        // behind it; a restart on a paused frame (dt 0) parks in
        // entryPending until the world moves, because a pan over a frozen
        // battlefield must neither strike now nor forfeit the cycle; and
        // a clip whose very first update already wrapped hands the coming
        // cycle to that wrap's own event instead of booking it twice.
        if (fn && (restarted || visual.entryPending) && dt > 0) {
          visual.entryPending = false;
          const spec = LOOP_CUES[key];
          // Missing clip: playAnimation fell back to idle — no percussion.
          const action = spec ? visual.char.actions.get(key) : undefined;
          if (spec && action) {
            const clip = action.getClip();
            if (action.time >= hash2(id, 3) * clip.duration) {
              const phase = spec.byClip?.[clip.name] ?? spec.impactPhase01;
              // In real seconds — gait actions play speed-matched, so a
              // clip-time lead is off by their timeScale. An impact the
              // update just stepped over (delay in (-dt, 0]) visually
              // landed this frame — play it now, not never.
              const rate = action.getEffectiveTimeScale() || 1;
              const d1 = (phase * clip.duration - action.time) / rate;
              if (d1 > -dt) fn(spec.cue, x, y, Math.max(0, d1));
              const d2 = ((phase + 0.5) * clip.duration - action.time) / rate;
              if (spec.perCycle === 2 && d2 > -dt)
                fn(spec.cue, x, y, Math.max(0, d2));
            }
          }
        } else if (restarted) {
          visual.entryPending = true;
        }
        // The arrow leaves when the string hand does — the same release
        // phase the bow twang fires on (LOOP_CUES). Watched by clip time
        // rather than the mixer's 'loop' event because the release lands
        // mid-cycle and the flight must start this frame, not be booked
        // for later the way a sound can be. shootT is last frame's clip
        // time; the wrap-aware compare says whether this frame's advance
        // stepped over the release point. The target point is the sim's
        // own: the facing byte's bearing at the targetDist byte's range —
        // so the arrow flies at the enemy actually being shot, not at a
        // guess. targetDist 0 means no engaged target (a byte the sim
        // holds off zero while engaged), and a missing clip means
        // playAnimation fell back to idle: no arrow either way.
        const fnArrow = this.onArrow;
        let loosing = false;
        if (fnArrow && key === AnimKey.shoot) {
          const act = visual.char.actions.get(AnimKey.shoot);
          const range = latest.aux[a + 8]! / 8;
          if (act && range > 0) {
            loosing = true;
            const clip = act.getClip();
            const rel =
              (LOOP_CUES[AnimKey.shoot]?.impactPhase01 ?? 0.5) * clip.duration;
            const t = act.time;
            const prevT = visual.shootT;
            visual.shootT = t;
            if (crossedRelease(prevT, t, rel)) {
              const yaw = (latest.aux[a + 7]! / 256) * Math.PI * 2;
              fnArrow(
                x + visual.sepX,
                y + visual.sepY,
                x + Math.sin(yaw) * range,
                y + Math.cos(yaw) * range,
              );
            }
          }
        }
        if (!loosing) visual.shootT = undefined;
      }

      // Body bob synced to the gait: high at mid-stance, low at heel-strike.
      // (Skinned clips carry their own bob.)
      const bob =
        moving && !visual.char
          ? Math.abs(Math.cos(animNow * 0.012 + id * 2.1)) * 0.025
          : 0;
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
      // Placing a unit nobody can see is a height-field sample and a matrix
      // for nothing. The de-overlap easing above still runs, because
      // positionOfInto reports it to picking; only the drawn transform
      // waits, and it is rewritten on the first frame back on screen —
      // this loop runs before the render, so there is nothing to catch up.
      if (!offScreen) {
        // On the planks the deck carries him — the ground under a pier is
        // lake bed, and the height field would sink him to it. The farm's
        // pad is the same story a finger's height tall: on the worked
        // plot the farmer stands on the soil, not in it.
        const groundY = this.#heights.at(px, pz);
        const standY =
          pier && onDeck
            ? Math.max(groundY, pier.deckY)
            : field && onFieldPad
              ? Math.max(groundY, field.padY)
              : groundY;
        visual.group.position.set(px, standY + bob, pz);
        if (barPct >= 0) {
          // Exactly where the child mesh used to land. A unit's facing is a
          // Y rotation, which leaves a point on the Y axis where it was, and
          // the bar's own quaternion cancelled that facing out again — so
          // the bar's world transform was always just "over the unit's head,
          // square to the screen", which is what this composes.
          const n = this.#hpBarCount++;
          HP_POS.set(px, standY + bob + HP_BAR_Y, pz);
          HP_SCALE.set(Math.max(barPct, 0.05), 1, 1);
          HP_MATRIX.compose(HP_POS, camQuat, HP_SCALE);
          this.#hpBars.setMatrixAt(n, HP_MATRIX);
          this.#hpBars.setColorAt(n, HP_BUCKET_COLORS[hpBucket(barPct)]!);
        }
      }
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
    }

    // Hand three the frame's bars. Instances past the cursor are whatever
    // last frame left there, which is why `count` — not the buffer length —
    // is what gets drawn.
    this.#hpBars.count = this.#hpBarCount;
    if (this.#hpBarCount > 0) {
      this.#hpBars.instanceMatrix.needsUpdate = true;
      if (this.#hpBars.instanceColor)
        this.#hpBars.instanceColor.needsUpdate = true;
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
   * Per-cycle percussion — footfalls, axe bites, hammer blows, sword
   * swings — driven by the mixer's own 'loop' events rather than a timer,
   * because the mixer already has exactly the semantics the sounds need:
   * off-screen units skip mixer.update entirely (free culling), a paused
   * game advances it by 0 (free silence), and each unit's per-id clip
   * offset (the crowd desync) staggers the events for free. A hand-rolled
   * timer would have to re-derive all three and would drift.
   */
  #attachLoopCues(visual: UnitVisual): void {
    const char = visual.char;
    if (!char) return;
    // Which clip wrapped: the event carries the action, not the key.
    const keyOf = new Map<THREE.AnimationAction, AnimKey>();
    for (const [key, action] of char.actions) keyOf.set(action, key);
    const cb = (e: {action: THREE.AnimationAction}): void => {
      const fn = this.onCue;
      if (!fn) return;
      const key = keyOf.get(e.action);
      const spec = key !== undefined ? LOOP_CUES[key] : undefined;
      if (!spec) return;
      // During the 0.16s crossfade the outgoing action still wraps; only
      // the clip the unit is actually in gets to strike. Keyed on
      // `current` rather than blend weight: a clip entered near its own
      // wrap point wraps while its fade-in is still under half weight,
      // and a weight test dropped that wrap — losing the whole first
      // audible cycle.
      if (key !== char.current) return;
      // The attack key plays a different clip per unit kind, with the
      // impact somewhere else entirely — byClip carries those phases.
      const clip = e.action.getClip();
      const phase = spec.byClip?.[clip.name] ?? spec.impactPhase01;
      // The event fires mid-update with the action already advanced past
      // the wrap, so the lead is measured from its actual position, not
      // the wrap point — a wrap early in a long frame would land every
      // impact late by the rest of that frame. An impact the same update
      // stepped past comes out clamped to "now". Divided into real
      // seconds: gait actions play speed-matched (their timeScale grips
      // the feet to the ground), so clip time alone would schedule the
      // footfall off by that whole factor.
      const rate = e.action.getEffectiveTimeScale() || 1;
      const t = e.action.time;
      fn(
        spec.cue,
        visual.ax,
        visual.az,
        Math.max(0, (phase * clip.duration - t) / rate),
      );
      // perCycle 2 is a half-cycle symmetry: the gaits' second footfall,
      // the pick and hammer loops' second swing — half a clip later.
      if (spec.perCycle === 2) {
        fn(
          spec.cue,
          visual.ax,
          visual.az,
          Math.max(0, ((phase + 0.5) * clip.duration - t) / rate),
        );
      }
    };
    visual.loopCb = cb;
    char.mixer.addEventListener(
      'loop',
      cb as Parameters<typeof char.mixer.addEventListener>[1],
    );
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
    visual.group.traverse(o => {
      if (o instanceof THREE.SkinnedMesh) o.skeleton.dispose();
    });
    if (visual.char && visual.loopCb) {
      visual.char.mixer.removeEventListener(
        'loop',
        visual.loopCb as Parameters<
          typeof visual.char.mixer.removeEventListener
        >[1],
      );
    }
    this.#visuals.delete(id);
  }
}
