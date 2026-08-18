import { describe, expect, it } from 'vitest';
import { tileIdx, tileX, tileY } from '../shared/grid.ts';
import { Terrain, TileResource, WATER_LEVEL, inPlayArea } from '../sim/map.ts';
import { HEIGHT_STEP, RESOURCE_AMOUNTS, applyBrush, applyStroke } from './brush.ts';
import { createBlankMap } from './editorMap.ts';

/** Rotate a full tile array a quarter turn about the center (fold-4 map). */
function rot90<T extends Uint8Array | Float32Array>(arr: T, size: number): T {
  const out = new (arr.constructor as new (n: number) => T)(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const x = tileX(i, size);
    const y = tileY(i, size);
    out[tileIdx(size - 1 - y, x, size)] = arr[i]!;
  }
  return out;
}

// createBlankMap({size: 64}) => play 64, grid 128, play region [32, 96).

describe('kaleidoscope symmetry of painting', () => {
  it('fold-4 water painting leaves the map rot-90 invariant', () => {
    const state = createBlankMap({ size: 64, players: 4 });
    const size = state.map.size;
    applyBrush(state, { kind: 'terrain', terrain: Terrain.Water }, 52.3, 46.7, {
      radius: 4,
      folds: 4,
    });
    applyBrush(state, { kind: 'terrain', terrain: Terrain.Rock }, 72.1, 72.9, {
      radius: 2.5,
      folds: 4,
    });
    for (const key of ['terrain', 'resource', 'blocked'] as const) {
      expect(rot90(state.map[key], size)).toEqual(state.map[key]);
    }
    const rotH = rot90(state.map.height, size);
    for (let i = 0; i < rotH.length; i++) {
      expect(Math.abs(rotH[i]! - state.map.height[i]!)).toBeLessThan(1e-6);
    }
  });

  it('fold-4 height sculpting stays rot-90 invariant, even across the center', () => {
    const state = createBlankMap({ size: 64, players: 4 });
    const size = state.map.size;
    // A stamp near the grid center: the four fold discs overlap each other.
    applyBrush(state, { kind: 'height', dir: 1 }, 65.5, 63.0, { radius: 6, folds: 4 });
    const rotH = rot90(state.map.height, size);
    for (let i = 0; i < rotH.length; i++) {
      expect(Math.abs(rotH[i]! - state.map.height[i]!)).toBeLessThan(1e-6);
    }
  });

  it('a tile in two overlapping fold discs is raised exactly once', () => {
    const state = createBlankMap({ size: 64, players: 4 });
    const size = state.map.size;
    const center = size / 2;
    const before = state.map.height[tileIdx(center, center, size)]!;
    // Radius big enough that every fold disc covers the center tile.
    applyBrush(state, { kind: 'height', dir: 1 }, center + 1, center + 1, { radius: 5, folds: 4 });
    const after = state.map.height[tileIdx(center, center, size)]!;
    // One application is at most one full step; four would exceed it.
    expect(after - before).toBeGreaterThan(0);
    expect(after - before).toBeLessThanOrEqual(HEIGHT_STEP + 1e-9);
  });
});

describe('terrain brush invariants', () => {
  it('water tiles end below the waterline, cleared and blocked', () => {
    const state = createBlankMap({ size: 64, players: 1 });
    applyBrush(state, { kind: 'resource', res: TileResource.Wood }, 52, 52, {
      radius: 3,
      folds: 1,
    });
    const dirty = applyBrush(state, { kind: 'terrain', terrain: Terrain.Water }, 52, 52, {
      radius: 3,
      folds: 1,
    });
    expect(dirty.length).toBeGreaterThan(0);
    for (const i of dirty) {
      expect(state.map.terrain[i]).toBe(Terrain.Water);
      expect(state.map.height[i]!).toBeLessThan(WATER_LEVEL);
      expect(state.map.resource[i]).toBe(TileResource.None);
      expect(state.map.blocked[i]).toBe(1);
    }
  });

  it('grass repaint lifts drowned ground and unblocks it (in the play area)', () => {
    const state = createBlankMap({ size: 64, players: 1 });
    applyBrush(state, { kind: 'terrain', terrain: Terrain.Water }, 52, 52, {
      radius: 3,
      folds: 1,
    });
    const dirty = applyBrush(state, { kind: 'terrain', terrain: Terrain.Grass }, 52, 52, {
      radius: 3,
      folds: 1,
    });
    for (const i of dirty) {
      expect(state.map.terrain[i]).toBe(Terrain.Grass);
      expect(state.map.height[i]!).toBeGreaterThan(WATER_LEVEL);
      expect(state.map.blocked[i]).toBe(0);
    }
  });

  it('painted scenery margin stays blocked — the play-area rule holds', () => {
    const state = createBlankMap({ size: 64, players: 1 });
    // (10, 52) is deep in the margin ring.
    const dirty = applyBrush(state, { kind: 'terrain', terrain: Terrain.Grass }, 10, 52, {
      radius: 2,
      folds: 1,
    });
    // Blank margin is already grass; repaint changes nothing — but water
    // then grass round-trips and must stay blocked throughout.
    expect(dirty).toEqual([]);
    applyBrush(state, { kind: 'terrain', terrain: Terrain.Water }, 10, 52, { radius: 2, folds: 1 });
    const back = applyBrush(state, { kind: 'terrain', terrain: Terrain.Grass }, 10, 52, {
      radius: 2,
      folds: 1,
    });
    expect(back.length).toBeGreaterThan(0);
    for (const i of back) expect(state.map.blocked[i]).toBe(1);
  });
});

describe('resource brush', () => {
  it('places worldgen amounts on grass and refuses water', () => {
    const state = createBlankMap({ size: 64, players: 1 });
    applyBrush(state, { kind: 'terrain', terrain: Terrain.Water }, 72, 72, {
      radius: 3,
      folds: 1,
    });
    const onGrass = applyBrush(state, { kind: 'resource', res: TileResource.GoldDep }, 52, 52, {
      radius: 2,
      folds: 1,
    });
    expect(onGrass.length).toBeGreaterThan(0);
    for (const i of onGrass) {
      expect(state.map.resource[i]).toBe(TileResource.GoldDep);
      expect(state.map.resourceAmt[i]).toBe(RESOURCE_AMOUNTS[TileResource.GoldDep]);
      expect(state.map.blocked[i]).toBe(0); // deposits are walkable rocky ground
    }
    const onWater = applyBrush(state, { kind: 'resource', res: TileResource.Wood }, 72, 72, {
      radius: 1,
      folds: 1,
    });
    expect(onWater).toEqual([]);
  });

  it('the eraser clears code and amount', () => {
    const state = createBlankMap({ size: 64, players: 1 });
    const size = state.map.size;
    applyBrush(state, { kind: 'resource', res: TileResource.Wood }, 52, 52, {
      radius: 2,
      folds: 1,
    });
    const dirty = applyBrush(state, { kind: 'resource', res: TileResource.None }, 52, 52, {
      radius: 3,
      folds: 1,
    });
    expect(dirty.length).toBeGreaterThan(0);
    for (let i = 0; i < state.map.resource.length; i++) {
      expect(state.map.resource[i]).toBe(TileResource.None);
      expect(state.map.resourceAmt[i]).toBe(0);
      expect(state.map.blocked[i]).toBe(inPlayArea(state.map, tileX(i, size), tileY(i, size)) ? 0 : 1);
    }
  });
});

describe('applyStroke', () => {
  it('leaves no gaps along a fast diagonal drag', () => {
    const state = createBlankMap({ size: 96, players: 1 });
    const size = state.map.size;
    applyStroke(state, { kind: 'terrain', terrain: Terrain.Water }, 60, 60, 110, 105, {
      radius: 2,
      folds: 1,
    });
    // Every point along the segment must be within a painted disc: sample
    // the line densely and check the nearest tile center got painted.
    for (let t = 0; t <= 1; t += 0.01) {
      const x = Math.floor(60 + 50 * t);
      const y = Math.floor(60 + 45 * t);
      expect(state.map.terrain[tileIdx(x, y, size)]).toBe(Terrain.Water);
    }
  });

  it('height strokes accumulate across stamps but stay clamped', () => {
    const state = createBlankMap({ size: 64, players: 1 });
    for (let n = 0; n < 200; n++) {
      applyBrush(state, { kind: 'height', dir: 1 }, 52, 52, { radius: 3, folds: 1 });
    }
    const h = state.map.height[tileIdx(52, 52, state.map.size)]!;
    expect(h).toBeGreaterThan(2); // it really accumulated
    expect(h).toBeLessThanOrEqual(2.55); // and hit the land ceiling
  });
});
