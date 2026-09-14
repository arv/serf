import * as THREE from 'three';
import {describe, expect, it} from 'vitest';
import {butterflyQuad, wander} from './butterflies';

/** Where the sprite's head points at `yaw`: +Z at yaw 0, as the quad is built. */
function facing(yaw: number): [number, number] {
  return [Math.sin(yaw), Math.cos(yaw)];
}

/** The path's travel direction, measured rather than differentiated by hand. */
function travel(
  ax: number,
  az: number,
  phase: number,
  t: number,
): [number, number] {
  const h = 1e-4;
  const a = wander(ax, az, phase, t - h);
  const [x0, z0] = [a.x, a.z];
  const b = wander(ax, az, phase, t + h);
  const [dx, dz] = [b.x - x0, b.z - z0];
  const len = Math.hypot(dx, dz);
  return [dx / len, dz / len];
}

describe('butterfly wander', () => {
  // The heading used to be a hand-written derivative of the path that kept
  // only the first of its two loops, and the sprite it turned has its head
  // at the far end of the quad from the one the yaw convention assumes.
  // Either mistake alone can point a butterfly backwards down its own path.
  it('faces the way it is travelling, all the way round the loop', () => {
    for (const phase of [0, 1.234, 37.5, 99.1]) {
      for (let t = 0; t < 400; t += 0.1) {
        const [fx, fz] = facing(wander(3, -7, phase, t).yaw);
        const [vx, vz] = travel(3, -7, phase, t);
        // Dot of two unit vectors: 1 is nose first, -1 is tail first.
        expect(fx * vx + fz * vz).toBeGreaterThan(0.999);
      }
    }
  });

  it('stays a wander around its anchor, not a drift away from it', () => {
    for (let t = 0; t < 400; t += 0.1) {
      const {x, z} = wander(3, -7, 1.234, t);
      // Each axis is two loops deep, so neither ever reaches past their sum.
      expect(Math.abs(x - 3)).toBeLessThanOrEqual(1.7 + 0.5);
      expect(Math.abs(z + 7)).toBeLessThanOrEqual(1.7 + 0.5);
    }
  });
});

describe('butterfly quad', () => {
  const geometry = butterflyQuad();
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  /** Midpoint of the edge the sprite canvas's `edge` row is painted on. */
  const edge = (v: number): THREE.Vector3 => {
    const mid = new THREE.Vector3();
    let n = 0;
    for (let i = 0; i < position.count; i++) {
      if (uv.getY(i) !== v) continue;
      mid.add(new THREE.Vector3().fromBufferAttribute(position, i));
      n++;
    }
    return mid.divideScalar(n);
  };

  // flipY puts the canvas's top row — where the head and fore wings are
  // painted — at v = 1, and the yaw the heading is computed in calls +Z
  // forward. Aim the head anywhere else and the whole meadow flies tail
  // first, however right the heading itself is.
  it('points the painted head along +Z, the heading convention', () => {
    expect(edge(1).z).toBeGreaterThan(0);
    expect(edge(0).z).toBeLessThan(0);
  });

  it('lies flat, wingspan on x, so the flap squeeze still spans wings', () => {
    const normal = new THREE.Vector3().fromBufferAttribute(
      geometry.getAttribute('normal'),
      0,
    );
    expect(normal.y).toBeCloseTo(1);
    geometry.computeBoundingBox();
    const {min, max} = geometry.boundingBox!;
    expect(max.x - min.x).toBeCloseTo(0.22);
    expect(max.z - min.z).toBeCloseTo(0.17);
  });
});
