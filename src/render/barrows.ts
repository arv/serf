import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import * as GoodId from '../sim/defs/goodIdEnum';
import * as UnitTypeId from '../sim/defs/unitTypeIdEnum';
import {WATER_LEVEL} from '../sim/map';
import type {HeightField} from './heightField';
import {makeCarryProp, setCartModel} from './models';
import type {SceneSync} from './sceneSync';
import {aim, armsOf, type Arm, keepDry} from './sleds';

/**
 * The rest of the year's cart, drawn. A serf the sim has lent a wheelbarrow
 * (a walk of more than one load outside winter and the thaw; cartFor in
 * defs/balance.ts) pushes it ahead of him with as many of his good in the
 * tray as he has: the handles in his hands, the wheel on the ground in
 * front, and the man leaning into it a little. Stood still, he sets it
 * down on its legs.
 */

/** The model's own measures (tools/modelLab/wheelbarrow.py), in its frame
 * with the wheel toward +z: the axle's height and how far ahead of the
 * model's origin it is, the grips' height at rest, how far behind the
 * origin they are and how far apart, and the tray floor. */
const WHEEL_R = 0.11;
const AXLE_Z = 0.3;
const GRIP_Z = -0.4;
const GRIP_HEIGHT = 0.22;
const GRIP_HALF = 0.14;
const FLOOR = 0.17;
/** Where the two loads sit in the tray. */
const BERTHS: readonly [number, number][] = [
  [0, 0.12],
  [0, -0.04],
];
/** How high a man's hands hold the grips while he pushes, and how far ahead
 * of his middle. */
const HANDS_HEIGHT = 0.36;
const HANDS_AHEAD = 0.22;
/** How far he leans into a loaded barrow and an empty one, in radians. */
const LEAN_LOADED = 0.14;
const LEAN_EMPTY = 0.06;

/** The tilt about the axle that lifts the grips from rest to his hands,
 * and how far ahead of the grips the axle then is. */
const GRIP_RUN = AXLE_Z - GRIP_Z;
const GRIP_RISE = GRIP_HEIGHT - WHEEL_R;
const ARM = Math.hypot(GRIP_RUN, GRIP_RISE);
const LIFTED = Math.asin((HANDS_HEIGHT - WHEEL_R) / ARM);
const TILT = LIFTED - Math.atan2(GRIP_RISE, GRIP_RUN);
const AHEAD = HANDS_AHEAD + ARM * Math.cos(LIFTED);

let model: THREE.Object3D | undefined;
let asked = false;
function loadModel(): void {
  if (asked) return;
  asked = true;
  new GLTFLoader().load(
    `${import.meta.env.BASE_URL}models/wheelbarrow/wheelbarrow.glb`,
    gltf => {
      keepDry(gltf.scene);
      model = gltf.scene;
      // The castle draws its parked barrows with it.
      setCartModel(GoodId.wheelbarrow, model);
    },
  );
}

interface Barrow {
  group: THREE.Group;
  /** Turns about the axle: 0 resting on its legs, TILT up in his hands. */
  pivot: THREE.Group;
  loads: THREE.Group;
  carrying: number;
  load: number;
  seen: boolean;
  man: THREE.Group;
  arms: Arm[];
  /** Where he stood last frame, to tell walking from standing. */
  lastX: number;
  lastZ: number;
  /** 0 set down, 1 lifted and pushed. */
  lift: number;
}

export class Barrows {
  #scene: THREE.Scene;
  #heights: HeightField;
  #sync: SceneSync;
  #barrows = new Map<number, Barrow>();
  #last: number | undefined;

  constructor(scene: THREE.Scene, heights: HeightField, sync: SceneSync) {
    this.#scene = scene;
    this.#heights = heights;
    this.#sync = sync;
    loadModel();
  }

  #floor(x: number, z: number): number {
    return Math.max(this.#heights.at(x, z), WATER_LEVEL);
  }

  update(seconds: number, speed: number): void {
    const dt =
      this.#last === undefined
        ? 0
        : Math.min(Math.max(seconds - this.#last, 0), 0.25) * speed;
    this.#last = seconds;
    if (!model) return;
    this.#sync.readyCarts.add(GoodId.wheelbarrow);
    for (const b of this.#barrows.values()) b.seen = false;
    this.#sync.eachUnit((id, kind, group, carrying, load, cart) => {
      if ((kind & 0xff) === UnitTypeId.serf && cart === GoodId.wheelbarrow)
        this.#push(id, group, carrying, load, dt);
    });
    for (const [id, b] of this.#barrows) {
      if (b.seen) continue;
      this.#scene.remove(b.group);
      b.man.rotation.x = 0; // the lean was ours
      this.#barrows.delete(id);
    }
  }

  /** Bring one serf's barrow along in front of him. */
  #push(
    id: number,
    man: THREE.Group,
    carrying: number,
    load: number,
    dt: number,
  ): void {
    let b = this.#barrows.get(id);
    if (!b) {
      b = this.#make(man, model!);
      this.#barrows.set(id, b);
    }
    b.seen = true;

    if (carrying !== b.carrying || load !== b.load) {
      b.carrying = carrying;
      b.load = load;
      b.loads.clear();
      for (const [x, z] of carrying > 0 ? BERTHS.slice(0, load) : []) {
        const prop = makeCarryProp(carrying);
        if (!prop) break;
        keepDry(prop);
        prop.position.set(x, FLOOR + 0.01, z);
        prop.rotation.y = z * 6;
        b.loads.add(prop);
      }
    }

    const mx = man.position.x;
    const mz = man.position.z;
    const moved = Math.hypot(mx - b.lastX, mz - b.lastZ);
    b.lastX = mx;
    b.lastZ = mz;
    const walking = dt > 0 && moved > 0.002 && moved < 1;
    if (dt > 0) b.lift += ((walking ? 1 : 0) - b.lift) * Math.min(dt * 6, 1);

    // He leans into it while it rolls, more with a load in it.
    man.rotation.order = 'YXZ';
    man.rotation.x = b.lift * (b.carrying > 0 ? LEAN_LOADED : LEAN_EMPTY);
    man.updateMatrixWorld(true);

    // Rigid ahead of him: the wheel down in front, the grips at his hands
    // once lifted. Set down, the same spot, resting on its legs.
    const yaw = man.rotation.y;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const ax = mx + sin * AHEAD;
    const az = mz + cos * AHEAD;
    b.group.position.set(
      mx + sin * (AHEAD - AXLE_Z),
      this.#floor(ax, az),
      mz + cos * (AHEAD - AXLE_Z),
    );
    b.group.rotation.y = yaw;
    b.pivot.rotation.x = b.lift * TILT;
    b.group.updateMatrixWorld(true);

    if (b.arms.length === 2 && b.lift > 0.01) {
      for (const arm of b.arms) {
        b.pivot.localToWorld(
          GRIP.set(
            GRIP_HALF * arm.side,
            GRIP_HEIGHT - WHEEL_R,
            GRIP_Z - AXLE_Z,
          ),
        );
        aim(arm.upper, arm.lower, GRIP, b.lift);
        aim(arm.lower, arm.hand, GRIP, b.lift);
      }
    }
  }

  #make(man: THREE.Group, model: THREE.Object3D): Barrow {
    const group = new THREE.Group();
    // The pivot sits on the axle, so tipping it lifts the grips and leaves
    // the wheel where it is.
    const pivot = new THREE.Group();
    pivot.position.set(0, WHEEL_R, AXLE_Z);
    group.add(pivot);
    const body = model.clone();
    body.position.set(0, -WHEEL_R, -AXLE_Z);
    pivot.add(body);
    const loads = new THREE.Group();
    loads.position.set(0, -WHEEL_R, -AXLE_Z);
    pivot.add(loads);
    this.#scene.add(group);
    return {
      group,
      pivot,
      loads,
      carrying: 0,
      load: 0,
      seen: true,
      man,
      arms: armsOf(man),
      lastX: man.position.x,
      lastZ: man.position.z,
      lift: 0,
    };
  }

  dispose(): void {
    for (const b of this.#barrows.values()) {
      b.man.rotation.x = 0;
      this.#scene.remove(b.group);
    }
    this.#barrows.clear();
    this.#sync.readyCarts.delete(GoodId.wheelbarrow);
  }
}

const GRIP = new THREE.Vector3();
