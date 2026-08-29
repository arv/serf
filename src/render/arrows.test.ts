import * as THREE from 'three';
import {describe, expect, it} from 'vitest';
import {Arrows} from './arrows';
import type {HeightField} from './heightField';

/** Flat world at height 0 — the flights only sample `at`. */
const flat = {at: () => 0} as unknown as HeightField;

function rig(): {scene: THREE.Scene; arrows: Arrows} {
  const scene = new THREE.Scene();
  return {scene, arrows: new Arrows(scene, flat)};
}

describe('arrow flights', () => {
  it('flies to the mark and retires there', () => {
    const {scene, arrows} = rig();
    arrows.spawn(10, 10, 15, 10);
    expect(arrows.liveCount).toBe(1);
    const node = scene.children[0]!;
    expect(node.visible).toBe(true);
    expect(node.position.x).toBeCloseTo(10);
    expect(node.position.y).toBeGreaterThan(0); // leaves at bow height
    // 5 tiles at 11 tiles/sec is under half a second of flight.
    for (let i = 0; i < 20 && arrows.liveCount > 0; i++) arrows.update(0.05);
    expect(arrows.liveCount).toBe(0);
    expect(node.visible).toBe(false);
  });

  it('arcs above the straight line mid-flight', () => {
    const {scene, arrows} = rig();
    arrows.spawn(10, 10, 15, 10);
    const dur = 5 / 11;
    arrows.update(dur / 2);
    const node = scene.children[0]!;
    // The chord between release (~0.53) and strike (~0.38) heights never
    // tops 0.53; the apex of the lob does.
    expect(node.position.y).toBeGreaterThan(0.6);
    expect(node.position.x).toBeCloseTo(12.5);
  });

  it('holds still on a paused frame', () => {
    const {scene, arrows} = rig();
    arrows.spawn(10, 10, 15, 10);
    const node = scene.children[0]!;
    const before = node.position.clone();
    arrows.update(0);
    expect(node.position.x).toBe(before.x);
    expect(arrows.liveCount).toBe(1);
  });

  it('recycles retired arrows instead of growing the scene', () => {
    const {scene, arrows} = rig();
    arrows.spawn(10, 10, 15, 10);
    arrows.update(1); // whole flight in one step
    expect(arrows.liveCount).toBe(0);
    arrows.spawn(20, 20, 24, 20);
    expect(arrows.liveCount).toBe(1);
    expect(scene.children).toHaveLength(1); // same node, back in the air
    expect(scene.children[0]!.visible).toBe(true);
  });

  it('swallows point-blank shots', () => {
    const {scene, arrows} = rig();
    arrows.spawn(10, 10, 10.3, 10);
    expect(arrows.liveCount).toBe(0);
    expect(scene.children).toHaveLength(0);
  });
});
