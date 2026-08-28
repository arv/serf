import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { HeightField } from './heightField';
import { Spoil, TerrainMesh, spoilOf, type SpoilKind } from './terrainMesh';
import { tileIdx } from '../shared/grid';
import { Terrain, type MapView } from '../sim/map';
import { BuildingTypeId } from '../sim/defs/buildings';

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
  return new TerrainMesh(map, new HeightField(map.height as Float32Array, SIZE), () => spoil);
}

function colors(m: TerrainMesh): Float32Array {
  const attr = (m.mesh.geometry as THREE.BufferGeometry).getAttribute('color');
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
