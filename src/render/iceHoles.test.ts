import * as THREE from 'three';
import {describe, expect, it} from 'vitest';
import {WATER_LEVEL} from '../sim/map';
import type {HeightField} from './heightField';
import {
  DRILL_SECONDS,
  HOLE_ICE,
  IceHoles,
  LINE_AHEAD,
  LINE_RIGHT,
} from './iceHoles';
import type {PierInfo} from './pierFit';
import {iceOver} from './waterMesh';

/** A deck running due east, fishing spot at (31.6, 30). Facing +x, a
 * man's right hand is on +z. */
const PIER: PierInfo = {
  bx: 30,
  bz: 30,
  baseX: 30,
  baseZ: 30,
  spotX: 31.6,
  spotZ: 30,
  yaw: Math.PI / 2,
  deckY: 0.14,
  turn: 0,
  scale: 1,
};

function lake(bed = -1, frozen = 1) {
  const scene = new THREE.Scene();
  const water = {
    frozen: {value: frozen},
    colors: {
      shallow: new THREE.Color(),
      mid: new THREE.Color(),
      deep: new THREE.Color(0x335577),
    },
  };
  const heights = {at: () => bed} as unknown as HeightField;
  return {holes: new IceHoles(scene, heights, water), water, scene};
}

/** What is drawn at the hole: the ring, the water in it, the auger. */
function drawn(scene: THREE.Scene): {
  ring: boolean;
  water: boolean;
  auger: boolean;
} {
  const [ring, auger] = scene.children;
  return {
    ring: ring?.visible ?? false,
    water: (ring?.visible ?? false) && (ring?.children[1]?.visible ?? false),
    auger: auger?.visible ?? false,
  };
}

describe('iceOver', () => {
  it('is no ice on dry ground, all ice on a hard lake, none on an open one', () => {
    expect(iceOver(0, 1)).toBe(0);
    expect(iceOver(-0.2, 1)).toBe(0);
    expect(iceOver(0.7, 1)).toBe(1);
    expect(iceOver(0.7, 0)).toBe(0);
  });

  it('takes in the shallows first', () => {
    // The lake drawn as it closes from its banks inward.
    expect(iceOver(0.1, 0.5)).toBeGreaterThan(iceOver(1.2, 0.5));
  });
});

describe('IceHoles', () => {
  it('wants no hole in open water', () => {
    expect(lake(-1, 0).holes.at(PIER)).toBeNull();
    // Nor where the line falls on the bank.
    expect(lake(0.2, 1).holes.at(PIER)).toBeNull();
  });

  it('cuts the hole where the line falls: ahead, and to his right', () => {
    const {holes} = lake();
    expect(holes.at(PIER)).not.toBeNull();
    const [hole] = holes.holes;
    expect(hole!.x).toBeCloseTo(PIER.spotX + LINE_AHEAD);
    expect(hole!.z).toBeCloseTo(PIER.spotZ + LINE_RIGHT);
  });

  it('is the same hole for whoever comes asking', () => {
    const {holes} = lake();
    expect(holes.at(PIER)).toBe(holes.at(PIER));
  });

  it('takes DRILL_SECONDS of the auger, which turns only while worked', () => {
    const {holes, scene} = lake();
    const hole = holes.at(PIER)!;
    holes.update();
    expect(drawn(scene)).toEqual({ring: false, water: false, auger: false});
    holes.drill(hole, DRILL_SECONDS / 2);
    holes.update();
    expect(hole.drilled).toBe(false);
    expect(drawn(scene)).toEqual({ring: true, water: false, auger: true});
    // Left alone, the auger is not drawn standing in the ice by itself.
    holes.update();
    expect(drawn(scene).auger).toBe(false);
    holes.drill(hole, DRILL_SECONDS / 2);
    holes.update();
    expect(hole.drilled).toBe(true);
    expect(drawn(scene)).toEqual({ring: true, water: true, auger: false});
  });

  it('bores down: the brace sinks with the bit', () => {
    const {holes} = lake();
    const hole = holes.at(PIER)!;
    const before = hole.knob.getWorldPosition(new THREE.Vector3());
    holes.drill(hole, DRILL_SECONDS * 0.9);
    const after = hole.knob.getWorldPosition(new THREE.Vector3());
    expect(after.y).toBeLessThan(before.y);
    // ...and stays above the ice it is boring into.
    expect(after.y).toBeGreaterThan(WATER_LEVEL);
  });

  it('goes with the ice', () => {
    const {holes, water, scene} = lake();
    holes.finish(PIER);
    holes.update();
    expect(holes.holes).toHaveLength(1);
    water.frozen.value = 0.5; // the deeps are going, and this is deep
    expect(iceOver(WATER_LEVEL + 1, 0.5)).toBeLessThan(HOLE_ICE);
    holes.update();
    expect(holes.holes).toHaveLength(0);
    expect(scene.children).toHaveLength(0);
    // Next winter's is a new one, dug from nothing.
    water.frozen.value = 1;
    expect(holes.at(PIER)?.drilled).toBe(false);
  });

  it('goes with the hut', () => {
    const {holes, scene} = lake();
    holes.finish(PIER);
    holes.setPiers([PIER]);
    expect(holes.holes).toHaveLength(1);
    holes.setPiers([]);
    expect(holes.holes).toHaveLength(0);
    expect(scene.children).toHaveLength(0);
  });
});
