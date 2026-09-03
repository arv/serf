import * as THREE from 'three';
import {lerp} from '../shared/math';
import * as GoodId from '../sim/defs/goodIdEnum.ts';
import {makeArrow} from './arrowModel';
import {TARGET_HEIGHT} from './characters';
import type {HeightField} from './heightField';
import {goodColors} from './palette';

/**
 * Projectiles in the air — the missing half of every ranged fight. The
 * sim's shot is instant (strikeUnit and towerFire land damage the tick
 * they fire), so these are pure theater: sceneSync says "loosed, from
 * here, at there" the frame an archer's string hand opens (the same
 * release phase the bow twang plays on), buildingSync says the same for
 * the tower roof, and this layer owns the flight. Nothing here feeds
 * back into the sim, picking, or the publish stream.
 *
 * Two kinds fly: the arrow, and the stone a tower's levy lobs — same
 * flight machinery, its own silhouette and pace. Meshes are pooled per
 * kind and share one geometry/material set, selectionFx style: a
 * battle's worth of volleys allocates a few dozen groups once and
 * recycles them for the rest of the match.
 */

/** Arrow flight speed, tiles/sec. Faster than any runner, slow enough to
 * see — an archer's 5-tile shot hangs in the air for just under half a
 * second. */
const ARROW_SPEED = 11;

/** A thrown rock travels like one: markedly slower than an arrow, and
 * the higher lob below buys the hang time the lower speed implies. */
const STONE_SPEED = 7;

/** Where the arrow leaves: the drawn bow, up at the chest of an archer
 * TARGET_HEIGHT tall. Riding the villager scale keeps it at the hand if
 * the cast ever resizes. */
const RELEASE_H = TARGET_HEIGHT * 0.62;

/** Where the stone leaves: the overhand throw releases above the head
 * (the hand tops out half a body over the crown mid-Throw). */
const STONE_RELEASE_H = TARGET_HEIGHT * 1.1;

/** Where both strike: the target's chest, a touch under the arrow's
 * release so even a flat shot noses slightly down at the end. */
const STRIKE_H = TARGET_HEIGHT * 0.45;

/**
 * Did a looping clip's playhead step over `rel` (seconds into the clip)
 * between last frame's time `prevT` and this frame's `t`? Wrap-aware:
 * t < prevT means the loop wrapped inside the frame, and the release was
 * crossed if it lay in the tail we left or the head we entered. undefined
 * prevT is "not watching until now" — never a crossing, which is what
 * makes a clip picked up mid-cycle (fresh fight, return from a cull)
 * loose on its next release rather than retroactively. Shared by the
 * field archers (sceneSync) and the tower roof (buildingSync).
 */
export function crossedRelease(
  prevT: number | undefined,
  t: number,
  rel: number,
): boolean {
  if (prevT === undefined) return false;
  return t >= prevT ? prevT < rel && t >= rel : prevT < rel || t >= rel;
}

/** One projectile mid-flight. Endpoints are world coordinates; `arc` is
 * the lob's apex lift over the straight line between them. `pool` is
 * where the node goes back when it lands — arrows to the arrow pool,
 * stones to the stone pool. */
interface Flight {
  node: THREE.Group;
  pool: THREE.Group[];
  fromX: number;
  fromY: number;
  fromZ: number;
  toX: number;
  toY: number;
  toZ: number;
  arc: number;
  /** Progress 0..1 along the flight. */
  t: number;
  /** Flight time in seconds, from the full 3D length at the kind's pace —
   * a shot plunging off a tower roof is longer than its ground shadow. */
  dur: number;
}

const stoneMaterial = new THREE.MeshLambertMaterial({
  color: goodColors[GoodId.stone],
});

/** The levy's rock: one low-poly lump, fist-sized against the chibi
 * bodies. A group for symmetry with the arrow — the flight code poses
 * both the same way (the spin a lathe-perfect sphere would waste is
 * exactly what the icosahedron's facets sell for free). */
let stoneTemplate: THREE.Group | null = null;

function makeStone(): THREE.Group {
  if (stoneTemplate) return stoneTemplate.clone();
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.07, 0), stoneMaterial));
  stoneTemplate = g;
  return g.clone();
}

const DIR = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Arrows {
  #scene: THREE.Scene;
  #heights: HeightField;
  #freeArrows: THREE.Group[] = [];
  #freeStones: THREE.Group[] = [];
  #live: Flight[] = [];

  constructor(scene: THREE.Scene, heights: HeightField) {
    this.#scene = scene;
    this.#heights = heights;
  }

  /** Projectiles currently in the air (tests and forensics). */
  get liveCount(): number {
    return this.#live.length;
  }

  /**
   * Loose one arrow, ground coordinates to ground coordinates; the
   * heights (and the release/strike offsets above them) are sampled
   * here. `feetY` overrides the shooter's ground level for a man who is
   * not standing on the terrain — a tower's roof post — and the release
   * height rides above it as usual.
   */
  spawn(
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
    feetY?: number,
  ): void {
    this.#launch(
      this.#freeArrows,
      makeArrow,
      fromX,
      (feetY ?? this.#heights.at(fromX, fromZ)) + RELEASE_H,
      fromZ,
      toX,
      toZ,
      ARROW_SPEED,
      // A low lob that grows with the range — a long shot visibly rises,
      // a close one barely leaves the line.
      0.07,
      0.5,
    );
  }

  /** The levy's overhand stone: slower and steeper than the arrow, from
   * above the thrower's head. Same `feetY` contract as spawn. */
  spawnStone(
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
    feetY?: number,
  ): void {
    this.#launch(
      this.#freeStones,
      makeStone,
      fromX,
      (feetY ?? this.#heights.at(fromX, fromZ)) + STONE_RELEASE_H,
      fromZ,
      toX,
      toZ,
      STONE_SPEED,
      // Twice the arrow's rise per tile: a rock is lobbed, not shot.
      0.14,
      0.9,
    );
  }

  #launch(
    pool: THREE.Group[],
    make: () => THREE.Group,
    fromX: number,
    fromY: number,
    fromZ: number,
    toX: number,
    toZ: number,
    speed: number,
    arcPerTile: number,
    arcMax: number,
  ): void {
    const toY = this.#heights.at(toX, toZ) + STRIKE_H;
    const run = Math.hypot(toX - fromX, toZ - fromZ);
    // The full 3D length: a roof shot's plunge is flight time too.
    const dist = Math.hypot(run, toY - fromY);
    // Point-blank: the flight would be one frame of mesh inside two
    // bodies. The draw-and-loose pose carries that fight on its own.
    if (dist < 0.6) return;
    let node = pool.pop();
    if (!node) {
      node = make();
      this.#scene.add(node);
    }
    node.visible = true;
    const f: Flight = {
      node,
      pool,
      fromX,
      fromY,
      fromZ,
      toX,
      toY,
      toZ,
      // The lob rises with the ground covered, not the plunge: a straight
      // drop off a roof needs no extra loft to read as thrown.
      arc: Math.min(0.1 + run * arcPerTile, arcMax),
      t: 0,
      dur: dist / speed,
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
        f.pool.push(f.node);
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
