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
  return {id, x, y, kind: 5, owner, hpPct: 255, carrying: 0, action};
}

function rig(units: UnitSnapshot[]): SceneSync {
  const sab = new SharedArrayBuffer(SAB_BYTES);
  const writer = new SabWriter(sab);
  const reader = new SabReader(sab);
  writer.publish(units);
  reader.poll(0);
  return new SceneSync(new THREE.Scene(), reader, flat, 0);
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
