import * as THREE from 'three';
import {WATER_LEVEL} from '../sim/map';
import type {HeightField} from './heightField';
import {PIER_SPOT_BACK, type PierInfo} from './pierFit';
import {iceOver, type WaterMesh} from './waterMesh';

/**
 * PROTOTYPE: the fisherman's hole in the ice. Look only, like the frozen
 * lake it is cut in — the sim's fishery lands its catch on the same clock
 * in January as in June, and nothing here is saved or hashed.
 *
 * A hand line will not go through ice, so the first time a fisherman walks
 * out on a frozen lake he goes to the very end of his deck, works an auger
 * down through the ice where his line falls, and only then fishes — from
 * his usual stand, the line in the hole. The hole stays open for the rest
 * of the winter and goes with the ice.
 *
 * Owned per pier rather than per man: the hut's next fisherman fishes the
 * same hole. sceneSync walks him and poses him; this file says where the
 * hole is, how far it has been drilled, and draws it and the auger.
 */

/**
 * Where the line meets the water, from the feet of a man standing in
 * Fishing_Idle, in his own frame: this far ahead, and this far to his
 * right (the rod is in his right fist). Measured in a match — the hook's
 * plumb point against the man's root, over a run of frames on two maps:
 * 0.70 ahead, 0.20 right, steady to a hundredth.
 */
export const LINE_AHEAD = 0.7;
export const LINE_RIGHT = 0.2;

/** How hard the ice under the line has to be before it wants a hole. Half
 * set is when it stops reading as water (waterMesh.ts). */
export const HOLE_ICE = 0.5;

/** How long the auger takes to go through, in seconds of the animation
 * clock — a quarter of a catch. */
export const DRILL_SECONDS = 5;

/** How far short of the deck's tip he stands to drill — toes on the
 * planks, the auger over the edge — and how far right of the deck's middle,
 * toward where the line falls, so the auger stands nearer upright. */
const TOE = 0.06;
const DRILL_RIGHT = 0.1;

/**
 * The auger's top, from his feet as he stands to drill: ahead, to his
 * right, and up from the planks. Chest-high and close in, because that is
 * all the arms reach: the rig's shoulders stand 0.43 up and 0.08 either
 * side of him, and shoulder to wrist is 0.22. The bit goes down to the hole
 * from there, so the shaft leans out over the edge of the deck — less the
 * higher the top, which is the other reason it is up here.
 */
const KNOB_AHEAD = 0.15;
const KNOB_RIGHT = 0.03;
const KNOB_Y = 0.36;

/** The brace: how far under the knob the crank arm sits, how far it
 * throws — short, so the far side of the turn is still in the right fist's
 * reach — and the grip on its end that the right hand turns. */
const CRANK_DROP = 0.06;
const CRANK_THROW = 0.045;
const GRIP_LEN = 0.05;
const SHAFT_R = 0.014;
/** The spiral bit at the foot of the shaft. */
const BIT_LEN = 0.13;
const BIT_STEPS = 6;
/** How far the auger goes down its own axis as it bores, and one turn of
 * the brace in seconds. */
const SINK = 0.05;
const TURN_SECONDS = 0.9;

/** The open water in the hole, and the ring of chipped ice the auger
 * throws up round it. */
const HOLE_R = 0.075;
const SHAVINGS_R = 0.17;
/** Laid this far over the ice: the water plane does not write depth, so
 * this is all that keeps the two apart. */
const HOLE_LIFT = 0.01;

/** What the fisherman needs to know about the hole his line wants. */
export interface IceHole {
  /** Bored through: he can fish. */
  readonly drilled: boolean;
  /** Where he stands to work the auger: on the deck line, toes at the
   * tip. Faces the water, which is the pier's yaw. */
  readonly standX: number;
  readonly standZ: number;
  /** The auger's top, for his left fist, and the brace's grip, for his
   * right — both moving with it. */
  readonly knob: THREE.Object3D;
  readonly grip: THREE.Object3D;
}

const DOWN_AXIS = new THREE.Vector3(0, -1, 0);

class Hole implements IceHole {
  readonly x: number;
  readonly z: number;
  readonly standX: number;
  readonly standZ: number;
  /** 0 to 1 over DRILL_SECONDS. */
  progress = 0;
  /** Worked this frame: the auger is drawn only while someone turns it. */
  worked = false;
  readonly group = new THREE.Group();
  readonly water: THREE.Mesh;
  readonly shavings: THREE.Mesh;
  readonly auger = new THREE.Group();
  readonly spin = new THREE.Group();
  readonly knob = new THREE.Object3D();
  readonly grip = new THREE.Object3D();
  /** The auger's top as he starts, and the way down its shaft. */
  readonly top = new THREE.Vector3();
  readonly down = new THREE.Vector3();

  constructor(pier: PierInfo, x: number, z: number, parts: Parts) {
    const fx = Math.sin(pier.yaw);
    const fz = Math.cos(pier.yaw);
    // His right, facing along the yaw: a man facing +z has it on -x.
    const rx = -fz;
    const rz = fx;
    this.x = x;
    this.z = z;
    this.standX = pier.spotX + fx * (PIER_SPOT_BACK - TOE) + rx * DRILL_RIGHT;
    this.standZ = pier.spotZ + fz * (PIER_SPOT_BACK - TOE) + rz * DRILL_RIGHT;

    this.shavings = new THREE.Mesh(parts.shavingsGeo, parts.snow);
    this.shavings.position.y = HOLE_LIFT * 0.6;
    this.water = new THREE.Mesh(parts.holeGeo, parts.water);
    this.water.position.y = HOLE_LIFT;
    this.group.add(this.shavings, this.water);
    this.group.position.set(this.x, WATER_LEVEL, this.z);
    // Each hole's ring turned its own way, so two never match.
    this.group.rotation.y = (pier.bx * 12.9898 + pier.bz * 78.233) % 6.283;
    this.group.visible = false;

    // The auger, top at its origin and shaft down its -y, leaned from
    // where his hands are to where the line will fall.
    this.top.set(
      this.standX + fx * KNOB_AHEAD + rx * KNOB_RIGHT,
      pier.deckY + KNOB_Y,
      this.standZ + fz * KNOB_AHEAD + rz * KNOB_RIGHT,
    );
    this.down.set(this.x, WATER_LEVEL, this.z).sub(this.top);
    const length = this.down.length();
    this.down.normalize();
    this.auger.quaternion.setFromUnitVectors(DOWN_AXIS, this.down);
    this.auger.position.copy(this.top);
    this.auger.add(this.spin);
    this.auger.visible = false;
    const knob = new THREE.Mesh(parts.knobGeo, parts.wood);
    const arm = new THREE.Mesh(parts.armGeo, parts.iron);
    arm.position.set(CRANK_THROW / 2, -CRANK_DROP, 0);
    const grip = new THREE.Mesh(parts.gripGeo, parts.wood);
    grip.position.set(CRANK_THROW, -CRANK_DROP - GRIP_LEN / 2, 0);
    this.grip.position.copy(grip.position);
    const shaft = new THREE.Mesh(parts.shaftGeo, parts.iron);
    shaft.scale.y = length;
    shaft.position.y = -length / 2;
    this.spin.add(knob, this.knob, arm, grip, this.grip, shaft);
    // Flat blades up the last of the shaft, each turned on from the one
    // below, so the bit reads as a spiral — and turns like one.
    for (let i = 0; i < BIT_STEPS; i++) {
      const blade = new THREE.Mesh(parts.bladeGeo, parts.iron);
      blade.position.y = -length + (BIT_LEN * (i + 0.5)) / BIT_STEPS;
      blade.rotation.y = (i * 2 * Math.PI) / BIT_STEPS;
      this.spin.add(blade);
    }
    for (const o of [this.group, this.auger])
      o.traverse(m => {
        if (m instanceof THREE.Mesh) {
          m.castShadow = o === this.auger;
          m.receiveShadow = true;
        }
      });
  }

  get drilled(): boolean {
    return this.progress >= 1;
  }
}

/** What every hole and auger is cut from, made once per match. */
interface Parts {
  holeGeo: THREE.BufferGeometry;
  shavingsGeo: THREE.BufferGeometry;
  knobGeo: THREE.BufferGeometry;
  armGeo: THREE.BufferGeometry;
  gripGeo: THREE.BufferGeometry;
  shaftGeo: THREE.BufferGeometry;
  bladeGeo: THREE.BufferGeometry;
  water: THREE.MeshLambertMaterial;
  snow: THREE.MeshLambertMaterial;
  iron: THREE.MeshLambertMaterial;
  wood: THREE.MeshLambertMaterial;
}

/** A material the snow leaves alone (seasons.ts): the ice the auger
 * brings up and the tool in his hands are what was put down a moment ago,
 * and the hole is water. One that lies `flat` on the ice is pulled toward
 * the eye as well, so the lake can never show through it. */
function dryMaterial(color: number, flat = false): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({
    color,
    polygonOffset: flat,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  m.userData.dry = true;
  return m;
}

/** A ragged ring of chips round the hole, lying flat and facing up. */
function shavingsGeometry(): THREE.BufferGeometry {
  const geo = new THREE.RingGeometry(HOLE_R * 0.8, SHAVINGS_R, 28, 1);
  const pos = geo.getAttribute('position');
  const mid = (HOLE_R * 0.8 + SHAVINGS_R) / 2;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    if (r < mid) continue;
    const a = Math.atan2(y, x);
    const k = 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(a * 5 + 1.3) * Math.cos(a * 3));
    pos.setXY(i, x * k, y * k);
  }
  geo.rotateX(-Math.PI / 2);
  return geo;
}

export class IceHoles {
  #scene: THREE.Object3D;
  #heights: HeightField;
  #water: Pick<WaterMesh, 'frozen' | 'colors'>;
  #holes = new Map<PierInfo, Hole>();
  #parts: Parts;

  constructor(
    scene: THREE.Object3D,
    heights: HeightField,
    water: Pick<WaterMesh, 'frozen' | 'colors'>,
  ) {
    this.#scene = scene;
    this.#heights = heights;
    this.#water = water;
    this.#parts = {
      holeGeo: new THREE.CircleGeometry(HOLE_R, 20).rotateX(-Math.PI / 2),
      shavingsGeo: shavingsGeometry(),
      knobGeo: new THREE.SphereGeometry(0.024, 10, 8),
      armGeo: new THREE.BoxGeometry(CRANK_THROW, 0.012, 0.012),
      gripGeo: new THREE.CylinderGeometry(0.013, 0.013, GRIP_LEN, 8),
      // Unit length, stretched to each hole's own drop.
      shaftGeo: new THREE.CylinderGeometry(SHAFT_R, SHAFT_R, 1, 6),
      bladeGeo: new THREE.BoxGeometry(0.06, 0.006, 0.016),
      water: dryMaterial(0x000000, true),
      snow: dryMaterial(0xe9f1f7, true),
      iron: dryMaterial(0x5d636b),
      wood: dryMaterial(0x86582f),
    };
  }

  /** How hard the ice is at a point, exactly as the lake is drawn there. */
  #ice(x: number, z: number): number {
    return iceOver(
      WATER_LEVEL - this.#heights.at(x, z),
      this.#water.frozen.value,
    );
  }

  /**
   * The hole a fisherman on `pier` has to fish through, or null when his
   * line falls in open water and he fishes the way he does in summer.
   */
  at(pier: PierInfo): IceHole | null {
    const hole = this.#holes.get(pier);
    if (hole) return this.#ice(hole.x, hole.z) < HOLE_ICE ? null : hole;
    // Where the line falls: LINE_AHEAD along the yaw, LINE_RIGHT to the
    // right of it (which, facing +z, is -x).
    const fx = Math.sin(pier.yaw);
    const fz = Math.cos(pier.yaw);
    const x = pier.spotX + fx * LINE_AHEAD - fz * LINE_RIGHT;
    const z = pier.spotZ + fz * LINE_AHEAD + fx * LINE_RIGHT;
    if (this.#ice(x, z) < HOLE_ICE) return null;
    const made = new Hole(pier, x, z, this.#parts);
    this.#holes.set(pier, made);
    this.#scene.add(made.group, made.auger);
    return made;
  }

  /** `seconds` more at the auger; the brace turns and the bit goes down. */
  drill(hole: IceHole, seconds: number): void {
    const h = hole as Hole;
    if (h.drilled) return;
    h.worked = true;
    h.progress = Math.min(1, h.progress + seconds / DRILL_SECONDS);
    h.spin.rotation.y -= (seconds / TURN_SECONDS) * Math.PI * 2;
    h.auger.position.copy(h.top).addScaledVector(h.down, SINK * h.progress);
  }

  /** Drilled while nobody was looking: the sim had him fishing all along,
   * so whoever turns up later finds the hole already there. */
  finish(pier: PierInfo): void {
    const hole = this.at(pier) as Hole | null;
    if (hole) hole.progress = 1;
  }

  /** The built piers now standing; a hole whose hut is gone goes too. */
  setPiers(piers: readonly PierInfo[]): void {
    for (const [pier, hole] of this.#holes)
      if (!piers.includes(pier)) this.#drop(pier, hole);
  }

  /**
   * Once a frame, after the units are posed: what the thaw has taken goes,
   * and what is left is drawn as far as it has been dug — the chips piling
   * up while the auger turns, the water showing once it is out.
   */
  update(): void {
    const deep = this.#water.colors.deep;
    this.#parts.water.color.copy(deep).multiplyScalar(0.55);
    for (const [pier, hole] of this.#holes) {
      if (this.#ice(hole.x, hole.z) < HOLE_ICE) {
        this.#drop(pier, hole);
        continue;
      }
      hole.group.visible = hole.progress > 0;
      hole.water.visible = hole.drilled;
      hole.shavings.scale.setScalar(0.4 + 0.6 * hole.progress);
      hole.auger.visible = hole.worked && !hole.drilled;
      hole.worked = false;
    }
  }

  #drop(pier: PierInfo, hole: Hole): void {
    hole.group.removeFromParent();
    hole.auger.removeFromParent();
    this.#holes.delete(pier);
  }

  /** DEV: how many holes there are and how far each is dug. */
  get holes(): {x: number; z: number; progress: number}[] {
    return [...this.#holes.values()].map(h => ({
      x: h.x,
      z: h.z,
      progress: h.progress,
    }));
  }

  dispose(): void {
    for (const [pier, hole] of this.#holes) this.#drop(pier, hole);
    for (const part of Object.values(this.#parts)) part.dispose();
  }
}
