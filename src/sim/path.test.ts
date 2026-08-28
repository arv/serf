import {describe, expect, it} from 'vitest';
import {
  DEFAULT_MAP_SIZE,
  tileCount,
  tileIdx,
  tileX,
  tileY,
} from '../shared/grid.ts';
import type {GameMap} from './map.ts';
import {findPath, findPathToAdjacent, nearestWalkable} from './path.ts';
import * as PathLevel from './pathLevelEnum.ts';

const MAP_SIZE = DEFAULT_MAP_SIZE;
const TILE_COUNT = tileCount(MAP_SIZE);

function emptyMap(): GameMap {
  return {
    size: MAP_SIZE,
    play: MAP_SIZE,
    terrain: new Uint8Array(TILE_COUNT),
    resource: new Uint8Array(TILE_COUNT),
    resourceAmt: new Uint8Array(TILE_COUNT),
    blocked: new Uint8Array(TILE_COUNT),
    buildingAt: new Int16Array(TILE_COUNT).fill(-1),
    wear: new Float32Array(TILE_COUNT),
    pathLevel: new Uint8Array(TILE_COUNT),
    height: new Float32Array(TILE_COUNT),
  };
}

function block(map: GameMap, x: number, y: number): void {
  map.blocked[tileIdx(x, y, map.size)] = 1;
}

describe('A* pathfinding', () => {
  /**
   * The regression for the runaway-search cap.
   *
   * The cap's only job is bounding an UNREACHABLE search, which expands the
   * whole walkable component before it can fail. That makes the component
   * size the floor the cap has to clear — and half the play area sits below
   * it. At 96 the cap was (96*96)>>1 = 4608 against valleys whose open
   * ground runs to ~5000 tiles, so a march long enough to need more than
   * 4608 expansions came back null on ground a flood fill calls fully
   * connected.
   *
   * It failed silently, which is what made it expensive: a caller cannot
   * tell a capped search from a genuinely unreachable goal, so the order was
   * dropped rather than refused and whoever issued it simply re-tried
   * forever. In the sim that read as an army that would not march.
   *
   * The corridor below is the smallest honest reproduction — 4656 open
   * tiles single-file, so expansions track path length instead of exploding
   * on open-ground ties. It returns null under the old cap and walks under
   * the new one.
   */
  it('walks a corridor longer than half the play area', () => {
    const map = emptyMap();
    // Wall off every odd row, leaving one gap at alternating ends: one
    // single-file switchback from the top of the map to the bottom.
    for (let y = 1; y < MAP_SIZE; y += 2) {
      for (let x = 0; x < MAP_SIZE; x++) block(map, x, y);
      const gate = ((y - 1) / 2) % 2 === 0 ? MAP_SIZE - 1 : 0;
      map.blocked[tileIdx(gate, y, map.size)] = 0;
    }
    // The old cap, spelled out: a corridor that does not outrun it proves
    // nothing, and the 4096 floor is part of it at small map sizes.
    const oldCap = Math.max(4096, (MAP_SIZE * MAP_SIZE) >> 1);
    const open = map.blocked.reduce((n, b) => n + (b ? 0 : 1), 0);
    expect(
      open,
      'the corridor must outrun the old cap to be a regression',
    ).toBeGreaterThan(oldCap);

    const path = findPath(map, 0, 0, 0, MAP_SIZE - 1);
    expect(
      path,
      'a reachable goal must never hit the search cap',
    ).not.toBeNull();
    expect(path!.length).toBe(open - 1);
  });

  it('still refuses a goal walled off from the start', () => {
    // The cap's real job, and it has to survive being raised: a search with
    // nowhere to go exhausts its component and returns null.
    const map = emptyMap();
    for (let y = 0; y < MAP_SIZE; y++) block(map, 40, y);
    expect(findPath(map, 1, 1, 60, 60)).toBeNull();
  });

  it('finds a straight path', () => {
    const map = emptyMap();
    const path = findPath(map, 0, 0, 5, 0)!;
    expect(path).not.toBeNull();
    expect(path.length).toBe(5);
    expect(path[4]).toBe(tileIdx(5, 0, map.size));
  });

  it('uses diagonals when free', () => {
    const map = emptyMap();
    const path = findPath(map, 0, 0, 4, 4)!;
    expect(path.length).toBe(4); // pure diagonal
  });

  it('never cuts corners', () => {
    const map = emptyMap();
    // Wall with a corner at (2,2): moving diagonally past it must be illegal.
    block(map, 2, 1);
    block(map, 1, 2);
    const path = findPath(map, 1, 1, 3, 3)!;
    expect(path).not.toBeNull();
    // The diagonal step (1,1)->(2,2) requires (2,1) and (1,2) open — blocked
    // here, so the path must be longer than the unobstructed 2 steps.
    expect(path.length).toBeGreaterThan(2);
  });

  it('returns null when unreachable', () => {
    const map = emptyMap();
    // Wall off a pocket around (10,10).
    for (let d = -1; d <= 1; d++) {
      block(map, 10 + d, 9);
      block(map, 10 + d, 11);
      block(map, 9, 10 + d);
      block(map, 11, 10 + d);
    }
    expect(findPath(map, 0, 0, 10, 10)).toBeNull();
  });

  it('prefers roads over grass when longer-but-paved wins on cost', () => {
    const map = emptyMap();
    // Straight line (5,5)->(15,5) costs 10. Pave a parallel detour via y=6:
    // road cost 0.72 makes 5,5 -> …road… -> 15,5 cheaper despite extra steps.
    for (let x = 5; x <= 15; x++)
      map.pathLevel[tileIdx(x, 6, map.size)] = PathLevel.Road;
    const path = findPath(map, 5, 5, 15, 5)!;
    const onRoad = path.filter(i => map.pathLevel[i] === PathLevel.Road).length;
    expect(onRoad).toBeGreaterThan(5);
  });

  it('findPathToAdjacent reaches a building ring, not the building', () => {
    const map = emptyMap();
    // 3x3 building at (20,20)..(22,22).
    for (let y = 20; y <= 22; y++)
      for (let x = 20; x <= 22; x++) block(map, x, y);
    const path = findPathToAdjacent(map, 5, 21, 20, 20, 3, 3)!;
    expect(path).not.toBeNull();
    const last = path[path.length - 1]!;
    const lx = tileX(last, map.size);
    const ly = tileY(last, map.size);
    expect(lx).toBeGreaterThanOrEqual(19);
    expect(lx).toBeLessThanOrEqual(23);
    expect(map.blocked[last]).toBe(0);
  });

  it('nearestWalkable spirals outward', () => {
    const map = emptyMap();
    block(map, 30, 30);
    const found = nearestWalkable(map, 30, 30);
    expect(found).not.toBe(-1);
    expect(map.blocked[found]).toBe(0);
    const dist = Math.max(
      Math.abs(tileX(found, map.size) - 30),
      Math.abs(tileY(found, map.size) - 30),
    );
    expect(dist).toBe(1);
  });

  it('handles worst-case unreachable within the expansion cap', () => {
    const map = emptyMap();
    // Diagonal wall across the whole map.
    for (let i = 0; i < MAP_SIZE; i++) {
      block(map, i, MAP_SIZE - 1 - i);
      if (i + 1 < MAP_SIZE) block(map, i, MAP_SIZE - 2 - i); // double thickness, no diagonal gaps
    }
    expect(findPath(map, 0, 0, MAP_SIZE - 1, MAP_SIZE - 1)).toBeNull();
  });
});
