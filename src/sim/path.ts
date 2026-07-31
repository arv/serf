import { MAP_SIZE, TILE_COUNT, inBounds, tileIdx, tileX, tileY } from '../shared/grid.ts';
import { PathLevel, type GameMap } from './map.ts';

/**
 * All the pathfinder actually reads: where it cannot go, and what a step
 * costs. Narrower than GameMap on purpose — the multiplayer client holds
 * only a map snapshot, and this is what lets it predict its own movement
 * with the very same pathfinder the server moves with, rather than an
 * approximation that would drift.
 */
export type PathMap = Pick<GameMap, 'blocked' | 'pathLevel'>;

/**
 * A* over the tile grid: 8-directional, corner cutting forbidden, path-aware
 * step costs so units prefer trails and roads. Flat typed arrays with a
 * generation stamp avoid per-call clearing; a binary heap orders the open set.
 */

const SQRT2 = Math.SQRT2;
const EXPANSION_CAP = 4096;

/** Movement cost multiplier per path level: grass, dirt trail, stone road. */
const LEVEL_COST = [1.0, 0.85, 0.72] as const;

export function tileStepCost(map: PathMap, idx: number): number {
  return LEVEL_COST[map.pathLevel[idx]!] ?? 1.0;
}

/** Movement speed multiplier for a tile (inverse of its cost advantage). */
export function tileSpeedMult(map: PathMap, idx: number): number {
  const level = map.pathLevel[idx]!;
  return level === PathLevel.Road ? 1.35 : level === PathLevel.Trail ? 1.15 : 1.0;
}

/**
 * A* scratch, shared by every search in the process — ~200 KiB that would
 * otherwise be allocated per call.
 *
 * THE CONTRACT: `search()` must run to completion without yielding. It is
 * the only reader and writer of these buffers, and it holds no state across
 * calls, so any number of worlds may path through it *sequentially*. The
 * server relies on exactly that: it ticks many rooms on one thread, and the
 * scratch is safe because no room's search can be interleaved with another's.
 *
 * What would break it: making anything on this path async, moving rooms onto
 * worker threads that share this module instance, or time-slicing the search
 * across ticks. Any of those needs per-room scratch instead — pass it in, or
 * allocate per world.
 */
const gScore = new Float32Array(TILE_COUNT);
const cameFrom = new Int32Array(TILE_COUNT);
/** Generation stamps: a tile counts as visited when its stamp is current,
 * which avoids clearing 16 KiB per search. */
const visited = new Int32Array(TILE_COUNT);
let generation = 0;

// Binary min-heap of tile indices keyed by fScore. Lazy decrease-key pushes
// duplicates, so the heap is sized well beyond TILE_COUNT.
const heap = new Int32Array(TILE_COUNT * 8);
const fScore = new Float32Array(TILE_COUNT);
let heapSize = 0;

/**
 * Take the next generation stamp, wrapping deliberately.
 *
 * `visited` holds Int32 stamps, so past 2^31 searches the counter would wrap
 * into values still sitting in the array and stale tiles would read as
 * already-visited — a wrong path, not a crash, which is the worst kind of
 * bug to find. This used to be far off; a server ticking many rooms burns
 * generations N times faster, so make it explicit rather than incidental.
 * Clearing costs 16 KiB once every two billion searches.
 */
function nextGeneration(): number {
  if (generation === 0x7fffffff) {
    visited.fill(0);
    generation = 0;
  }
  return ++generation;
}

function heapPush(idx: number, f: number): void {
  fScore[idx] = f;
  let i = heapSize++;
  heap[i] = idx;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (fScore[heap[parent]!]! <= fScore[heap[i]!]!) break;
    const t = heap[parent]!;
    heap[parent] = heap[i]!;
    heap[i] = t;
    i = parent;
  }
}

function heapPop(): number {
  const top = heap[0]!;
  const last = heap[--heapSize]!;
  if (heapSize > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let smallest = i;
      if (l < heapSize && fScore[heap[l]!]! < fScore[heap[smallest]!]!) smallest = l;
      if (r < heapSize && fScore[heap[r]!]! < fScore[heap[smallest]!]!) smallest = r;
      if (smallest === i) break;
      const t = heap[smallest]!;
      heap[smallest] = heap[i]!;
      heap[i] = t;
      i = smallest;
    }
  }
  return top;
}

function octile(x0: number, y0: number, x1: number, y1: number): number {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  // Slightly optimistic (best-case road cost) keeps the heuristic admissible.
  return (Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy)) * 0.7;
}

/**
 * Core multi-goal A*: shortest path from start to any goal tile, using an
 * admissible heuristic of "octile distance to the goal bounding rect". Path
 * is returned as tile indices excluding the start tile; null if unreachable.
 */
function search(
  map: PathMap,
  sx: number,
  sy: number,
  isGoal: (idx: number) => boolean,
  // Heuristic anchor rectangle (inclusive tile bounds).
  rx0: number,
  ry0: number,
  rx1: number,
  ry1: number,
): number[] | null {
  const start = tileIdx(sx, sy);
  if (isGoal(start)) return [];

  const h = (x: number, y: number): number => {
    const cx = x < rx0 ? rx0 : x > rx1 ? rx1 : x;
    const cy = y < ry0 ? ry0 : y > ry1 ? ry1 : y;
    return octile(x, y, cx, cy);
  };

  const generation = nextGeneration();
  heapSize = 0;
  gScore[start] = 0;
  cameFrom[start] = -1;
  visited[start] = generation;
  heapPush(start, h(sx, sy));

  let expansions = 0;
  while (heapSize > 0) {
    const current = heapPop();
    if (isGoal(current)) return reconstruct(start, current);
    if (++expansions > EXPANSION_CAP) return null;

    const cx = tileX(current);
    const cy = tileY(current);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (!inBounds(nx, ny)) continue;
        const n = tileIdx(nx, ny);
        if (map.blocked[n]) continue;
        // No corner cutting: a diagonal needs both orthogonal neighbors open.
        if (dx !== 0 && dy !== 0) {
          if (map.blocked[tileIdx(cx + dx, cy)] || map.blocked[tileIdx(cx, cy + dy)]) continue;
        }
        const stepLen = dx !== 0 && dy !== 0 ? SQRT2 : 1;
        const g = gScore[current]! + stepLen * tileStepCost(map, n);
        if (visited[n] === generation && g >= gScore[n]!) continue;
        visited[n] = generation;
        gScore[n] = g;
        cameFrom[n] = current;
        heapPush(n, g + h(nx, ny)); // lazy decrease-key: duplicates are fine
      }
    }
  }
  return null;
}

/**
 * Shortest path from (sx,sy) to (tx,ty), excluding the start tile, or null
 * if unreachable. Target must be walkable.
 */
export function findPath(
  map: PathMap,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
): number[] | null {
  if (!inBounds(tx, ty) || map.blocked[tileIdx(tx, ty)]) return null;
  const goal = tileIdx(tx, ty);
  return search(map, sx, sy, (i) => i === goal, tx, ty, tx, ty);
}

function reconstruct(start: number, goal: number): number[] {
  const out: number[] = [];
  let cur = goal;
  while (cur !== start) {
    out.push(cur);
    cur = cameFrom[cur]!;
  }
  out.reverse();
  return out;
}

/**
 * Nearest walkable tile to (tx,ty), spiralling outward. Returns tile index or
 * -1. Useful for right-click targets on blocked tiles.
 */
export function nearestWalkable(map: PathMap, tx: number, ty: number, maxR = 8): number {
  for (let r = 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = tx + dx;
        const y = ty + dy;
        if (inBounds(x, y) && !map.blocked[tileIdx(x, y)]) return tileIdx(x, y);
      }
    }
  }
  return -1;
}

/**
 * Path to the nearest walkable tile ringing a building footprint — one
 * multi-goal search. Every haul ends at a building, so this is the workhorse
 * entry point.
 */
export function findPathToAdjacent(
  map: PathMap,
  sx: number,
  sy: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): number[] | null {
  const isGoal = (idx: number): boolean => {
    const x = tileX(idx);
    const y = tileY(idx);
    return x >= bx - 1 && x <= bx + bw && y >= by - 1 && y <= by + bh;
  };
  // Heuristic rect is the ring's bounding box (admissible).
  return search(map, sx, sy, isGoal, bx - 1, by - 1, bx + bw, by + bh);
}

/** MAP_SIZE re-export spares sim systems a second import site. */
export { MAP_SIZE };
