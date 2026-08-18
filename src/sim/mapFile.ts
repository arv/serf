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
 * always pristine. Typed arrays ride as plain number arrays, the save.ts
 * precedent.
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
 * build the GameMap. Every array is copied, so two worlds built from the
 * same file never share tiles. */
export function parseMapData(data: unknown): AuthoredMap {
  const file = data as MapFile;
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
  // Sanity bounds, not sculpting bounds: the editor's brushes stay within
  // [-1.6, 2.55], but a map exported from worldgen carries its border
  // ranges — margin scenery peaks near 4.7 — and the file format must
  // accept any world the generator itself can roll.
  if (!file.height.every((h) => Number.isFinite(h) && h >= -2 && h <= 5)) {
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
