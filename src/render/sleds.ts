import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import * as UnitTypeId from '../sim/defs/unitTypeIdEnum';
import {WATER_LEVEL} from '../sim/map';
import {gaitAnimKey, makeCharacter, playAnimation} from './characters';
import type {CharacterVisual} from './characters';
import type {HeightField} from './heightField';
import {makeCarryProp} from './models';
import type {SceneSync} from './sceneSync';

/**
 * PROTOTYPE (?sleds): winter as hauling season, to be looked at. While the
 * snow lies, a serf with a load pulls it on a sled — four of whatever he
 * was carrying — and the runners leave two lines behind him. Look only:
 * the sim still moves one load, and nothing here is saved or hashed.
 *
 * __sleds.convoy([[x, z], ...], count) walks a made-up line of sleds along
 * a route, out loaded and back empty, for judging what the sim cannot show
 * yet: a lane worked hard, and a crossing of the frozen lake.
 */

/** Snow enough to pull on. */
const SLEDDING = 0.6;
/** Runner to runner, the deck's height, and how far ahead of the sled's
 * middle its drawbar sits and how high — the model's own measures
 * (tools/modelLab/sled.py). */
const GAUGE = 0.42;
const DECK = 0.17;
const DRAWBAR = 0.5;
const DRAWBAR_HEIGHT = 0.3;
/** From the man's heels to the middle of the sled. */
const ROPE = 1.05;
/** How far a man leans into a loaded sled and an empty one, in radians,
 * and where his hands close on the trace: behind his hips, in his own
 * frame (he faces +z). */
const LEAN_LOADED = 0.4;
const LEAN_EMPTY = 0.18;
const GRIP = new THREE.Vector3(0.1, 0.34, -0.2);
/** How long an emptied sled stays with its serf before it is put away. */
const KEEP_SECONDS = 25;
/** Where the four loads sit on the deck. */
const BERTHS: readonly [number, number][] = [
  [-0.1, 0.17],
  [0.1, 0.17],
  [-0.1, -0.2],
  [0.1, -0.2],
];

const TRACKS = 6000;
const TRACK_STEP = 0.3;

const rope = new THREE.LineBasicMaterial({color: 0x5a4630});

/**
 * A copy of `material` that the snow leaves alone. What is on a sled was
 * loaded a minute ago: drifted over, four sacks of flour and four stones
 * are the same white heap, and telling them apart is the point.
 */
const dry = new Map<THREE.Material, THREE.Material>();
function keepDry(root: THREE.Object3D): void {
  root.traverse(obj => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    let copy = dry.get(mesh.material);
    if (!copy) {
      const from = mesh.material as THREE.MeshStandardMaterial;
      copy = new THREE.MeshLambertMaterial({
        color: from.color,
        map: from.map,
        vertexColors: from.vertexColors,
      });
      copy.userData.dry = true;
      dry.set(mesh.material, copy);
    }
    mesh.material = copy;
    mesh.castShadow = true;
  });
}

/** The sled, nose toward +z, once its model has arrived. */
let model: THREE.Object3D | undefined;
new GLTFLoader().load(
  `${import.meta.env.BASE_URL}models/sled/sled.glb`,
  gltf => {
    keepDry(gltf.scene);
    model = gltf.scene;
  },
);

interface Sled {
  group: THREE.Group;
  loads: THREE.Group;
  line: THREE.Line;
  /** What is on the deck, as a carry code; 0 is an empty sled. */
  carrying: number;
  x: number;
  z: number;
  yaw: number;
  /** Ground covered since the runners last marked it. */
  since: number;
  emptyFor: number;
  seen: boolean;
  /** The man on the rope, the arms he pulls with, and how hard he is
   * pulling right now: 0 standing, 1 with the sled moving behind him. */
  man: THREE.Group;
  arms: Arm[];
  strain: number;
}

/** Shoulder to elbow to wrist, and which side of him it hangs on. */
interface Arm {
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  hand: THREE.Object3D;
  side: number;
}

/** A man's two arms, by the rig's own bone names. */
function armsOf(man: THREE.Object3D): Arm[] {
  const arms: Arm[] = [];
  for (const [suffix, side] of [
    ['l', 1],
    ['r', -1],
  ] as const) {
    const bone = (part: string): THREE.Object3D | undefined => {
      let found: THREE.Object3D | undefined;
      man.traverse(obj => {
        // The loader strips the dot from "upperarm.l".
        if (obj.name.replace('.', '') === part + suffix) found = obj;
      });
      return found;
    };
    const upper = bone('upperarm');
    const lower = bone('lowerarm');
    const hand = bone('hand');
    if (upper && lower && hand) arms.push({upper, lower, hand, side});
  }
  return arms;
}

/** Turn `bone` so that the limb from it to `child` points at `target`,
 * `weight` of the way from where the walk had it. */
function aim(
  bone: THREE.Object3D,
  child: THREE.Object3D,
  target: THREE.Vector3,
  weight: number,
): void {
  bone.getWorldPosition(FROM);
  child.getWorldPosition(TO).sub(FROM).normalize();
  WANT.copy(target).sub(FROM).normalize();
  TURN.setFromUnitVectors(TO, WANT);
  TURN.slerp(STILL, 1 - weight);
  bone.getWorldQuaternion(WORLD).premultiply(TURN);
  bone.parent!.getWorldQuaternion(PARENT).invert();
  bone.quaternion.copy(PARENT.multiply(WORLD));
  bone.updateMatrixWorld(true);
}

interface Puller {
  group: THREE.Group;
  char: CharacterVisual;
  /** Distance along the route, out and back. */
  along: number;
  good: number;
}

export class Sleds {
  #scene: THREE.Scene;
  #heights: HeightField;
  #sync: SceneSync;
  #sleds = new Map<number, Sled>();
  #tracks: THREE.InstancedMesh;
  #trackAt = 0;
  #last: number | undefined;
  #route: THREE.Vector2[] = [];
  #routeLength = 0;
  #pullers: Puller[] = [];
  #enabled = new URLSearchParams(location.search).has('sleds');

  constructor(scene: THREE.Scene, heights: HeightField, sync: SceneSync) {
    this.#scene = scene;
    this.#heights = heights;
    this.#sync = sync;
    const mark = new THREE.PlaneGeometry(0.04, TRACK_STEP * 1.15);
    mark.rotateX(-Math.PI / 2);
    this.#tracks = new THREE.InstancedMesh(
      mark,
      new THREE.MeshBasicMaterial({
        color: 0x5f7696,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      }),
      TRACKS,
    );
    this.#tracks.count = 0;
    this.#tracks.frustumCulled = false;
    // Over the ice as well as the snow: the lake is drawn after the land.
    this.#tracks.renderOrder = 5;
    scene.add(this.#tracks);
  }

  /** The surface a sled or a man stands on: the ground, or the ice. */
  #floor(x: number, z: number): number {
    return Math.max(this.#heights.at(x, z), WATER_LEVEL);
  }

  /**
   * DEV: a made-up line of `count` sleds working `route` (world x, z), out
   * loaded and back empty. `goods` are carry codes, dealt round the line;
   * an empty route sends them home.
   */
  convoy(route: [number, number][], count = 6, goods = [3, 4, 2, 12]): void {
    for (const p of this.#pullers) this.#scene.remove(p.group);
    this.#pullers = [];
    this.#route = route.map(([x, z]) => new THREE.Vector2(x, z));
    this.#routeLength = 0;
    for (let i = 1; i < this.#route.length; i++) {
      this.#routeLength += this.#route[i]!.distanceTo(this.#route[i - 1]!);
    }
    if (this.#routeLength === 0) return;
    for (let i = 0; i < count; i++) {
      const made = makeCharacter(UnitTypeId.serf, 0, 0);
      if (!made) return;
      this.#scene.add(made.group);
      playAnimation(made.visual, gaitAnimKey(made.visual.gait), i / count);
      this.#pullers.push({
        group: made.group,
        char: made.visual,
        along: (i / count) * this.#routeLength * 2,
        good: goods[i % goods.length]!,
      });
    }
  }

  /** The point `along` the route, and which way the route runs there. */
  #onRoute(along: number, out: THREE.Vector3): number {
    let left = along;
    for (let i = 1; i < this.#route.length; i++) {
      const a = this.#route[i - 1]!;
      const b = this.#route[i]!;
      const span = a.distanceTo(b);
      if (left <= span || i === this.#route.length - 1) {
        const t = Math.min(left / span, 1);
        out.set(a.x + (b.x - a.x) * t, 0, a.y + (b.y - a.y) * t);
        return Math.atan2(b.x - a.x, b.y - a.y);
      }
      left -= span;
    }
    return 0;
  }

  update(seconds: number, speed: number, snow: number): void {
    const dt =
      this.#last === undefined
        ? 0
        : Math.min(Math.max(seconds - this.#last, 0), 0.25) * speed;
    this.#last = seconds;
    const sledding = this.#enabled && snow > SLEDDING;
    this.#sync.towing = sledding;
    (this.#tracks.material as THREE.Material).opacity = 0.42 * snow;

    for (const sled of this.#sleds.values()) sled.seen = false;
    if (sledding) {
      this.#sync.eachUnit((id, kind, group, carrying) => {
        if ((kind & 0xff) !== UnitTypeId.serf) return;
        this.#pull(id, group, carrying, dt);
      });
    }
    // The made-up line walks whatever the season, so a route can be laid
    // out before the snow and judged as it comes.
    const length = this.#routeLength;
    this.#pullers.forEach((p, i) => {
      p.along = (p.along + dt * 1.5) % (length * 2);
      const back = p.along > length;
      const yaw = this.#onRoute(back ? length * 2 - p.along : p.along, SPOT);
      p.group.position.set(SPOT.x, this.#floor(SPOT.x, SPOT.z), SPOT.z);
      p.group.rotation.y = back ? yaw + Math.PI : yaw;
      p.char.mixer.update(dt);
      this.#pull(-1 - i, p.group, back ? 0 : p.good, dt);
    });

    for (const [id, sled] of this.#sleds) {
      if (sled.seen) continue;
      this.#scene.remove(sled.group, sled.line);
      sled.line.geometry.dispose();
      // Stand him up again: the lean was ours.
      sled.man.rotation.x = 0;
      this.#sleds.delete(id);
    }
  }

  /** Bring one serf's sled along behind him. */
  #pull(id: number, man: THREE.Group, carrying: number, dt: number): void {
    let sled = this.#sleds.get(id);
    if (!sled) {
      // A serf with nothing to move leaves his sled at home.
      if (carrying === 0 || !model) return;
      sled = this.#make(man, model);
      this.#sleds.set(id, sled);
    }
    sled.emptyFor = carrying > 0 ? 0 : sled.emptyFor + dt;
    if (sled.emptyFor > KEEP_SECONDS) return;
    sled.seen = true;

    if (carrying !== sled.carrying) {
      sled.carrying = carrying;
      sled.loads.clear();
      for (const [x, z] of carrying > 0 ? BERTHS : []) {
        const load = makeCarryProp(carrying);
        if (!load) break;
        keepDry(load);
        load.position.set(x, DECK + 0.01, z);
        load.rotation.y = x * 4 + z;
        sled.loads.add(load);
      }
    }

    // A trailer on a rope: it is dragged toward the man and no further,
    // so it cuts his corners and swings round behind him on its own.
    const mx = man.position.x;
    const mz = man.position.z;
    let dx = mx - sled.x;
    let dz = mz - sled.z;
    const gap = Math.hypot(dx, dz);
    if (gap > ROPE * 3) {
      // He was moved, not walked: start again behind him.
      dx = Math.sin(man.rotation.y);
      dz = Math.cos(man.rotation.y);
      sled.x = mx - dx * ROPE;
      sled.z = mz - dz * ROPE;
    }
    const pulling = gap > ROPE && gap <= ROPE * 3;
    if (pulling) {
      const pull = (gap - ROPE) / gap;
      sled.x += dx * pull;
      sled.z += dz * pull;
      sled.since += gap - ROPE;
      sled.yaw = Math.atan2(dx, dz);
    }
    // Into the rope: the whole man tips forward from his heels while the
    // sled is moving, further the more is on it, and both hands go back to
    // the trace behind his hips.
    sled.strain += ((pulling ? 1 : 0) - sled.strain) * Math.min(dt * 5, 1);
    man.rotation.order = 'YXZ';
    man.rotation.x =
      sled.strain * (sled.carrying > 0 ? LEAN_LOADED : LEAN_EMPTY);
    man.updateMatrixWorld(true);
    HANDS.set(mx, man.position.y + 0.36, mz);
    if (sled.arms.length === 2 && sled.strain > 0.01) {
      HANDS.set(0, 0, 0);
      for (const arm of sled.arms) {
        man.localToWorld(REACH.copy(GRIP).setX(GRIP.x * arm.side));
        aim(arm.upper, arm.lower, REACH, sled.strain);
        aim(arm.lower, arm.hand, REACH, sled.strain);
        HANDS.add(arm.hand.getWorldPosition(FROM));
      }
      HANDS.multiplyScalar(0.5);
    }

    const y = this.#floor(sled.x, sled.z);
    sled.group.position.set(sled.x, y, sled.z);
    sled.group.rotation.y = sled.yaw;

    if (sled.since > TRACK_STEP) {
      sled.since = 0;
      for (const side of [-1, 1]) {
        const off = (side * GAUGE) / 2;
        MARK.makeRotationY(sled.yaw).setPosition(
          sled.x + Math.cos(sled.yaw) * off,
          y + 0.012,
          sled.z - Math.sin(sled.yaw) * off,
        );
        this.#tracks.setMatrixAt(this.#trackAt, MARK);
        this.#trackAt = (this.#trackAt + 1) % TRACKS;
        this.#tracks.count = Math.min(this.#tracks.count + 1, TRACKS);
      }
      this.#tracks.instanceMatrix.needsUpdate = true;
    }

    // The trace: from each end of the drawbar to the man's waist.
    const points = sled.line.geometry.getAttribute('position');
    const sin = Math.sin(sled.yaw);
    const cos = Math.cos(sled.yaw);
    for (const [i, side] of [
      [0, -1],
      [2, 1],
    ] as const) {
      const off = (side * GAUGE) / 2;
      points.setXYZ(
        i,
        sled.x + sin * DRAWBAR + cos * off,
        y + DRAWBAR_HEIGHT,
        sled.z + cos * DRAWBAR - sin * off,
      );
    }
    points.setXYZ(1, HANDS.x, HANDS.y, HANDS.z);
    points.needsUpdate = true;
  }

  #make(man: THREE.Group, model: THREE.Object3D): Sled {
    const group = new THREE.Group();
    group.add(model.clone());
    const loads = new THREE.Group();
    group.add(loads);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(9), 3),
    );
    const line = new THREE.Line(geometry, rope);
    line.frustumCulled = false;
    this.#scene.add(group, line);
    const yaw = man.rotation.y;
    return {
      group,
      loads,
      line,
      carrying: 0,
      x: man.position.x - Math.sin(yaw) * ROPE,
      z: man.position.z - Math.cos(yaw) * ROPE,
      yaw,
      since: 0,
      emptyFor: 0,
      seen: true,
      man,
      arms: armsOf(man),
      strain: 0,
    };
  }

  dispose(): void {
    this.convoy([]);
    for (const sled of this.#sleds.values()) {
      sled.man.rotation.x = 0;
      this.#scene.remove(sled.group, sled.line);
      sled.line.geometry.dispose();
    }
    this.#sleds.clear();
    this.#scene.remove(this.#tracks);
    this.#tracks.geometry.dispose();
    (this.#tracks.material as THREE.Material).dispose();
    this.#sync.towing = false;
  }
}

const SPOT = new THREE.Vector3();
const MARK = new THREE.Matrix4();
const HANDS = new THREE.Vector3();
const REACH = new THREE.Vector3();
const FROM = new THREE.Vector3();
const TO = new THREE.Vector3();
const WANT = new THREE.Vector3();
const TURN = new THREE.Quaternion();
const STILL = new THREE.Quaternion();
const WORLD = new THREE.Quaternion();
const PARENT = new THREE.Quaternion();
