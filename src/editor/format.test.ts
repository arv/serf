import { describe, expect, it } from 'vitest';
import { Terrain, TileResource } from '../sim/map.ts';
import { applyBrush } from './brush.ts';
import { createBlankMap } from './editorMap.ts';
import { parseEditorMap, serializeEditorMap } from './format.ts';
import type { EditorMapFile } from './format.ts';

function sampleState() {
  const state = createBlankMap({ size: 64, players: 4 });
  state.name = 'Crossroads';
  applyBrush(state, { kind: 'terrain', terrain: Terrain.Water }, 20, 14, { radius: 4, folds: 4 });
  applyBrush(state, { kind: 'terrain', terrain: Terrain.Rock }, 44, 44, { radius: 3, folds: 4 });
  applyBrush(state, { kind: 'resource', res: TileResource.Wood }, 30, 30, { radius: 3, folds: 4 });
  applyBrush(state, { kind: 'height', dir: 1 }, 40, 20, { radius: 5, folds: 4 });
  return state;
}

describe('map file round-trip', () => {
  it('preserves everything an authored map is', () => {
    const state = sampleState();
    const back = parseEditorMap(serializeEditorMap(state));
    expect(back.name).toBe('Crossroads');
    expect(back.players).toBe(4);
    expect(back.starts).toEqual(state.starts);
    expect(back.map.size).toBe(64);
    expect(back.map.terrain).toEqual(state.map.terrain);
    expect(back.map.resource).toEqual(state.map.resource);
    expect(back.map.resourceAmt).toEqual(state.map.resourceAmt);
    expect(back.map.blocked).toEqual(state.map.blocked); // rebuilt, not stored
    for (let i = 0; i < state.map.height.length; i++) {
      expect(Math.abs(back.map.height[i]! - state.map.height[i]!)).toBeLessThanOrEqual(1e-3);
    }
    expect(back.map.buildingAt.every((b) => b === -1)).toBe(true);
    expect(back.map.wear.every((w) => w === 0)).toBe(true);
    expect(back.map.pathLevel.every((p) => p === 0)).toBe(true);
  });
});

describe('map file validation', () => {
  function fileOf(mutate: (f: EditorMapFile) => void): string {
    const f = JSON.parse(serializeEditorMap(sampleState())) as EditorMapFile;
    mutate(f);
    return JSON.stringify(f);
  }

  it('rejects garbage and wrong tags', () => {
    expect(() => parseEditorMap('not json at all')).toThrow(/not JSON/);
    expect(() => parseEditorMap('{"format":"other"}')).toThrow(/format/);
    expect(() => parseEditorMap(fileOf((f) => ((f as { version: number }).version = 2)))).toThrow(
      /version/,
    );
  });

  it('rejects bad sizes', () => {
    for (const size of [63, 62, 130, 65.5]) {
      expect(() => parseEditorMap(fileOf((f) => ((f as { size: number }).size = size)))).toThrow(
        /size/,
      );
    }
  });

  it('rejects short arrays and out-of-range values', () => {
    expect(() => parseEditorMap(fileOf((f) => f.terrain.pop()))).toThrow(/terrain/);
    expect(() => parseEditorMap(fileOf((f) => (f.terrain[0] = 7)))).toThrow(/terrain value/);
    expect(() => parseEditorMap(fileOf((f) => (f.resource[0] = 9)))).toThrow(/resource value/);
    expect(() => parseEditorMap(fileOf((f) => (f.resourceAmt[0] = 300)))).toThrow(/amount/);
    expect(() => parseEditorMap(fileOf((f) => (f.height[0] = Infinity)))).toThrow(/height/);
  });

  it('rejects starts that do not fit the seats or the map', () => {
    expect(() => parseEditorMap(fileOf((f) => f.starts.pop()))).toThrow(/starts/);
    expect(() => parseEditorMap(fileOf((f) => (f.starts[0] = { x: 62, y: 10 })))).toThrow(
      /out of bounds/,
    );
    expect(() => parseEditorMap(fileOf((f) => ((f as { players: number }).players = 5)))).toThrow(
      /player/,
    );
  });
});
