import { describe, expect, it } from 'vitest';
import { Terrain, TileResource } from '../sim/map.ts';
import { applyBrush } from './brush.ts';
import { createBlankMap } from './editorMap.ts';
import { parseEditorMap, serializeEditorMap } from './format.ts';
import type { EditorMapFile } from './format.ts';

function sampleState() {
  // play 64 -> grid 128, play region [32, 96).
  const state = createBlankMap({ size: 64, players: 4 });
  state.name = 'Crossroads';
  applyBrush(state, { kind: 'terrain', terrain: Terrain.Water }, 52, 46, { radius: 4, folds: 4 });
  applyBrush(state, { kind: 'terrain', terrain: Terrain.Rock }, 76, 76, { radius: 3, folds: 4 });
  applyBrush(state, { kind: 'resource', res: TileResource.Wood }, 62, 62, { radius: 3, folds: 4 });
  applyBrush(state, { kind: 'height', dir: 1 }, 72, 52, { radius: 5, folds: 4 });
  return state;
}

describe('map file round-trip', () => {
  it('preserves everything an authored map is', () => {
    const state = sampleState();
    const back = parseEditorMap(serializeEditorMap(state));
    expect(back.name).toBe('Crossroads');
    expect(back.players).toBe(4);
    expect(back.starts).toEqual(state.starts);
    expect(back.map.play).toBe(64);
    expect(back.map.size).toBe(128);
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
    for (const play of [63, 62, 130, 65.5]) {
      expect(() => parseEditorMap(fileOf((f) => ((f as { play: number }).play = play)))).toThrow(
        /playable size/,
      );
    }
    // The grid must be exactly gridFor(play) — the canonical margin.
    expect(() => parseEditorMap(fileOf((f) => ((f as { size: number }).size = 64)))).toThrow(
      /grid size/,
    );
  });

  it('rejects short arrays and out-of-range values', () => {
    expect(() => parseEditorMap(fileOf((f) => f.terrain.pop()))).toThrow(/terrain/);
    expect(() => parseEditorMap(fileOf((f) => (f.terrain[0] = 7)))).toThrow(/terrain value/);
    expect(() => parseEditorMap(fileOf((f) => (f.resource[0] = 9)))).toThrow(/resource value/);
    expect(() => parseEditorMap(fileOf((f) => (f.resourceAmt[0] = 300)))).toThrow(/amount/);
    expect(() => parseEditorMap(fileOf((f) => (f.height[0] = Infinity)))).toThrow(/height/);
  });

  it('rejects starts that do not fit the seats or the play area', () => {
    expect(() => parseEditorMap(fileOf((f) => f.starts.pop()))).toThrow(/starts/);
    // (10, 40) is real grid ground, but scenery margin — not a legal start.
    expect(() => parseEditorMap(fileOf((f) => (f.starts[0] = { x: 10, y: 40 })))).toThrow(
      /out of bounds/,
    );
    expect(() => parseEditorMap(fileOf((f) => (f.starts[0] = { x: 94, y: 40 })))).toThrow(
      /out of bounds/,
    );
    expect(() => parseEditorMap(fileOf((f) => ((f as { players: number }).players = 5)))).toThrow(
      /player/,
    );
  });
});
