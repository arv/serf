import * as THREE from 'three';
import {describe, expect, it, vi} from 'vitest';
import {tileIdx} from '../shared/grid';
import type {MapView} from '../sim/map';
import * as Terrain from '../sim/terrainEnum.ts';
import * as TileResource from '../sim/tileResourceEnum.ts';
import {HeightField} from './heightField';
import {CHUNK_TILES, ScatterMesh} from './scatterMesh';

// Every sprite in here is painted on a 2D canvas, which node has none of.
// None of them reaches the instance matrices this file reads.
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
