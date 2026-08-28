import { describe, expect, it } from 'vitest';
import { bytesFromBase64, bytesToBase64 } from '../shared/base64.ts';
import { applyBrush } from './brush.ts';
import { createBlankMap } from './editorMap.ts';
import { parseEditorMap, serializeEditorMap, type EditorMapFile } from './format.ts';
import * as Terrain from '../sim/terrainEnum.ts';
import * as TileResource from '../sim/tileResourceEnum.ts';

function sampleState() {
  // play 64 -> grid 112, play region [24, 88).
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
    expect(back.map.size).toBe(112);
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

  /** The grids are base64, so a test that wants one bad tile has to say it
   * in bytes: decode, poke, re-encode. */
  function poke(
    f: EditorMapFile,
    key: 'terrain' | 'resource' | 'resourceAmt',
    tile: number,
    value: number,
  ): void {
    const bytes = bytesFromBase64(f[key]);
    bytes[tile] = value;
    f[key] = bytesToBase64(bytes);
  }

  /** A height in world units, through the file's millimetre encoding. */
  function pokeHeight(f: EditorMapFile, tile: number, value: number): void {
    const bytes = bytesFromBase64(f.height);
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setInt16(
      tile * 2,
      Math.round(value * 1000),
      true,
    );
    f.height = bytesToBase64(bytes);
  }

  function dropTile(f: EditorMapFile, key: 'terrain' | 'resource' | 'resourceAmt'): void {
    const bytes = bytesFromBase64(f[key]);
    f[key] = bytesToBase64(bytes.subarray(0, bytes.length - 1));
  }

  it('rejects garbage and wrong tags', () => {
    expect(() => parseEditorMap('not json at all')).toThrow(/not JSON/);
    expect(() => parseEditorMap('{"format":"other"}')).toThrow(/format/);
    expect(() => parseEditorMap(fileOf((f) => ((f as { version: number }).version = 3)))).toThrow(
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

  it('rejects short grids and out-of-range values', () => {
    expect(() => parseEditorMap(fileOf((f) => dropTile(f, 'terrain')))).toThrow(/terrain/);
    expect(() => parseEditorMap(fileOf((f) => (f.height = f.height.slice(4))))).toThrow(/height/);
    expect(() => parseEditorMap(fileOf((f) => poke(f, 'terrain', 0, 7)))).toThrow(/terrain value/);
    expect(() => parseEditorMap(fileOf((f) => poke(f, 'resource', 0, 9)))).toThrow(
      /resource value/,
    );
    // Well inside what an int16 of millimetres holds, well outside a world.
    expect(() => parseEditorMap(fileOf((f) => pokeHeight(f, 0, 9)))).toThrow(/height/);
  });

  it('rejects a grid that is not base64 at all', () => {
    expect(() => parseEditorMap(fileOf((f) => (f.terrain = '~~ not base64 ~~')))).toThrow(
      /terrain is not base64/,
    );
  });

  it('rejects cross-field states the editor can never produce', () => {
    // A resource standing in water.
    expect(() =>
      parseEditorMap(
        fileOf((f) => {
          poke(f, 'terrain', 0, Terrain.Water);
          poke(f, 'resource', 0, TileResource.Wood);
          poke(f, 'resourceAmt', 0, 6);
        }),
      ),
    ).toThrow(/non-grass/);
    // A resource code with nothing left in it.
    expect(() =>
      parseEditorMap(
        fileOf((f) => {
          poke(f, 'resource', 0, TileResource.Rock);
          poke(f, 'resourceAmt', 0, 0);
        }),
      ),
    ).toThrow(/no amount/);
    // An amount on an empty tile.
    expect(() =>
      parseEditorMap(
        fileOf((f) => {
          poke(f, 'resource', 0, TileResource.None);
          poke(f, 'resourceAmt', 0, 5);
        }),
      ),
    ).toThrow(/without a resource/);
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

/**
 * Version 1 is what the format looked like before the grids were base64:
 * the same fields carrying plain number arrays, heights in world units.
 * Nothing writes one any more, but a map saved in a browser's
 * localStorage outlives the build that wrote it, so they still open.
 */
describe('version 1 files', () => {
  type V1 = Omit<EditorMapFile, 'terrain' | 'resource' | 'resourceAmt' | 'height'> & {
    terrain: unknown[];
    resource: unknown[];
    resourceAmt: unknown[];
    height: unknown[];
  };

  function v1Of(mutate: (f: V1) => void = () => {}): string {
    const f = JSON.parse(serializeEditorMap(sampleState())) as EditorMapFile;
    const bytes = bytesFromBase64(f.height);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const height: number[] = [];
    for (let i = 0; i < bytes.length / 2; i++) height.push(view.getInt16(i * 2, true) / 1000);
    const old: V1 = {
      ...f,
      version: 1,
      terrain: [...bytesFromBase64(f.terrain)],
      resource: [...bytesFromBase64(f.resource)],
      resourceAmt: [...bytesFromBase64(f.resourceAmt)],
      height,
    };
    mutate(old);
    return JSON.stringify(old);
  }

  it('open to the same map a version 2 file does', () => {
    const state = sampleState();
    const now = parseEditorMap(serializeEditorMap(state));
    const then = parseEditorMap(v1Of());
    expect(then.name).toBe(now.name);
    expect(then.players).toBe(now.players);
    expect(then.starts).toEqual(now.starts);
    expect(then.map.terrain).toEqual(now.map.terrain);
    expect(then.map.resource).toEqual(now.map.resource);
    expect(then.map.resourceAmt).toEqual(now.map.resourceAmt);
    expect(then.map.height).toEqual(now.map.height);
  });

  it('are still screened for what a JSON array can hold', () => {
    expect(() => parseEditorMap(v1Of((f) => f.terrain.pop()))).toThrow(/terrain/);
    expect(() => parseEditorMap(v1Of((f) => (f.terrain[0] = 'grass')))).toThrow(/terrain/);
    expect(() => parseEditorMap(v1Of((f) => (f.resourceAmt[0] = 300)))).toThrow(/resourceAmt/);
    // JSON writes a non-finite number as null; null must not read as 0.
    expect(() => parseEditorMap(v1Of((f) => (f.height[0] = Infinity)))).toThrow(/height/);
  });
});
