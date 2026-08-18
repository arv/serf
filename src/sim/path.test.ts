import { describe, expect, it } from 'vitest';
import { DEFAULT_MAP_SIZE, tileCount, tileIdx, tileX, tileY } from '../shared/grid.ts';
import { PathLevel, type GameMap } from './map.ts';
import { findPath, findPathToAdjacent, nearestWalkable } from './path.ts';

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
    for (let x = 5; x <= 15; x++) map.pathLevel[tileIdx(x, 6, map.size)] = PathLevel.Road;
    const path = findPath(map, 5, 5, 15, 5)!;
    const onRoad = path.filter((i) => map.pathLevel[i] === PathLevel.Road).length;
    expect(onRoad).toBeGreaterThan(5);
  });

  it('findPathToAdjacent reaches a building ring, not the building', () => {
    const map = emptyMap();
    // 3x3 building at (20,20)..(22,22).
    for (let y = 20; y <= 22; y++) for (let x = 20; x <= 22; x++) block(map, x, y);
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
    const dist = Math.max(Math.abs(tileX(found, map.size) - 30), Math.abs(tileY(found, map.size) - 30));
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
