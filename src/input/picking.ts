import * as THREE from 'three';
import type { HeightField } from '../render/heightField';

const ndc = new THREE.Vector3();
const origin = new THREE.Vector3();
const dir = new THREE.Vector3();

/**
 * Analytic picking — no Raycaster. Ground positions come from intersecting
 * the camera ray with the terrain: a y=0 plane hit refined against the
 * height field (a few fixed-point steps converge fast on gentle hills).
 * Unit picking projects unit positions to screen space instead.
 */
export function screenToGround(
  camera: THREE.Camera,
  canvas: HTMLCanvasElement,
  px: number,
  py: number,
  heights?: HeightField,
): { x: number; z: number } | null {
  ndc.set((px / canvas.clientWidth) * 2 - 1, -(py / canvas.clientHeight) * 2 + 1, -1);
  origin.copy(ndc).unproject(camera);
  ndc.z = 1;
  dir.copy(ndc).unproject(camera).sub(origin).normalize();
  if (Math.abs(dir.y) < 1e-6) return null;
  let t = -origin.y / dir.y;
  if (t < 0) return null;
  if (heights) {
    for (let i = 0; i < 4; i++) {
      const hx = origin.x + dir.x * t;
      const hz = origin.z + dir.z * t;
      t = (heights.at(hx, hz) - origin.y) / dir.y;
    }
  }
  return { x: origin.x + dir.x * t, z: origin.z + dir.z * t };
}

const world = new THREE.Vector3();

/** Project a world position to canvas pixels. */
export function worldToScreen(
  camera: THREE.Camera,
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
  z: number,
): { x: number; y: number } {
  world.set(x, y, z).project(camera);
  return {
    x: ((world.x + 1) / 2) * canvas.clientWidth,
    y: ((1 - world.y) / 2) * canvas.clientHeight,
  };
}
