import * as THREE from 'three';
import {describe, expect, it} from 'vitest';
import {
  ACTION,
  SAB_BYTES,
  SabReader,
  SabWriter,
  type UnitSnapshot,
} from '../protocol/sabLayout';
import type {HeightField} from './heightField';
import {SceneSync} from './sceneSync';

/**
 * The tower's render-side target pick (nearestEnemyInto) reads straight
 * off the latest publish, so it is testable without the GLB pipeline:
 * publish a roster, poll, ask. The full update() path needs loaded
 * character assets and stays exercised by hand and by the field guide.
 */

const flat = {at: () => 0} as unknown as HeightField;

function unit(
  id: number,
  x: number,
  y: number,
  owner: number,
  action: number = ACTION.idle,
): UnitSnapshot {
  return {id, x, y, kind: 5, owner, hpPct: 255, maxHp: 80, carrying: 0, action};
}

function rig(units: UnitSnapshot[]): SceneSync {
  const sab = new SharedArrayBuffer(SAB_BYTES);
  const writer = new SabWriter(sab);
  const reader = new SabReader(sab);
  writer.publish(units);
  reader.poll(0);
  return new SceneSync(new THREE.Scene(), reader, flat);
}

describe('nearestEnemyInto', () => {
  const out = {x: 0, y: 0};

  it('picks the closest enemy in radius and never a friend', () => {
    const sync = rig([
      unit(1, 30.5, 30, 0), // own man, closest of all
      unit(2, 33, 30, 255), // bandit, 3 tiles out
      unit(3, 35, 30, 255), // bandit, 5 tiles out
    ]);
    expect(sync.nearestEnemyInto(30, 30, 0, 7, out)).toBe(true);
    expect(out).toEqual({x: 33, y: 30});
  });

  it('shoots past a corpse to the living', () => {
    const sync = rig([unit(1, 32, 30, 255, ACTION.dead), unit(2, 34, 30, 255)]);
    expect(sync.nearestEnemyInto(30, 30, 0, 7, out)).toBe(true);
    expect(out.x).toBe(34);
  });

  it('holds fire on an empty radius', () => {
    const sync = rig([unit(1, 40, 40, 255)]);
    expect(sync.nearestEnemyInto(30, 30, 0, 7, out)).toBe(false);
  });
});

/**
 * Does `mesh` reach the screen after `other`?
 *
 * The queue comes first and renderOrder second, because that is the rule
 * the renderer follows: it runs the whole opaque list, then the
 * transmissive one, then the transparent one, and renderOrder only sorts
 * objects WITHIN their own list. An overlay that draws with no depth test
 * has nothing else keeping it on top, so the list it lands in is the
 * whole of its claim to being drawn last.
 */
function drawsAfter(mesh: THREE.Mesh, other: THREE.Mesh): boolean {
  const queue = (o: THREE.Mesh): number =>
    (o.material as THREE.Material).transparent ? 1 : 0;
  if (queue(mesh) !== queue(other)) return queue(mesh) > queue(other);
  return mesh.renderOrder > other.renderOrder;
}

describe('the hp bars over the men', () => {
  /** The bars are the one thing the sync hangs on the scene that refuses
   * the depth test; the festival auras beside them take it. */
  function bars(scene: THREE.Scene): THREE.Mesh {
    const found = scene.children.filter(
      (o): o is THREE.Mesh =>
        o instanceof THREE.Mesh &&
        !Array.isArray(o.material) &&
        o.material.depthTest === false,
    );
    expect(found).toHaveLength(1);
    return found[0]!;
  }

  it('draws after the prints on the ground, not before them', () => {
    const scene = new THREE.Scene();
    const sab = new SharedArrayBuffer(SAB_BYTES);
    const reader = new SabReader(sab);
    new SabWriter(sab).publish([unit(1, 30, 30, 0)]);
    reader.poll(0);
    new SceneSync(scene, reader, flat);

    // Stand in for the footprint mesh, which needs a canvas to build its
    // sprite: what matters here is the draw state it carries — a
    // transparent decal in the ordinary render order, depth-tested
    // against the world and writing nothing back.
    const prints = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({transparent: true, depthWrite: false}),
    );

    // Opaque, the bars drew before every print in the game however high
    // their renderOrder — and a print that won its own depth test then
    // painted over a bar that had written no depth to defend itself, which
    // is a man's boot marks drawn across his own health bar.
    expect(drawsAfter(bars(scene), prints)).toBe(true);
  });
});
