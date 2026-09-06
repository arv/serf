import * as THREE from 'three';
import {describe, expect, it, vi} from 'vitest';
import {tileIdx} from '../shared/grid';
import type {MapView} from '../sim/map';
import * as Terrain from '../sim/terrainEnum.ts';
import * as TileResource from '../sim/tileResourceEnum.ts';
import {HeightField} from './heightField';
import {CHUNK_TILES, ScatterMesh, SHAKE_SECS, shakeCurve} from './scatterMesh';

// Every sprite in here is painted on a 2D canvas, which node has none of.
// None of them reaches the instance matrices this file reads.
// The model pack never loads in node, and its fallbacks plant bamboo
// where the groves would be — but a shaking trunk is a GLB tree, so the
// chop tests need real tree archetypes. Three boxes stand in for them:
// what those tests read is the instance matrix, not the mesh.
vi.mock('./assets', () => ({
  glbTrees: (): {
    geometries: THREE.BufferGeometry[];
    material: THREE.Material;
  } => ({
    geometries: [
      new THREE.BoxGeometry(0.4, 1, 0.4),
      new THREE.BoxGeometry(0.5, 1, 0.5),
    ],
    material: new THREE.MeshBasicMaterial(),
  }),
  glbRocks: (): null => null,
  glbDoodads: (): null => null,
  glbForest: (): null => null,
}));

vi.mock('./spriteTextures', () => ({
  foliageMaterial: (): THREE.Material => new THREE.MeshBasicMaterial(),
  makeBushSprite: (): THREE.Texture => new THREE.Texture(),
  makeFlowerSprite: (): THREE.Texture => new THREE.Texture(),
  makeLeafSprite: (): THREE.Texture => new THREE.Texture(),
  makeStalkTexture: (): THREE.Texture => new THREE.Texture(),
}));

/**
 * Scatter is split into per-chunk meshes so the frustum can throw away the
 * timber the camera is not looking at. That split is invisible from
 * outside — until it is wrong, and then it is a grove that stays standing
 * after it has been felled, because the tile's instances were parked in a
 * mesh belonging to some other chunk.
 *
 * These tests hold the two halves of that to each other: every instance a
 * tile places lands in the mesh for that tile's own chunk, and removeTile
 * finds every one of them again.
 */

const SIZE = 96;
const PLAY = 64;

function woodedMap(): MapView {
  const n = SIZE * SIZE;
  const map: MapView = {
    size: SIZE,
    play: PLAY,
    terrain: new Uint8Array(n).fill(Terrain.Grass),
    resource: new Uint8Array(n),
    blocked: new Uint8Array(n),
    buildingAt: new Int16Array(n).fill(-1),
    pathLevel: new Uint8Array(n),
    height: new Float32Array(n).fill(0.6),
  };
  // Groves in four widely separated corners of the grid, so the tiles
  // that carry them cannot all fall in one chunk.
  for (const [cx, cy] of [
    [8, 8],
    [8, 80],
    [80, 8],
    [80, 80],
    [48, 48],
  ] as const) {
    for (let y = cy; y < cy + 6; y++) {
      for (let x = cx; x < cx + 6; x++) {
        map.resource[tileIdx(x, y, SIZE)] = TileResource.Wood;
      }
    }
  }
  return map;
}

function build(map: MapView): ScatterMesh {
  return new ScatterMesh(map, new HeightField(map.height, SIZE));
}

/** Every instance the group is currently drawing, as world positions. */
function standing(scatter: ScatterMesh): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  scatter.group.traverse(o => {
    if (!(o instanceof THREE.InstancedMesh)) return;
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      // removeTile parks what it hides far below the map.
      if (p.y > -50) out.push(p.clone());
    }
  });
  return out;
}

describe('ScatterMesh chunking', () => {
  it('keeps a tile’s instances in the mesh for that tile’s chunk', () => {
    const map = woodedMap();
    const scatter = build(map);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    let checked = 0;
    scatter.group.traverse(o => {
      if (!(o instanceof THREE.InstancedMesh)) return;
      // A chunk mesh is only ever handed instances standing inside its
      // own square, so every one of them shares a chunk with the first.
      let cx = -1;
      let cy = -1;
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m);
        p.setFromMatrixPosition(m);
        const tx = Math.floor(p.x / CHUNK_TILES);
        const ty = Math.floor(p.z / CHUNK_TILES);
        if (cx === -1) {
          cx = tx;
          cy = ty;
        }
        expect([tx, ty]).toEqual([cx, cy]);
        checked++;
      }
    });
    // Guard against the assertions above passing because nothing was
    // placed at all.
    expect(checked).toBeGreaterThan(100);
  });

  it('splits the map across more than one mesh per archetype', () => {
    const scatter = build(woodedMap());
    let meshes = 0;
    scatter.group.traverse(o => {
      if (o instanceof THREE.InstancedMesh) meshes++;
    });
    // Five groves in five corners of a 96 grid cannot share one chunk.
    expect(meshes).toBeGreaterThan(1);
  });

  it('gives every drawn mesh bounds tight enough to cull', () => {
    const scatter = build(woodedMap());
    scatter.group.traverse(o => {
      if (!(o instanceof THREE.InstancedMesh)) return;
      // Pinned at build time rather than left for three to work out on
      // the first frame that tests it — by then a felled grove would have
      // stretched it to the parked instances under the map.
      expect(o.boundingSphere).not.toBeNull();
      // A chunk is CHUNK_TILES across, so its contents cannot need a
      // sphere that would span the whole grid.
      expect(o.boundingSphere!.radius).toBeLessThan(CHUNK_TILES * 1.5);
    });
  });

  it('takes down exactly the tile it is asked for', () => {
    const map = woodedMap();
    const scatter = build(map);
    const before = standing(scatter);
    const tile = tileIdx(9, 81, SIZE); // inside the north-east grove
    scatter.removeTile(tile);
    const after = standing(scatter);
    expect(after.length).toBeLessThan(before.length);
    // Everything that went was standing on that tile, and everything on
    // that tile went.
    const onTile = (p: THREE.Vector3): boolean =>
      Math.floor(p.x) === 9 && Math.floor(p.z) === 81;
    expect(before.filter(onTile).length).toBeGreaterThan(0);
    expect(after.filter(onTile)).toHaveLength(0);
    expect(after.filter(p => !onTile(p))).toHaveLength(
      before.filter(p => !onTile(p)).length,
    );
  });

  it('clears felled groves on a full resync', () => {
    const map = woodedMap();
    const scatter = build(map);
    expect(standing(scatter).length).toBeGreaterThan(0);
    const cleared = {
      resource: new Uint8Array(SIZE * SIZE),
      buildingAt: new Int16Array(SIZE * SIZE).fill(-1),
    };
    scatter.resyncAll(cleared);
    // The groves are gone; the cosmetic dressing that was never
    // resource-driven is exempt and stays.
    const left = standing(scatter);
    for (const p of left) {
      expect(
        map.resource[tileIdx(Math.floor(p.x), Math.floor(p.z), SIZE)],
      ).not.toBe(TileResource.Wood);
    }
  });
});

/** The pose of every instance a tile is drawing right now. */
function posesOn(
  scatter: ScatterMesh,
  tx: number,
  tz: number,
): THREE.Matrix4[] {
  const out: THREE.Matrix4[] = [];
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  scatter.group.traverse(o => {
    if (!(o instanceof THREE.InstancedMesh)) return;
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      if (Math.floor(p.x) === tx && Math.floor(p.z) === tz && p.y > -50) {
        out.push(m.clone());
      }
    }
  });
  return out;
}

/** Which way an instance's trunk points. Trees are planted with a lean of
 * their own (#placeGrove hashes one in), so a shake is only ever read
 * here as a change from the rest pose, never as absolute tilt. */
function trunkUp(m: THREE.Matrix4): THREE.Vector3 {
  return new THREE.Vector3(0, 1, 0)
    .applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(m))
    .normalize();
}

/** How far the tile's trees have swung from `rest`, in radians, and which
 * one moved most. Instance order is the traversal's, which is stable. */
function swing(
  scatter: ScatterMesh,
  rest: THREE.Matrix4[],
  tx: number,
  tz: number,
): {angle: number; from: THREE.Vector3; to: THREE.Vector3} {
  let out = {
    angle: 0,
    from: new THREE.Vector3(0, 1, 0),
    to: new THREE.Vector3(0, 1, 0),
  };
  for (const [i, m] of posesOn(scatter, tx, tz).entries()) {
    const from = trunkUp(rest[i]!);
    const to = trunkUp(m);
    const angle = from.angleTo(to);
    if (angle > out.angle) out = {angle, from, to};
  }
  return out;
}

describe('shakeCurve', () => {
  it('is still while the axe is falling and once the ring dies', () => {
    expect(shakeCurve(-0.2, 6)).toBe(0);
    expect(shakeCurve(0, 6)).toBe(0);
    expect(shakeCurve(SHAKE_SECS, 6)).toBe(0);
    expect(shakeCurve(SHAKE_SECS + 1, 6)).toBe(0);
  });

  it('swings hardest early and decays', () => {
    // A quarter period in is the first swing's peak.
    const first = Math.abs(shakeCurve(1 / (4 * 6), 6));
    const later = Math.abs(shakeCurve(1 / (4 * 6) + 3 / 6, 6));
    expect(first).toBeGreaterThan(0.5);
    expect(later).toBeLessThan(first / 2);
  });
});

/**
 * One tile of wood in the middle of a meadow. The chop tests need to know
 * which tree the axe found: in a six-by-six grove the nearest trunk to a
 * given spot depends on the placement hashes, and here it can only be one
 * of the two standing on this tile.
 */
function loneGroveMap(): MapView {
  const n = SIZE * SIZE;
  return {
    size: SIZE,
    play: PLAY,
    terrain: new Uint8Array(n).fill(Terrain.Grass),
    resource: (() => {
      const r = new Uint8Array(n);
      r[tileIdx(TX, TZ, SIZE)] = TileResource.Wood;
      return r;
    })(),
    blocked: new Uint8Array(n),
    buildingAt: new Int16Array(n).fill(-1),
    pathLevel: new Uint8Array(n),
    height: new Float32Array(n).fill(0.6),
  };
}

const TX = 40;
const TZ = 24;

describe('ScatterMesh chop', () => {
  it('leaves the woods standing until an axe lands', () => {
    const scatter = build(loneGroveMap());
    const rest = posesOn(scatter, TX, TZ);
    expect(rest.length).toBeGreaterThan(0);
    scatter.update(0.1);
    expect(swing(scatter, rest, TX, TZ).angle).toBeLessThan(1e-6);
  });

  it('shakes the struck tree and stands it back up', () => {
    const scatter = build(loneGroveMap());
    const rest = posesOn(scatter, TX, TZ);
    scatter.chop(TX + 0.5, TZ + 0.5);
    // A quarter period into the ring: near the first swing's peak.
    scatter.update(1 / (4 * 6));
    expect(swing(scatter, rest, TX, TZ).angle).toBeGreaterThan(0.005);
    // Ring it out; the last write puts the rest pose back exactly.
    for (let i = 0; i < 60; i++) scatter.update(1 / 60);
    const after = posesOn(scatter, TX, TZ);
    expect(after).toHaveLength(rest.length);
    for (const [i, m] of after.entries()) {
      expect(m.elements).toEqual(rest[i]!.elements);
    }
  });

  it('holds the tree still for the lead the sound was given', () => {
    const scatter = build(loneGroveMap());
    const rest = posesOn(scatter, TX, TZ);
    scatter.chop(TX + 0.5, TZ + 0.5, 0.25);
    // Mid-swing: the cue is booked, the axe has not arrived.
    scatter.update(0.2);
    expect(swing(scatter, rest, TX, TZ).angle).toBeLessThan(1e-6);
    // Past the bite, on the same clock the delay was counted in.
    scatter.update(0.05 + 1 / (4 * 6));
    expect(swing(scatter, rest, TX, TZ).angle).toBeGreaterThan(0.005);
  });

  it('tips the trunk away from the woodcutter', () => {
    const scatter = build(loneGroveMap());
    const rest = posesOn(scatter, TX, TZ);
    // Swung from due south of the tile: the canopy must rock north.
    scatter.chop(TX + 0.5, TZ - 0.4);
    scatter.update(1 / (4 * 6));
    const {angle, from, to} = swing(scatter, rest, TX, TZ);
    expect(angle).toBeGreaterThan(0.005);
    // Where the treetop went, against where it was resting.
    const moved = to.clone().sub(from);
    expect(moved.z).toBeGreaterThan(0);
    expect(Math.abs(moved.x)).toBeLessThan(Math.abs(moved.z));
  });

  it('swings at nothing in a clearing', () => {
    const scatter = build(loneGroveMap());
    const rest = posesOn(scatter, TX, TZ);
    // Open meadow, tiles away from the wood: no trunk, nothing to advance.
    scatter.chop(TX + 8, TZ + 8);
    scatter.update(1 / (4 * 6));
    expect(swing(scatter, rest, TX, TZ).angle).toBeLessThan(1e-6);
  });

  it('drops a felled tree mid-shiver', () => {
    const scatter = build(loneGroveMap());
    scatter.chop(TX + 0.5, TZ + 0.5);
    scatter.update(1 / (4 * 6));
    scatter.removeTile(tileIdx(TX, TZ, SIZE));
    // The last blow must not put a felled trunk back on the map.
    scatter.update(1 / 60);
    expect(posesOn(scatter, TX, TZ)).toHaveLength(0);
  });
});
