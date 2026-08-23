import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { tileCount, tileIdx } from '../shared/grid';
import { HeightField } from '../render/heightField';
import { screenToBuilding, screenToGround, worldToScreen, type BuildingProbe } from './picking';

const SIZE = 48;
const CANVAS = { clientWidth: 1280, clientHeight: 720 } as HTMLCanvasElement;

/** The castle: a 3x3 footprint at (14,14), and how tall its model stands. */
const ID = 7;
const X0 = 14;
const Z0 = 14;
const W = 3;
const CENTER = X0 + W / 2;
const TOP = 3.2;

/** Flat ground, so the only thing standing up on it is the building. */
function flat(): HeightField {
  return new HeightField(new Float32Array(tileCount(SIZE)), SIZE);
}

/** The game's rig, in miniature: orthographic, pitched 35°, yawed 30°. */
function camera(): THREE.OrthographicCamera {
  const halfH = 15;
  const aspect = CANVAS.clientWidth / CANVAS.clientHeight;
  const cam = new THREE.OrthographicCamera(-halfH * aspect, halfH * aspect, halfH, -halfH, 0.1, 400);
  const pitch = (35 * Math.PI) / 180;
  const yaw = Math.PI / 6;
  const dir = new THREE.Vector3(
    Math.cos(pitch) * Math.sin(yaw),
    Math.sin(pitch),
    Math.cos(pitch) * Math.cos(yaw),
  );
  cam.position.set(CENTER, 0, CENTER).addScaledVector(dir, 90);
  cam.lookAt(CENTER, 0, CENTER);
  cam.updateMatrixWorld();
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  return cam;
}

/** The castle on the map, drawn `top` tall — 0 stands for a renderer that
 * has not measured it (or none at all), which is the old plate-only pick. */
function probe(top: number): BuildingProbe {
  const buildingAt = new Int32Array(tileCount(SIZE)).fill(-1);
  for (let z = Z0; z < Z0 + W; z++) {
    for (let x = X0; x < X0 + W; x++) buildingAt[tileIdx(x, z, SIZE)] = ID;
  }
  return {
    idAt: (x, z) => {
      const tx = Math.floor(x);
      const tz = Math.floor(z);
      if (tx < 0 || tz < 0 || tx >= SIZE || tz >= SIZE) return -1;
      return buildingAt[tileIdx(tx, tz, SIZE)]!;
    },
    heightOf: (id) => (id === ID ? top : 0),
    tallest: () => top,
  };
}

/** Where on screen a world point lands. */
function at(cam: THREE.Camera, x: number, y: number, z: number): { x: number; y: number } {
  return worldToScreen(cam, CANVAS, x, y, z);
}

describe('screenToBuilding', () => {
  it('picks a castle clicked on its roof, where the ground plane reads past it', () => {
    const cam = camera();
    const heights = flat();
    const roof = at(cam, CENTER, TOP, CENTER);

    // The bug this exists to fix: the ground under the roof's pixels is
    // tiles away behind the building, so a plate-only pick selects nothing.
    const ground = screenToGround(cam, CANVAS, roof.x, roof.y, heights)!;
    expect(Math.floor(ground.x) < X0 || Math.floor(ground.z) < Z0).toBe(true);
    expect(screenToBuilding(cam, CANVAS, roof.x, roof.y, heights, probe(0))).toBe(-1);

    expect(screenToBuilding(cam, CANVAS, roof.x, roof.y, heights, probe(TOP))).toBe(ID);
  });

  it('picks anywhere up the walls, not just at the top', () => {
    const cam = camera();
    const heights = flat();
    for (const y of [0.4, 1.1, 2, 2.9]) {
      const p = at(cam, CENTER, y, CENTER);
      expect(screenToBuilding(cam, CANVAS, p.x, p.y, heights, probe(TOP))).toBe(ID);
    }
  });

  it('still picks the plate the building stands on', () => {
    const cam = camera();
    const heights = flat();
    const base = at(cam, CENTER, 0, CENTER);
    expect(screenToBuilding(cam, CANVAS, base.x, base.y, heights, probe(TOP))).toBe(ID);
    expect(screenToBuilding(cam, CANVAS, base.x, base.y, heights, probe(0))).toBe(ID);
  });

  it('leaves bare ground bare, over the roofline and beside it', () => {
    const cam = camera();
    const heights = flat();
    // Well clear of the footprint on the ground...
    const away = at(cam, CENTER + 8, 0, CENTER + 8);
    expect(screenToBuilding(cam, CANVAS, away.x, away.y, heights, probe(TOP))).toBe(-1);
    // ...and the sky over the castle, which the walk must not reach up into.
    const sky = at(cam, CENTER, TOP + 1.5, CENTER);
    expect(screenToBuilding(cam, CANVAS, sky.x, sky.y, heights, probe(TOP))).toBe(-1);
  });

  it('answers with the building nearest the camera, not the one behind it', () => {
    const cam = camera();
    const heights = flat();
    const tall = probe(TOP);
    // A point on the ground just behind the castle: hidden by the towers
    // from this camera, so the towers are what a click there means.
    const reach = TOP / Math.tan((35 * Math.PI) / 180);
    const behindX = CENTER - reach * Math.sin(Math.PI / 6);
    const behindZ = CENTER - reach * Math.cos(Math.PI / 6);
    expect(tall.idAt(behindX, behindZ)).toBe(-1);
    const p = at(cam, behindX, 0, behindZ);
    expect(screenToBuilding(cam, CANVAS, p.x, p.y, heights, tall)).toBe(ID);
  });
});
