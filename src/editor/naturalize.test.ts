import { describe, expect, it } from 'vitest';
import { tileIdx, tileX, tileY } from '../shared/grid.ts';
import { WATER_LEVEL, inPlayArea } from '../sim/map.ts';
import { applyBrush } from './brush.ts';
import { createBlankMap } from './editorMap.ts';
import { naturalize } from './naturalize.ts';
import * as Terrain from '../sim/terrainEnum.ts';

function paintedState() {
  // play 64 -> grid 112; a symmetric lake and range, 4-fold.
  const state = createBlankMap({ size: 64, players: 4 });
  applyBrush(state, { kind: 'terrain', terrain: Terrain.Water }, 52, 46, { radius: 5, folds: 4 });
  applyBrush(state, { kind: 'terrain', terrain: Terrain.Rock }, 76, 76, { radius: 3, folds: 4 });
  return state;
}

describe('naturalize', () => {
  it('shelves painted beds and eases meadows toward shores', () => {
    const state = paintedState();
    const size = state.map.size;
    const changed = naturalize(state, 4);
    expect(changed.length).toBeGreaterThan(0);
    let shoreMeadow = 0;
    for (let i = 0; i < state.map.terrain.length; i++) {
      const h = state.map.height[i]!;
      if (state.map.terrain[i] === Terrain.Water) {
        expect(h).toBeLessThan(WATER_LEVEL); // every bed stays honest
      } else {
        expect(h).toBeGreaterThan(0.03);
      }
      // Meadow right on a bank sits low, near worldgen's shore height.
      if (state.map.terrain[i] === Terrain.Grass && h < 0.2) shoreMeadow++;
    }
    expect(shoreMeadow).toBeGreaterThan(0);
    // And the flat blank plain actually rolls now.
    const heights = new Set<number>();
    for (let y = 40; y < 88; y++) {
      for (let x = 40; x < 88; x++) {
        if (state.map.terrain[tileIdx(x, y, size)] === Terrain.Grass) {
          heights.add(Math.round(state.map.height[tileIdx(x, y, size)]! * 100));
        }
      }
    }
    expect(heights.size).toBeGreaterThan(10);
  });

  it('keeps a kaleidoscope-symmetric map exactly symmetric', () => {
    const state = paintedState();
    const size = state.map.size;
    naturalize(state, 4);
    for (let i = 0; i < state.map.height.length; i++) {
      const x = tileX(i, size);
      const y = tileY(i, size);
      const j = tileIdx(size - 1 - y, x, size);
      expect(Math.abs(state.map.height[j]! - state.map.height[i]!)).toBeLessThan(1e-6);
    }
  });

  it('touches heights only — classes, resources and blocked stay put', () => {
    const state = paintedState();
    const terrain = Uint8Array.from(state.map.terrain);
    const resource = Uint8Array.from(state.map.resource);
    const blocked = Uint8Array.from(state.map.blocked);
    naturalize(state, 4);
    expect(state.map.terrain).toEqual(terrain);
    expect(state.map.resource).toEqual(resource);
    expect(state.map.blocked).toEqual(blocked);
    // Play-area membership is untouched by construction, but assert one
    // sample anyway: the rule reads terrain, not heights.
    expect(inPlayArea(state.map, 10, 10)).toBe(false);
  });
});
