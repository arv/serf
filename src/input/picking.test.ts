import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { tileCount, tileIdx, tileX } from '../shared/grid';
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

/** A hillside falling away from the camera by `fall` per tile of x, level
 * with the sea at the castle's center — the ground a mine or a fishery is
 * allowed to stand on (world.ts exempts both from the half-unit corner-drop
 * rule the rest of the settlement obeys). Away from the camera is the
 * telling direction: that is where a ray leaving the roof runs on to, over
 * ground falling out from under it. */
function slope(fall: number): HeightField {
  const h = new Float32Array(tileCount(SIZE));
  for (let i = 0; i < h.length; i++) h[i] = (tileX(i, SIZE) - CENTER) * fall;
  return new HeightField(h, SIZE);
}

/** The game's rig, in miniature: orthographic, pitched 35°, yawed 30°. */
function camera(): THREE.OrthographicCamera {
  const halfH = 15;
  const aspect = CANVAS.clientWidth / CANVAS.clientHeight;
  const cam = new THREE.OrthographicCamera(
    -halfH * aspect,
    halfH * aspect,
    halfH,
    -halfH,
    0.1,
    400,
  );
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

/** The castle on the map, drawn `top` tall from a base at `base`. A top of 0
 * stands for a renderer that has not measured it (or none at all), which is
 * the plate-only pick this all started as. */
function probe(top: number, base = 0): BuildingProbe {
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
    baseOf: (id) => (id === ID ? base : 0),
    ceiling: () => (top > 0 ? base + top : Number.NEGATIVE_INFINITY),
  };
}

/** A screen point as the (px, py) pair the pick functions take. */
function pt(p: { x: number; y: number }): [number, number] {
  return [p.x, p.y];
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
    // ...and the sky past the far roofline, which the walk must not reach up
    // into: the ray under those pixels clears the footprint entirely.
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

  it('measures a hillside building from its own base, not the ground it overhangs', () => {
    const cam = camera();
    const heights = slope(0.25);
    // A building stands level on the ground under its center, so its downhill
    // corner overhangs ground well below that — here by more than the box's
    // own headroom, which is what a terrain-following probe gets wrong.
    const base = heights.at(CENTER, CENTER);
    const downhill = X0 + 0.35;
    expect(base - heights.at(downhill, CENTER)).toBeGreaterThan(0.25);

    const hill = probe(TOP, base);
    const middle = at(cam, CENTER, base + TOP, CENTER);
    expect(screenToBuilding(cam, CANVAS, middle.x, middle.y, heights, hill)).toBe(ID);
    // The roof over the overhanging corner: the same roof, and clickable.
    const corner = at(cam, downhill, base + TOP, CENTER);
    expect(screenToBuilding(cam, CANVAS, corner.x, corner.y, heights, hill)).toBe(ID);
    // And its plate, which is the tile whatever else is true of the slope.
    const plate = at(cam, CENTER, base, CENTER);
    expect(screenToBuilding(cam, CANVAS, plate.x, plate.y, heights, hill)).toBe(ID);
  });

  it('climbs to an absolute ceiling, so a bluff cannot call the walk off early', () => {
    const cam = camera();
    // A mine's bluff — half a unit of drop per tile. A ray leaving the roof's
    // downhill edge runs a long way down the hill before it meets ground, so
    // the walk back up starts far below and far out, and by the time it
    // reaches the roof the hillside beneath it has fallen away by more than
    // the building's own height. Measured against that ground the ray reads
    // as clear of every roof while it is still inside this one.
    const heights = slope(0.5);
    const base = heights.at(CENTER, CENTER);
    const hill = probe(TOP, base);
    const roof = base + TOP;
    const downhill = X0 + 0.4;
    // The ground under the ray, where the walk has to start, is a storey and
    // a half below the roof's own height above it.
    const landed = screenToGround(cam, CANVAS, ...pt(at(cam, downhill, roof, CENTER)), heights)!;
    expect(hill.idAt(landed.x, landed.z)).toBe(-1);
    expect(roof - heights.at(landed.x, landed.z)).toBeGreaterThan(TOP + 1);

    for (const y of [roof, base + TOP * 0.6, base + 0.3]) {
      const p = at(cam, downhill, y, CENTER);
      expect(screenToBuilding(cam, CANVAS, p.x, p.y, heights, hill)).toBe(ID);
    }
  });
});
