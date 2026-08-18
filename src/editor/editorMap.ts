import { inBounds, tileCount, tileIdx } from '../shared/grid.ts';
import { Terrain, recomputeBlocked, type GameMap, type StartSpot } from '../sim/map.ts';
import { resolveMapSize } from '../sim/world.ts';
import { rotateStart } from './symmetry.ts';

/**
 * The editor's working state: a real GameMap (so every render class and the
 * play path consume it unchanged) plus what worldgen normally computes —
 * how many seats the map is built for and where they start.
 */
export interface EditorMapState {
  map: GameMap;
  /** 1..4 seats; starts.length === players. */
  players: number;
  starts: StartSpot[];
  name: string;
}

/** Height a fresh meadow tile starts at — inside worldgen's gentle band. */
export const BLANK_LAND_HEIGHT = 0.35;

/** An all-grass flat map ready to paint, starts on the default ring. */
export function createBlankMap(opts: { size: number; players: number }): EditorMapState {
  const size = resolveMapSize(opts.size);
  const players = Math.max(1, Math.min(4, opts.players | 0));
  const tiles = tileCount(size);
  const map: GameMap = {
    size,
    terrain: new Uint8Array(tiles),
    resource: new Uint8Array(tiles),
    resourceAmt: new Uint8Array(tiles),
    blocked: new Uint8Array(tiles),
    buildingAt: new Int16Array(tiles).fill(-1),
    wear: new Float32Array(tiles),
    pathLevel: new Uint8Array(tiles),
    height: new Float32Array(tiles).fill(BLANK_LAND_HEIGHT),
  };
  recomputeBlocked(map);
  return { map, players, starts: defaultStarts(size, players), name: 'Untitled' };
}

/**
 * Default start ring: seat 0 due north of the middle, the rest its exact
 * rotation images. Deliberately NOT startLayout (world.ts): that layout is
 * the worldgen/server contract and its 3-player triangle is mirror- but
 * not rotation-symmetric, which would put kaleidoscope copies of a stroke
 * on ground no seat owns. Solo keeps the classic center start.
 */
export function defaultStarts(size: number, players: number): StartSpot[] {
  if (players <= 1) return [{ x: size / 2 - 2, y: size / 2 - 2 }];
  const ring = Math.round(size * 0.28);
  const first: StartSpot = { x: size / 2 - 2, y: size / 2 - 2 - ring };
  const out: StartSpot[] = [first];
  for (let k = 1; k < players; k++) out.push(rotateStart(first, size, k, players));
  return out;
}

/** Storehouse footprint side (a start is its 3x3 origin). */
const START_W = 3;

/**
 * Blocking problems that must be fixed before Play. Buildable means: the
 * whole 3x3 footprint on grass with a one-tile margin inside the map (the
 * play path clears resources 5x5 around it, so standing wood is fine).
 */
export function validateForPlay(state: EditorMapState): string[] {
  const { map, players, starts } = state;
  const problems: string[] = [];
  if (starts.length !== players) {
    problems.push(`map is set for ${players} player(s) but has ${starts.length} start(s)`);
  }
  starts.forEach((s, p) => {
    const seat = `player ${p + 1}`;
    if (!inBounds(s.x - 1, s.y - 1, map.size) || !inBounds(s.x + START_W, s.y + START_W, map.size)) {
      problems.push(`${seat}'s start is too close to the map edge`);
      return;
    }
    for (let dy = 0; dy < START_W; dy++) {
      for (let dx = 0; dx < START_W; dx++) {
        if (map.terrain[tileIdx(s.x + dx, s.y + dy, map.size)] !== Terrain.Grass) {
          problems.push(`${seat}'s start must sit fully on grass`);
          return;
        }
      }
    }
  });
  for (let a = 0; a < starts.length; a++) {
    for (let b = a + 1; b < starts.length; b++) {
      const dx = Math.abs(starts[a]!.x - starts[b]!.x);
      const dy = Math.abs(starts[a]!.y - starts[b]!.y);
      if (Math.max(dx, dy) < START_W + 2) {
        problems.push(`player ${a + 1} and player ${b + 1} start on top of each other`);
      }
    }
  }
  return problems;
}
