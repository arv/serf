import { MAX_MAP_SIZE, MIN_MAP_SIZE, gridFor, tileCount } from '../shared/grid.ts';
import { Terrain, TileResource, inPlayArea, recomputeBlocked, type GameMap } from '../sim/map.ts';
import type { EditorMapState } from './editorMap.ts';

/**
 * The editor's map file: authored ground only. Derived state (`blocked`)
 * and match state (`buildingAt`, `wear`, `pathLevel`) are not part of an
 * authored map — they're rebuilt or zeroed on load, so an exported map is
 * always pristine. Typed arrays ride as plain number arrays, the save.ts
 * precedent.
 */
export interface EditorMapFile {
  format: 'serf-map';
  version: 1;
  name: string;
  /** Full grid side — always gridFor(play): the canonical scenery margin. */
  size: number;
  /** Playable side, centered in the grid. */
  play: number;
  players: number;
  starts: { x: number; y: number }[];
  terrain: number[];
  resource: number[];
  resourceAmt: number[];
  height: number[];
}

export function serializeEditorMap(state: EditorMapState): string {
  const file: EditorMapFile = {
    format: 'serf-map',
    version: 1,
    name: state.name,
    size: state.map.size,
    play: state.map.play,
    players: state.players,
    starts: state.starts.map((s) => ({ x: s.x, y: s.y })),
    terrain: [...state.map.terrain],
    resource: [...state.map.resource],
    resourceAmt: [...state.map.resourceAmt],
    // Heights are visual, three decimals is beyond what the mesh resolves —
    // and it halves the file.
    height: [...state.map.height].map((h) => Math.round(h * 1000) / 1000),
  };
  return JSON.stringify(file);
}

const TERRAIN_VALUES = new Set<number>(Object.values(Terrain));
const RESOURCE_VALUES = new Set<number>(Object.values(TileResource));

function bad(reason: string): never {
  throw new Error(`not a valid map file: ${reason}`);
}

/** Parse and validate a map file; throws a descriptive Error on anything off. */
export function parseEditorMap(json: string): EditorMapState {
  let file: EditorMapFile;
  try {
    file = JSON.parse(json) as EditorMapFile;
  } catch {
    bad('not JSON');
  }
  if (file?.format !== 'serf-map') bad('wrong format tag');
  if (file.version !== 1) bad(`unsupported version ${String(file.version)}`);
  const play = file.play;
  if (!Number.isInteger(play) || play < MIN_MAP_SIZE || play > MAX_MAP_SIZE || play % 2 !== 0) {
    bad(`bad playable size ${String(play)}`);
  }
  const size = file.size;
  if (size !== gridFor(play)) bad(`bad grid size ${String(size)} for playable ${String(play)}`);
  const tiles = tileCount(size);
  for (const key of ['terrain', 'resource', 'resourceAmt', 'height'] as const) {
    const arr = file[key];
    if (!Array.isArray(arr) || arr.length !== tiles) bad(`${key} is not ${tiles} tiles`);
  }
  if (!file.terrain.every((t) => TERRAIN_VALUES.has(t))) bad('unknown terrain value');
  if (!file.resource.every((r) => RESOURCE_VALUES.has(r))) bad('unknown resource value');
  if (!file.resourceAmt.every((a) => Number.isInteger(a) && a >= 0 && a <= 255)) {
    bad('resource amount out of range');
  }
  // Cross-field invariants the editor itself always keeps: resources
  // stand on grass only, and a resource code means a live amount (the
  // sim clears the code when a tile is worked dry).
  for (let i = 0; i < tiles; i++) {
    const res = file.resource[i]!;
    if (res !== TileResource.None) {
      if (file.terrain[i] !== Terrain.Grass) bad('resource on non-grass terrain');
      if (file.resourceAmt[i]! < 1) bad('resource with no amount');
    } else if (file.resourceAmt[i] !== 0) {
      bad('amount without a resource');
    }
  }
  if (!file.height.every((h) => Number.isFinite(h) && h >= -2 && h <= 3)) {
    bad('height out of range');
  }
  const players = file.players;
  if (!Number.isInteger(players) || players < 1 || players > 4) {
    bad(`bad player count ${String(players)}`);
  }
  if (!Array.isArray(file.starts) || file.starts.length !== players) {
    bad('starts do not match player count');
  }
  const area = { size, play };
  for (const s of file.starts) {
    if (!Number.isInteger(s?.x) || !Number.isInteger(s?.y)) bad('bad start spot');
    if (!inPlayArea(area, s.x, s.y) || !inPlayArea(area, s.x + 2, s.y + 2)) {
      bad('start out of bounds');
    }
  }

  const map: GameMap = {
    size,
    play,
    terrain: Uint8Array.from(file.terrain),
    resource: Uint8Array.from(file.resource),
    resourceAmt: Uint8Array.from(file.resourceAmt),
    blocked: new Uint8Array(tiles),
    buildingAt: new Int16Array(tiles).fill(-1),
    wear: new Float32Array(tiles),
    pathLevel: new Uint8Array(tiles),
    height: Float32Array.from(file.height),
  };
  recomputeBlocked(map);
  return {
    map,
    players,
    starts: file.starts.map((s) => ({ x: s.x, y: s.y })),
    name: typeof file.name === 'string' && file.name.trim() !== '' ? file.name : 'Untitled',
  };
}
