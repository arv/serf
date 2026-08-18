import { describe, expect, it } from 'vitest';
import { tileCount, tileIdx } from '../shared/grid.ts';
import { Terrain } from '../sim/map.ts';
import { createBlankMap, defaultStarts, validateForPlay } from './editorMap.ts';
import { rotateStart } from './symmetry.ts';

describe('createBlankMap', () => {
  it('builds a flat all-grass map with sane derived state', () => {
    const state = createBlankMap({ size: 96, players: 2 });
    expect(state.map.size).toBe(96);
    expect(state.players).toBe(2);
    expect(state.starts).toHaveLength(2);
    const tiles = tileCount(96);
    expect(state.map.terrain.length).toBe(tiles);
    expect(state.map.terrain.every((t) => t === Terrain.Grass)).toBe(true);
    expect(state.map.blocked.every((b) => b === 0)).toBe(true);
    expect(state.map.buildingAt.every((b) => b === -1)).toBe(true);
    expect(validateForPlay(state)).toEqual([]);
  });

  it('clamps size to the even legal range', () => {
    expect(createBlankMap({ size: 63, players: 1 }).map.size).toBe(64);
    expect(createBlankMap({ size: 97, players: 1 }).map.size).toBe(96);
    expect(createBlankMap({ size: 999, players: 1 }).map.size).toBe(128);
  });
});

describe('defaultStarts', () => {
  it('keeps the classic solo center start', () => {
    expect(defaultStarts(96, 1)).toEqual([{ x: 46, y: 46 }]);
  });

  it('is rotationally symmetric for 2, 3 and 4 players', () => {
    for (const players of [2, 3, 4]) {
      for (const size of [64, 96, 128]) {
        const starts = defaultStarts(size, players);
        expect(starts).toHaveLength(players);
        for (let k = 1; k < players; k++) {
          expect(starts[k]).toEqual(rotateStart(starts[0]!, size, k, players));
        }
        // Every seat the same distance from the center (footprint centers).
        const c = size / 2;
        const d0 = Math.hypot(starts[0]!.x + 1.5 - c, starts[0]!.y + 1.5 - c);
        for (const s of starts) {
          expect(Math.hypot(s.x + 1.5 - c, s.y + 1.5 - c)).toBeCloseTo(d0, 0);
        }
      }
    }
  });
});

describe('validateForPlay', () => {
  it('flags a start painted into a lake', () => {
    const state = createBlankMap({ size: 64, players: 2 });
    const s = state.starts[1]!;
    state.map.terrain[tileIdx(s.x + 1, s.y + 1, 64)] = Terrain.Water;
    const problems = validateForPlay(state);
    expect(problems.some((p) => p.includes('player 2'))).toBe(true);
  });

  it('flags starts off the edge and overlapping starts', () => {
    const state = createBlankMap({ size: 64, players: 2 });
    state.starts[0] = { x: 0, y: 10 };
    state.starts[1] = { x: 1, y: 11 };
    const problems = validateForPlay(state);
    expect(problems.some((p) => p.includes('edge'))).toBe(true);
    expect(problems.some((p) => p.includes('on top of'))).toBe(true);
  });
});
