export const MAP_SIZE = 64;
export const TILE_COUNT = MAP_SIZE * MAP_SIZE;

export function tileIdx(x: number, y: number): number {
  return y * MAP_SIZE + x;
}

export function tileX(idx: number): number {
  return idx % MAP_SIZE;
}

export function tileY(idx: number): number {
  return (idx / MAP_SIZE) | 0;
}

export function inBounds(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < MAP_SIZE && y < MAP_SIZE;
}

/** Chebyshev distance to the nearest map edge. */
export function edgeDist(x: number, y: number): number {
  return Math.min(x, y, MAP_SIZE - 1 - x, MAP_SIZE - 1 - y);
}
