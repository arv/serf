import { gridFor, tileCount, tileIdx } from '../shared/grid.ts';
import {
  inPlayArea,
  recomputeBlocked,
  type GameMap,
  type PlayArea,
  type StartSpot,
} from '../sim/map.ts';
import { resolveMapSize } from '../sim/world.ts';
import { rotateStart } from './symmetry.ts';
import * as Terrain from '../sim/terrainEnum.ts';

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

/**
 * An all-grass flat map ready to paint, starts on the default ring. `size`
 * asks for the PLAYABLE side; the grid carries the canonical scenery
 * margin around it (Warcraft-style, gridFor), all of it paintable — the
 * margin is real tiles the camera sees, just ground nothing may use.
 */
export function createBlankMap(opts: { size: number; players: number }): EditorMapState {
  const play = resolveMapSize(opts.size);
  const size = gridFor(play);
  const players = Math.max(1, Math.min(4, opts.players | 0));
  const tiles = tileCount(size);
  const map: GameMap = {
    size,
    play,
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
  return { map, players, starts: defaultStarts(map, players), name: 'Untitled' };
}

/**
 * Default start ring: seat 0 due north of the middle, the rest its exact
 * rotation images (rotations about the grid center, which is the play
 * center — the margin is symmetric). Deliberately NOT startLayout
 * (world.ts): that layout is the worldgen/server contract and its
 * 3-player triangle is mirror- but not rotation-symmetric, which would
 * put kaleidoscope copies of a stroke on ground no seat owns. Solo keeps
 * the classic center start.
 */
export function defaultStarts(area: PlayArea, players: number): StartSpot[] {
  const size = area.size;
  if (players <= 1) return [{ x: size / 2 - 2, y: size / 2 - 2 }];
  const ring = Math.round(area.play * 0.28);
  const first: StartSpot = { x: size / 2 - 2, y: size / 2 - 2 - ring };
  const out: StartSpot[] = [first];
  for (let k = 1; k < players; k++) out.push(rotateStart(first, size, k, players));
  return out;
}

/** Storehouse footprint side (a start is its 3x3 origin). */
const START_W = 3;

/**
 * Can a storehouse legally stand here? The whole 3x3 footprint on grass,
 * with a one-tile ring inside the PLAYABLE area (the play path clears
 * resources 5x5 around it, so standing wood is fine — but scenery margin
 * is not buildable ground). The drag tool's green/red and validateForPlay
 * agree by construction — this is the one rule.
 */
export function startSpotLegal(map: GameMap, s: StartSpot): boolean {
  if (!inPlayArea(map, s.x - 1, s.y - 1) || !inPlayArea(map, s.x + START_W, s.y + START_W)) {
    return false;
  }
  for (let dy = 0; dy < START_W; dy++) {
    for (let dx = 0; dx < START_W; dx++) {
      if (map.terrain[tileIdx(s.x + dx, s.y + dy, map.size)] !== Terrain.Grass) return false;
    }
  }
  return true;
}

/** Blocking problems that must be fixed before Play. */
export function validateForPlay(state: EditorMapState): string[] {
  const { map, players, starts } = state;
  const problems: string[] = [];
  if (starts.length !== players) {
    problems.push(`map is set for ${players} player(s) but has ${starts.length} start(s)`);
  }
  starts.forEach((s, p) => {
    if (!startSpotLegal(map, s)) {
      problems.push(`player ${p + 1}'s start needs a full 3×3 of grass inside the playable area`);
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

  // Rivals must share a landmass, or an elimination match can never end.
  // Worldgen audits and repairs exactly this (its land bridges); an
  // authored lake owes no such promise, so the audit lives here too.
  // Terrain-only, like the sim's own connectivity check: standing timber
  // is choppable ground, not a wall.
  if (problems.length === 0 && starts.length > 1) {
    const size = map.size;
    const seen = new Uint8Array(tileCount(size));
    const first = starts[0]!;
    const queue = [tileIdx(first.x + 1, first.y + 1, size)];
    seen[queue[0]!] = 1;
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head]!;
      const x = i % size;
      const y = (i / size) | 0;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const) {
        if (!inPlayArea(map, nx, ny)) continue;
        const n = tileIdx(nx, ny, size);
        if (seen[n] || map.terrain[n] !== Terrain.Grass) continue;
        seen[n] = 1;
        queue.push(n);
      }
    }
    starts.forEach((s, p) => {
      if (p > 0 && !seen[tileIdx(s.x + 1, s.y + 1, size)]) {
        problems.push(`player ${p + 1}'s start is cut off from player 1 — bridge the land`);
      }
    });
  }
  return problems;
}
