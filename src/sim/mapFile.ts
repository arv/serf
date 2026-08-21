import {
  bytesFromBase64,
  bytesToBase64,
  int16FromBase64,
  int16ToBase64,
} from '../shared/base64.ts';
import { MAX_MAP_SIZE, MIN_MAP_SIZE, gridFor, tileCount } from '../shared/grid.ts';
import {
  Terrain,
  TileResource,
  inPlayArea,
  recomputeBlocked,
  type GameMap,
  type StartSpot,
} from './map.ts';

/**
 * The serf-map file: authored ground only. Derived state (`blocked`) and
 * match state (`buildingAt`, `wear`, `pathLevel`) are not part of an
 * authored map — they're rebuilt or zeroed on load, so a map file is
 * always pristine.
 *
 * The tile grids ride as base64 rather than JSON number arrays: they are
 * typed-array bytes, and printing them as decimal digits and commas cost
 * nearly twice as much — a mission map fell from ~455 KB to ~246 KB when
 * they stopped being text. That is bytes in the repo, bytes over the
 * wire in a code-split chunk, and a parse the JSON reader does not have to
 * do 150 000 times. What it costs is hand-editing: a tile is no longer a
 * number you can find in the file (see defs/maps/README.md).
 *
 * Born in the map editor, but owned by the sim: the campaign's mission
 * maps are these files, checked into src/sim/defs/maps/ and built into
 * worlds by createWorld on whichever host owns the world — so the parse
 * has to live where every host can reach it. The editor imports from
 * here (src/editor/format.ts re-exports), never the other way around.
 */
export interface MapFile {
  /** 'serf-map' — typed loose so a JSON import satisfies the shape;
   * parseMapData is the gate that checks the actual tag. */
  format: string;
  version: number;
  name: string;
  /** Full grid side — always gridFor(play): the canonical scenery margin. */
  size: number;
  /** Playable side, centered in the grid. */
  play: number;
  players: number;
  starts: { x: number; y: number }[];
  /** One byte per tile, base64 — a Terrain value each. */
  terrain: string;
  /** One byte per tile, base64 — a TileResource value each. */
  resource: string;
  /** One byte per tile, base64. */
  resourceAmt: string;
  /** Two bytes per tile, base64: the height in millimetres, little-endian
   * int16. Heights are visual, and a millimetre is already finer than the
   * mesh resolves — the file has always rounded them to three decimals,
   * and this is that same number without the digits. The int16 range
   * (±32.767 world units) is two orders past anything a brush or worldgen
   * can sculpt; parsing bounds it far tighter still. */
  height: string;
}

/** Version 1: the same fields carrying plain number arrays instead, with
 * heights as decimals. Read but never written — an editor slot lives in a
 * browser's localStorage, and those outlive a format change. */
interface MapFileV1 extends Omit<MapFile, 'terrain' | 'resource' | 'resourceAmt' | 'height'> {
  terrain: number[];
  resource: number[];
  resourceAmt: number[];
  height: number[];
}

/** A parsed map file: a ready GameMap plus what worldgen normally computes
 * — how many seats the map is built for and where they start. */
export interface AuthoredMap {
  map: GameMap;
  /** 1..4 seats; starts.length === players. */
  players: number;
  starts: StartSpot[];
  name: string;
}

export function serializeMapFile(state: AuthoredMap): string {
  const file: MapFile = {
    format: 'serf-map',
    version: 2,
    name: state.name,
    size: state.map.size,
    play: state.map.play,
    players: state.players,
    starts: state.starts.map((s) => ({ x: s.x, y: s.y })),
    terrain: bytesToBase64(state.map.terrain),
    resource: bytesToBase64(state.map.resource),
    resourceAmt: bytesToBase64(state.map.resourceAmt),
    height: int16ToBase64(Int16Array.from(state.map.height, (h) => Math.round(h * 1000))),
  };
  return JSON.stringify(file);
}

const TERRAIN_VALUES = new Set<number>(Object.values(Terrain));
const RESOURCE_VALUES = new Set<number>(Object.values(TileResource));

function bad(reason: string): never {
  throw new Error(`not a valid map file: ${reason}`);
}

function decode(text: string, key: string): Uint8Array {
  try {
    return bytesFromBase64(text);
  } catch {
    bad(`${key} is not base64`);
  }
}

/** One byte-per-tile grid, from either encoding. A version 1 array is
 * screened element by element on the way in — JSON holds anything, and
 * `Uint8Array.from` would quietly turn a string or a NaN into a tile. */
function readBytes(
  file: MapFile | MapFileV1,
  key: 'terrain' | 'resource' | 'resourceAmt',
): Uint8Array {
  const raw = file[key];
  const tiles = tileCount(file.size);
  if (typeof raw === 'string') {
    const bytes = decode(raw, key);
    if (bytes.length !== tiles) bad(`${key} is not ${tiles} tiles`);
    return bytes;
  }
  if (!Array.isArray(raw) || raw.length !== tiles) bad(`${key} is not ${tiles} tiles`);
  if (!raw.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) bad(`${key} out of range`);
  return Uint8Array.from(raw);
}

/** The height grid, from either encoding. Both land on the same float32:
 * a v1 file's `0.243` and a v2 file's `243` millimetres are the same
 * number by the time they are tiles. */
function readHeights(file: MapFile | MapFileV1): Float32Array {
  const raw = file.height;
  const tiles = tileCount(file.size);
  const height = new Float32Array(tiles);
  if (typeof raw === 'string') {
    let millimetres: Int16Array;
    try {
      millimetres = int16FromBase64(raw);
    } catch {
      bad('height is not base64');
    }
    if (millimetres.length !== tiles) bad(`height is not ${tiles} tiles`);
    for (let i = 0; i < tiles; i++) height[i] = millimetres[i]! / 1000;
  } else {
    if (!Array.isArray(raw) || raw.length !== tiles) bad(`height is not ${tiles} tiles`);
    // Finite before it lands in the array: JSON writes Infinity as null,
    // and null would arrive as a perfectly plausible 0.
    if (!raw.every((h) => typeof h === 'number' && Number.isFinite(h))) bad('height out of range');
    height.set(raw);
  }
  // Sanity bounds, not sculpting bounds: the editor's brushes stay within
  // [-1.6, 2.55], but a map exported from worldgen carries its border
  // ranges — margin scenery peaks near 4.7 — and the file format must
  // accept any world the generator itself can roll.
  if (!height.every((h) => h >= -2 && h <= 5)) bad('height out of range');
  return height;
}

/** Parse a map file from its JSON text; throws a descriptive Error on
 * anything off. The editor's import path. */
export function parseMapJson(json: string): AuthoredMap {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    bad('not JSON');
  }
  return parseMapData(data);
}

/** Validate an already-parsed map file (a JSON import, an editor slot) and
 * build the GameMap. Every grid is decoded fresh, so two worlds built from
 * the same file never share tiles. */
export function parseMapData(data: unknown): AuthoredMap {
  const file = data as MapFile | MapFileV1;
  if (file?.format !== 'serf-map') bad('wrong format tag');
  if (file.version !== 1 && file.version !== 2) bad(`unsupported version ${String(file.version)}`);
  const play = file.play;
  if (!Number.isInteger(play) || play < MIN_MAP_SIZE || play > MAX_MAP_SIZE || play % 2 !== 0) {
    bad(`bad playable size ${String(play)}`);
  }
  const size = file.size;
  if (size !== gridFor(play)) bad(`bad grid size ${String(size)} for playable ${String(play)}`);
  const tiles = tileCount(size);
  const terrain = readBytes(file, 'terrain');
  const resource = readBytes(file, 'resource');
  const resourceAmt = readBytes(file, 'resourceAmt');
  const height = readHeights(file);
  if (!terrain.every((t) => TERRAIN_VALUES.has(t))) bad('unknown terrain value');
  if (!resource.every((r) => RESOURCE_VALUES.has(r))) bad('unknown resource value');
  // Cross-field invariants the editor itself always keeps: resources
  // stand on grass only, and a resource code means a live amount (the
  // sim clears the code when a tile is worked dry).
  for (let i = 0; i < tiles; i++) {
    const res = resource[i]!;
    if (res !== TileResource.None) {
      if (terrain[i] !== Terrain.Grass) bad('resource on non-grass terrain');
      if (resourceAmt[i]! < 1) bad('resource with no amount');
    } else if (resourceAmt[i] !== 0) {
      bad('amount without a resource');
    }
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
    terrain,
    resource,
    resourceAmt,
    blocked: new Uint8Array(tiles),
    buildingAt: new Int16Array(tiles).fill(-1),
    wear: new Float32Array(tiles),
    pathLevel: new Uint8Array(tiles),
    height,
  };
  recomputeBlocked(map);
  return {
    map,
    players,
    starts: file.starts.map((s) => ({ x: s.x, y: s.y })),
    name: typeof file.name === 'string' && file.name.trim() !== '' ? file.name : 'Untitled',
  };
}
