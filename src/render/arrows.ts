import * as THREE from 'three';
import {lerp} from '../shared/math';
import * as GoodId from '../sim/defs/goodIdEnum.ts';
import {TARGET_HEIGHT} from './characters';
import type {HeightField} from './heightField';
import {goodColors} from './palette';

/**
 * Arrows in the air — the missing half of the archer's fight. The sim's
 * shot is instant (strikeUnit lands damage the tick it fires), so these
 * are pure theater: sceneSync says "loosed, from here, at there" the
 * frame the string hand opens (the same release phase the bow twang
 * plays on), and this layer owns the flight. Nothing here feeds back
 * into the sim, picking, or the publish stream.
 *
 * Meshes are pooled and share one geometry/material set, selectionFx
 * style: a battle's worth of volleys allocates a few dozen groups once
 * and recycles them for the rest of the match.
 */

/** Flight speed, tiles/sec. Faster than any runner, slow enough to see —
 * an archer's 5-tile shot hangs in the air for just under half a second. */
const ARROW_SPEED = 11;

/** Where the arrow leaves: the drawn bow, up at the chest of an archer
 * TARGET_HEIGHT tall. Riding the villager scale keeps it at the hand if
 * the cast ever resizes. */
const RELEASE_H = TARGET_HEIGHT * 0.62;

/** Where it strikes: the target's chest, a touch under the release so a
 * flat shot still noses slightly down at the end. */
const STRIKE_H = TARGET_HEIGHT * 0.45;

/** One arrow mid-flight. Endpoints are world coordinates; `arc` is the
 * lob's apex lift over the straight line between them. */
interface Flight {
  node: THREE.Group;
  fromX: number;
  fromY: number;
  fromZ: number;
  toX: number;
  toY: number;
  toZ: number;
  arc: number;
  /** Progress 0..1 along the flight. */
  t: number;
  /** Flight time in seconds, from distance at ARROW_SPEED. */
  dur: number;
}

const shaftMaterial = new THREE.MeshLambertMaterial({color: 0x8a6a42});
const headMaterial = new THREE.MeshLambertMaterial({
  color: goodColors[GoodId.sword],
});
const fletchMaterial = new THREE.MeshLambertMaterial({
  color: 0xe4ddc4,
  side: THREE.DoubleSide,
});

/**
 * The arrow model, built once and cloned per pool entry so every clone
 * shares geometry and materials (the spearProp economy). Authored tip at
 * the origin, shaft hanging down -Y: the flight math tracks the tip, and
 * pointing +Y along the velocity is then the whole orientation.
 *
 * Sized with the same chibi exaggeration the hand tools wear — a true
 * arrow against these bodies would vanish at village zoom.
 */
let arrowTemplate: THREE.Group | null = null;

function makeArrow(): THREE.Group {
  if (arrowTemplate) return arrowTemplate.clone();
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.016, 0.016, 0.43, 5),
    shaftMaterial,
  );
  shaft.position.y = -0.305;
  const head = new THREE.Mesh(
    new THREE.ConeGeometry(0.035, 0.09, 5),
    headMaterial,
  );
  head.position.y = -0.045;
  g.add(shaft, head);
  // Two crossed vanes at the tail. Planes, not solids: seen edge-on they
  // thin to a line exactly the way feathers do.
  for (const half of [0, 1]) {
    const vane = new THREE.Mesh(
      new THREE.PlaneGeometry(0.085, 0.13),
      fletchMaterial,
    );
    vane.position.y = -0.45;
    vane.rotation.y = half * (Math.PI / 2);
    g.add(vane);
  }
  arrowTemplate = g;
  return g.clone();
}

const DIR = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Arrows {
  #scene: THREE.Scene;
  #heights: HeightField;
  #free: THREE.Group[] = [];
  #live: Flight[] = [];

  constructor(scene: THREE.Scene, heights: HeightField) {
    this.#scene = scene;
    this.#heights = heights;
  }

  /** Arrows currently in the air (tests and forensics). */
  get liveCount(): number {
    return this.#live.length;
  }

  /**
   * Loose one arrow, ground coordinates to ground coordinates; the
   * heights (and the release/strike offsets above them) are sampled here.
   */
  spawn(fromX: number, fromZ: number, toX: number, toZ: number): void {
    const dist = Math.hypot(toX - fromX, toZ - fromZ);
    // Point-blank: the flight would be one frame of mesh inside two
    // bodies. The draw-and-loose pose carries that fight on its own.
    if (dist < 0.6) return;
    let node = this.#free.pop();
    if (!node) {
      node = makeArrow();
      this.#scene.add(node);
    }
    node.visible = true;
    const f: Flight = {
      node,
      fromX,
      fromY: this.#heights.at(fromX, fromZ) + RELEASE_H,
      fromZ,
      toX,
      toY: this.#heights.at(toX, toZ) + STRIKE_H,
      toZ,
      // A low lob that grows with the range — a long shot visibly rises,
      // a close one barely leaves the line.
      arc: Math.min(0.1 + dist * 0.07, 0.5),
      t: 0,
      dur: dist / ARROW_SPEED,
    };
    this.#live.push(f);
    // Placed now, not on the next update: a pooled node still holds the
    // pose its last flight ended in, and one frame of that is a flicker.
    this.#place(f);
  }

  /** Advance every flight. dt in seconds; pass 0 while paused. */
  update(dt: number): void {
    if (dt <= 0 || this.#live.length === 0) return;
    for (let i = this.#live.length - 1; i >= 0; i--) {
      const f = this.#live[i]!;
      f.t += dt / f.dur;
      if (f.t >= 1) {
        // Arrived. The strike itself needs no landing mesh: the damage
        // flash and the hp bar tick are already the impact, and an arrow
        // that vanishes into the body reads as having buried itself.
        f.node.visible = false;
        this.#free.push(f.node);
        const last = this.#live.pop()!;
        if (i < this.#live.length) this.#live[i] = last;
        continue;
      }
      this.#place(f);
    }
  }

  /** Pose one flight at its current t: tip on the lob, shaft along the
   * velocity — nose up on the climb, down on the fall. */
  #place(f: Flight): void {
    const t = f.t;
    const y = lerp(f.fromY, f.toY, t) + f.arc * 4 * t * (1 - t);
    f.node.position.set(lerp(f.fromX, f.toX, t), y, lerp(f.fromZ, f.toZ, t));
    DIR.set(
      f.toX - f.fromX,
      f.toY - f.fromY + f.arc * 4 * (1 - 2 * t),
      f.toZ - f.fromZ,
    ).normalize();
    f.node.quaternion.setFromUnitVectors(UP, DIR);
  }
}
