import { describe, expect, it } from 'vitest';
import { gridFor, tileCount, tileIdx } from '../shared/grid.ts';
import { inPlayArea } from '../sim/map.ts';
import { createBlankMap, defaultStarts, validateForPlay } from './editorMap.ts';
import { rotateStart } from './symmetry.ts';
import * as Terrain from '../sim/terrainEnum.ts';

describe('createBlankMap', () => {
  it('builds a flat all-grass grid with the canonical scenery margin', () => {
    const state = createBlankMap({ size: 96, players: 2 });
    expect(state.map.play).toBe(96);
    expect(state.map.size).toBe(gridFor(96));
    expect(state.players).toBe(2);
    expect(state.starts).toHaveLength(2);
    const size = state.map.size;
    expect(state.map.terrain.length).toBe(tileCount(size));
    expect(state.map.terrain.every((t) => t === Terrain.Grass)).toBe(true);
    // Playable ground is open; the scenery ring is blocked by rule.
    for (let y = 0; y < size; y += 7) {
      for (let x = 0; x < size; x += 7) {
        expect(state.map.blocked[tileIdx(x, y, size)]).toBe(inPlayArea(state.map, x, y) ? 0 : 1);
      }
    }
    expect(state.map.buildingAt.every((b) => b === -1)).toBe(true);
    expect(validateForPlay(state)).toEqual([]);
  });

  it('clamps the playable side to the even legal range', () => {
    expect(createBlankMap({ size: 63, players: 1 }).map.play).toBe(64);
    expect(createBlankMap({ size: 97, players: 1 }).map.play).toBe(96);
    expect(createBlankMap({ size: 999, players: 1 }).map.play).toBe(128);
    expect(createBlankMap({ size: 64, players: 1 }).map.size).toBe(gridFor(64));
  });
});

describe('defaultStarts', () => {
  it('keeps the classic solo center start (grid center == play center)', () => {
    const area = { size: gridFor(96), play: 96 };
    expect(defaultStarts(area, 1)).toEqual([{ x: area.size / 2 - 2, y: area.size / 2 - 2 }]);
  });

  it('is rotationally symmetric for 2, 3 and 4 players and stays in play', () => {
    for (const players of [2, 3, 4]) {
      for (const play of [64, 96, 128]) {
        const area = { size: gridFor(play), play };
        const starts = defaultStarts(area, players);
        expect(starts).toHaveLength(players);
        for (let k = 1; k < players; k++) {
          expect(starts[k]).toEqual(rotateStart(starts[0]!, area.size, k, players));
        }
        const c = area.size / 2;
        const d0 = Math.hypot(starts[0]!.x + 1.5 - c, starts[0]!.y + 1.5 - c);
        for (const s of starts) {
          expect(Math.hypot(s.x + 1.5 - c, s.y + 1.5 - c)).toBeCloseTo(d0, 0);
          expect(inPlayArea(area, s.x, s.y)).toBe(true);
          expect(inPlayArea(area, s.x + 2, s.y + 2)).toBe(true);
        }
      }
    }
  });
});

describe('validateForPlay', () => {
  it('flags a start painted into a lake', () => {
    const state = createBlankMap({ size: 64, players: 2 });
    const s = state.starts[1]!;
    state.map.terrain[tileIdx(s.x + 1, s.y + 1, state.map.size)] = Terrain.Water;
    const problems = validateForPlay(state);
    expect(problems.some((p) => p.includes('player 2'))).toBe(true);
  });

  it('flags rival starts cut apart by water', () => {
    const state = createBlankMap({ size: 64, players: 2 });
    const size = state.map.size;
    // A full water wall across the play area between the two starts.
    for (let x = 0; x < size; x++) {
      state.map.terrain[tileIdx(x, size / 2, size)] = Terrain.Water;
    }
    const problems = validateForPlay(state);
    expect(problems.some((p) => p.includes('cut off'))).toBe(true);
    // A one-tile causeway reconnects them.
    state.map.terrain[tileIdx(size / 2, size / 2, size)] = Terrain.Grass;
    expect(validateForPlay(state)).toEqual([]);
  });

  it('flags starts in the scenery margin and overlapping starts', () => {
    const state = createBlankMap({ size: 64, players: 2 });
    state.starts[0] = { x: 2, y: 40 }; // deep in the margin
    state.starts[1] = { x: 3, y: 41 };
    const problems = validateForPlay(state);
    expect(problems.some((p) => p.includes('playable'))).toBe(true);
    expect(problems.some((p) => p.includes('on top of'))).toBe(true);
  });
});
