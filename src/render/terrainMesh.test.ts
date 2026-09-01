import * as THREE from 'three';
import {describe, expect, it, vi} from 'vitest';
import {tileIdx} from '../shared/grid';
import * as BuildingTypeId from '../sim/defs/buildingTypeIdEnum.ts';
import type {MapView} from '../sim/map';
import * as Terrain from '../sim/terrainEnum.ts';
import {HeightField} from './heightField';
import {Spoil, TerrainMesh, spoilOf, type SpoilKind} from './terrainMesh';

// The speckle detail sheet is drawn on a 2D canvas, which node has none of.
// It multiplies over the vertex colours at draw time and never touches the
// colour attribute this file reads, so a bare texture stands in for it.
vi.mock('./groundTexture', () => ({
  makeGroundTexture: (): THREE.Texture => new THREE.Texture(),
}));

/**
 * The ground painter, exercised through the one path that can silently
 * disagree with itself: an incremental repaint has to land on exactly the
 * colours a full one would, and it only reaches as far as its apron. Spoil
 * throws two tiles where the trampled apron walks one, and the first cut of
 * it left repaintTiles recomputing the old one-tile ring — which showed up
 * as a mine whose outermost spoil appeared later, on some unrelated
 * repaint, or not at all.
 */

const SIZE = 16;
const PLAY = 12;
/** The footprint's north-west corner, well inside the play square. */
const AT = 7;

function blankMap(): MapView {
  const n = SIZE * SIZE;
  return {
    size: SIZE,
    play: PLAY,
    terrain: new Uint8Array(n).fill(Terrain.Grass),
    resource: new Uint8Array(n),
    blocked: new Uint8Array(n),
    buildingAt: new Int16Array(n).fill(-1),
    pathLevel: new Uint8Array(n),
    height: new Float32Array(n).fill(0.6),
  };
}

/** A 2x2 mine at AT, owned by building id 1. */
function footprint(): number[] {
  const tiles: number[] = [];
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) tiles.push(tileIdx(AT + dx, AT + dy, SIZE));
  }
  return tiles;
}

function mesh(map: MapView, spoil: SpoilKind = Spoil.Gold): TerrainMesh {
  return new TerrainMesh(
    map,
    new HeightField(map.height as Float32Array, SIZE),
    () => spoil,
  );
}

function colors(m: TerrainMesh): Float32Array {
  // Every chunk borrows the one colour attribute of the one lattice, so
  // any of them hands back the whole buffer this compares.
  const chunk = m.group.children[0] as THREE.Mesh;
  const attr = chunk.geometry.getAttribute('color');
  return Float32Array.from(attr.array as ArrayLike<number>);
}

describe('terrain spoil', () => {
  it('repaints incrementally to exactly what a full repaint draws', () => {
    // Built from the start, painted whole.
    const whole = blankMap();
    for (const t of footprint()) whole.buildingAt[t] = 1;
    const full = mesh(whole);
    full.repaintAll();

    // Placed after the fact, repainted only around the footprint — which is
    // what the game does when a building goes up (see WorldMirror.apply).
    const later = blankMap();
    const incremental = mesh(later);
    incremental.repaintAll();
    for (const t of footprint()) later.buildingAt[t] = 1;
    incremental.repaintTiles(footprint());

    expect(colors(incremental)).toEqual(colors(full));
  });

  it('throws two tiles clear of the footprint, and no further', () => {
    const bare = blankMap();
    const plain = mesh(bare, Spoil.None);
    plain.repaintAll();
    const before = colors(plain);

    const spoiled = blankMap();
    for (const t of footprint()) spoiled.buildingAt[t] = 1;
    const thrown = mesh(spoiled, Spoil.Gold);
    thrown.repaintAll();
    const after = colors(thrown);

    // Which rings the paint actually moved on. Per-vertex rather than per
    // tile: the painter samples its tile through a noise warp of up to
    // ±0.55 tiles, so any single vertex can read its neighbour's tile and
    // one sample proves nothing either way.
    const moved = new Set<number>();
    const p0 = (SIZE - PLAY) / 2;
    const grid = PLAY * 6;
    for (let row = 0; row <= grid; row++) {
      for (let col = 0; col <= grid; col++) {
        const v = row * (grid + 1) + col;
        if (Math.abs(after[v * 3]! - before[v * 3]!) <= 1e-4) continue;
        const tx = Math.floor(p0 + col / 6);
        const ty = Math.floor(p0 + row / 6);
        // Chebyshev distance to the 2x2 footprint at AT.
        const dx = Math.max(AT - tx, tx - (AT + 1), 0);
        const dy = Math.max(AT - ty, ty - (AT + 1), 0);
        moved.add(Math.max(dx, dy));
      }
    }
    // Ring 0 is the footprint, 1 the apron, 2 the edge of the throw. Ring 3
    // is the warp's overspill and is allowed; past that the apron in
    // repaintTiles would not cover what the painter drew.
    expect(moved.has(1)).toBe(true);
    expect(moved.has(2)).toBe(true);
    expect(Math.max(...moved)).toBeLessThanOrEqual(3);
  });

  it('names the four posts that spoil their ground, and only those', () => {
    expect(spoilOf(BuildingTypeId.quarry)).toBe(Spoil.Stone);
    expect(spoilOf(BuildingTypeId.ironMine)).toBe(Spoil.Iron);
    expect(spoilOf(BuildingTypeId.silverMine)).toBe(Spoil.Silver);
    expect(spoilOf(BuildingTypeId.goldMine)).toBe(Spoil.Gold);
    expect(spoilOf(BuildingTypeId.house)).toBe(Spoil.None);
    expect(spoilOf(BuildingTypeId.woodcutter)).toBe(Spoil.None);
    expect(spoilOf(undefined)).toBe(Spoil.None);
  });
});

/**
 * The ground is cut into chunk meshes so the frustum can throw away the
 * ground the camera is not looking at. They share one lattice and differ
 * only in which of its quads they index, which is what keeps the painting
 * above unaware of them — and what makes the split invisible until it is
 * wrong, at which point it is a hole in the world, or a chunk drawn twice,
 * or a square of ground that never culls.
 *
 * A valley wide enough to be cut up: the chunk edge is measured in tiles,
 * and the map the tests above use is narrower than one chunk.
 */
const WIDE = 64;
const WIDE_PLAY = 48;

function wideMap(): MapView {
  const n = WIDE * WIDE;
  return {
    size: WIDE,
    play: WIDE_PLAY,
    terrain: new Uint8Array(n).fill(Terrain.Grass),
    resource: new Uint8Array(n),
    blocked: new Uint8Array(n),
    buildingAt: new Int16Array(n).fill(-1),
    pathLevel: new Uint8Array(n),
    height: new Float32Array(n).fill(0.6),
  };
}

function wideMesh(): TerrainMesh {
  const map = wideMap();
  return new TerrainMesh(
    map,
    new HeightField(map.height, WIDE),
    () => Spoil.None,
  );
}

describe('terrain chunking', () => {
  /** The lattice edge in quads, read off the shared attribute rather than
   * assumed — SEG is the painter's business, not this test's. */
  function latticeEdge(m: TerrainMesh): number {
    const first = m.group.children[0] as THREE.Mesh;
    const verts = first.geometry.getAttribute('position').count;
    return Math.round(Math.sqrt(verts)) - 1;
  }

  /** Every triangle every chunk draws, as [a, b, c] vertex indices. */
  function triangles(m: TerrainMesh): number[][] {
    const out: number[][] = [];
    for (const child of m.group.children) {
      const index = (child as THREE.Mesh).geometry.index!;
      for (let i = 0; i < index.count; i += 3) {
        out.push([index.getX(i), index.getX(i + 1), index.getX(i + 2)]);
      }
    }
    return out;
  }

  it('covers every quad of the lattice exactly once', () => {
    const m = wideMesh();
    const grid = latticeEdge(m);
    const row = grid + 1;
    const tris = triangles(m);
    expect(tris).toHaveLength(grid * grid * 2);

    // Both triangles of a quad span the same two rows and columns, so the
    // lowest row and lowest column among a triangle's three vertices name
    // the quad it belongs to. (Its lowest vertex *index* does not: three
    // winds the second triangle from the north-east corner.) Counting
    // those says how many times each quad is drawn — twice for every quad
    // on the lattice and nothing else. A chunk that dropped a row leaves
    // zeroes; one that overlapped its neighbour leaves fours.
    const drawn = new Map<number, number>();
    for (const t of tris) {
      const r = Math.min(...t.map(v => (v / row) | 0));
      const c = Math.min(...t.map(v => v % row));
      const quad = r * grid + c;
      drawn.set(quad, (drawn.get(quad) ?? 0) + 1);
    }
    for (let r = 0; r < grid; r++) {
      for (let c = 0; c < grid; c++) {
        expect(drawn.get(r * grid + c)).toBe(2);
      }
    }
    expect(drawn.size).toBe(grid * grid);
  });

  it('cuts the lattice into more than one chunk', () => {
    expect(wideMesh().group.children.length).toBeGreaterThan(1);
  });

  it('bounds each chunk to its own ground, not the whole map', () => {
    const m = wideMesh();
    for (const child of m.group.children) {
      const geo = (child as THREE.Mesh).geometry;
      // Set explicitly, because three derives bounds from the whole shared
      // position attribute and pays no attention to the index — every
      // chunk would claim the whole valley, and none would ever be
      // rejected, which is the entire point of the split.
      expect(geo.boundingSphere).not.toBeNull();
      expect(geo.boundingSphere!.radius).toBeLessThan(WIDE_PLAY / 2);
      expect(geo.boundingBox).not.toBeNull();
    }
  });

  it('re-derives a sculpted chunk\u2019s bounds', () => {
    // The editor's path: move the ground, then ask for the culling bounds
    // back. Before the split this was one computeBoundingSphere over the
    // whole lattice; now every chunk has a box of its own to bring up to
    // date, and a chunk left on its old one culls away ground the player
    // just raised into view.
    const map = wideMap();
    const m = new TerrainMesh(
      map,
      new HeightField(map.height, WIDE),
      () => Spoil.None,
    );
    const grid = latticeEdge(m);
    const boxes = m.group.children.map(
      c => (c as THREE.Mesh).geometry.boundingBox!.max.y,
    );
    // Raise one tile well inside the play square into a hill.
    const tile = tileIdx(20, 20, WIDE);
    map.height[tile] = 9;
    m.reheightTiles([tile]);
    m.refreshBounds();
    const after = m.group.children.map(
      c => (c as THREE.Mesh).geometry.boundingBox!.max.y,
    );
    // Exactly the chunks the hill reaches grew; the rest stand where they
    // were, which is what makes the bounds worth having.
    expect(after.some((y, i) => y > boxes[i]!)).toBe(true);
    expect(after.every((y, i) => y >= boxes[i]!)).toBe(true);
    expect(grid).toBeGreaterThan(0);
  });

  it('gives every chunk the same colour buffer to paint into', () => {
    const m = wideMesh();
    const first = (m.group.children[0] as THREE.Mesh).geometry.getAttribute(
      'color',
    );
    for (const child of m.group.children) {
      // One buffer, uploaded once, painted in runs by repaintTiles. Two
      // buffers meeting along a shared edge would be two colours claiming
      // one vertex.
      expect((child as THREE.Mesh).geometry.getAttribute('color')).toBe(first);
    }
  });
});
