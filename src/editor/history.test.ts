import { describe, expect, it } from 'vitest';
import { tileIdx } from '../shared/grid.ts';
import { applyBrush } from './brush.ts';
import { createBlankMap } from './editorMap.ts';
import { EditorHistory } from './history.ts';
import * as Terrain from '../sim/terrainEnum.ts';
import * as TileResource from '../sim/tileResourceEnum.ts';

function paintSomething(state: ReturnType<typeof createBlankMap>, x: number, y: number) {
  return applyBrush(state, { kind: 'terrain', terrain: Terrain.Water }, x, y, {
    radius: 3,
    folds: 2,
  });
}

describe('EditorHistory', () => {
  it('undoes a stroke back to the exact prior ground and blocks', () => {
    const state = createBlankMap({ size: 64, players: 2 });
    const before = {
      terrain: Uint8Array.from(state.map.terrain),
      height: Float32Array.from(state.map.height),
      blocked: Uint8Array.from(state.map.blocked),
    };
    const history = new EditorHistory();
    history.record(state);
    const painted = paintSomething(state, 52, 52);
    expect(painted.length).toBeGreaterThan(0);

    const result = history.undo(state)!;
    expect(new Set(result.tiles)).toEqual(new Set(painted));
    expect(state.map.terrain).toEqual(before.terrain);
    expect(state.map.height).toEqual(before.height);
    expect(state.map.blocked).toEqual(before.blocked);
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);
  });

  it('redo replays the stroke; a new action clears the redo stack', () => {
    const state = createBlankMap({ size: 64, players: 2 });
    const history = new EditorHistory();
    history.record(state);
    paintSomething(state, 52, 52);
    const after = Uint8Array.from(state.map.terrain);

    history.undo(state);
    const redone = history.redo(state)!;
    expect(redone.tiles.length).toBeGreaterThan(0);
    expect(state.map.terrain).toEqual(after);

    history.undo(state);
    history.record(state); // a fresh stroke begins
    applyBrush(state, { kind: 'resource', res: TileResource.Rock }, 60, 60, {
      radius: 2,
      folds: 1,
    });
    expect(history.canRedo()).toBe(false);
  });

  it('restores in place — the render side’s array references stay live', () => {
    const state = createBlankMap({ size: 64, players: 2 });
    const heightRef = state.map.height;
    const history = new EditorHistory();
    history.record(state);
    paintSomething(state, 52, 52);
    history.undo(state);
    expect(state.map.height).toBe(heightRef); // same buffer, not a swap
  });

  it('tracks start drags', () => {
    const state = createBlankMap({ size: 64, players: 2 });
    const original = state.starts.map((s) => ({ ...s }));
    const history = new EditorHistory();
    history.record(state);
    state.starts[0] = { x: 50, y: 50 };
    const result = history.undo(state)!;
    expect(result.starts).toBe(true);
    expect(result.tiles).toEqual([]);
    expect(state.starts).toEqual(original);
  });

  it('undo keeps kaleidoscope-symmetric ground symmetric', () => {
    const state = createBlankMap({ size: 64, players: 4 });
    const size = state.map.size;
    const history = new EditorHistory();
    history.record(state);
    applyBrush(state, { kind: 'terrain', terrain: Terrain.Water }, 52, 46, {
      radius: 4,
      folds: 4,
    });
    history.record(state);
    applyBrush(state, { kind: 'terrain', terrain: Terrain.Rock }, 70, 70, {
      radius: 3,
      folds: 4,
    });
    history.undo(state); // the rock goes; the water stays
    const t = state.map.terrain;
    let water = 0;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === Terrain.Rock) throw new Error('rock survived its undo');
      if (t[i] === Terrain.Water) water++;
    }
    expect(water).toBeGreaterThan(0);
    // Still rot-90 invariant after a partial rewind.
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        expect(t[tileIdx(size - 1 - y, x, size)]).toBe(t[tileIdx(x, y, size)]);
      }
    }
  });
});
