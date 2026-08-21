import { MAX_MAP_SIZE, gridFor, inBounds, tileCount, tileIdx, tileX, tileY } from '../shared/grid.ts';
import { PathLevel, type GameMap } from './map.ts';

/**
 * All the pathfinder actually reads: where it cannot go, what a step
 * costs, and the grid side length. Narrower than GameMap on purpose — the
 * multiplayer client holds only a map snapshot, and this is what lets it
 * predict its own movement with the very same pathfinder the server moves
 * with, rather than an approximation that would drift.
 */
export type PathMap = Pick<GameMap, 'blocked' | 'pathLevel' | 'size' | 'play'>;

/**
 * A* over the tile grid: 8-directional, corner cutting forbidden, path-aware
 * step costs so units prefer trails and roads. Flat typed arrays with a
 * generation stamp avoid per-call clearing; a binary heap orders the open set.
 */

const SQRT2 = Math.SQRT2;

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
 * A* scratch, shared by every search in the process — a few MiB that would
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
// The largest GRID, not the largest playable side: the scenery margin
// doubles the side, and a scratch sized short of the grid means silent
// out-of-bounds typed-array writes and garbage paths.
const SCRATCH_TILES = tileCount(gridFor(MAX_MAP_SIZE));
const gScore = new Float32Array(SCRATCH_TILES);
const cameFrom = new Int32Array(SCRATCH_TILES);
/** Generation stamps: a tile counts as visited when its stamp is current,
 * which avoids clearing 16 KiB per search. */
const visited = new Int32Array(SCRATCH_TILES);
let generation = 0;

// Binary min-heap of (tile, key) entries. Lazy decrease-key pushes
// duplicates, so the heap is sized well beyond the tile count. The key
// lives IN the entry, not in a per-tile array: with a shared per-tile key,
// re-pushing a tile at a better score rewrote the key under every copy of
// it already sitting in the heap, breaking the heap invariant — and the
// out-of-order pops that followed made the search re-expand whole regions,
// inflating `expansions` far past the walkable component. On the levy map
// that pushed a reachable 100-tile march over the runaway cap, which is
// exactly the "returns null on reachable ground" failure the cap's comment
// forbids (an army-freezing bug, same shape as the seed-9 one).
const heap = new Int32Array(SCRATCH_TILES * 8);
const heapKey = new Float32Array(SCRATCH_TILES * 8);
// Expanded-tile stamps: with per-entry keys the first pop of a tile is its
// best (the heuristic is consistent — 0.7 per tile under the 0.72 road
// step), so later duplicate pops are settled work. Skipping them, without
// charging the cap, is what makes `expansions` honestly "unique tiles" and
// restores the cap's floor: only a genuinely unreachable goal can hit it.
const closed = new Int32Array(SCRATCH_TILES);
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
    closed.fill(0);
    generation = 0;
  }
  return ++generation;
}

function heapPush(idx: number, f: number): void {
  let i = heapSize++;
  heap[i] = idx;
  heapKey[i] = f;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heapKey[parent]! <= heapKey[i]!) break;
    const t = heap[parent]!;
    const k = heapKey[parent]!;
    heap[parent] = heap[i]!;
    heapKey[parent] = heapKey[i]!;
    heap[i] = t;
    heapKey[i] = k;
    i = parent;
  }
}

function heapPop(): number {
  const top = heap[0]!;
  const last = --heapSize;
  if (heapSize > 0) {
    heap[0] = heap[last]!;
    heapKey[0] = heapKey[last]!;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let smallest = i;
      if (l < heapSize && heapKey[l]! < heapKey[smallest]!) smallest = l;
      if (r < heapSize && heapKey[r]! < heapKey[smallest]!) smallest = r;
      if (smallest === i) break;
      const t = heap[smallest]!;
      const k = heapKey[smallest]!;
      heap[smallest] = heap[i]!;
      heapKey[smallest] = heapKey[i]!;
      heap[i] = t;
      heapKey[i] = k;
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
  const size = map.size;
  const start = tileIdx(sx, sy, size);
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
    if (closed[current] === generation) continue; // a settled tile's stale duplicate
    closed[current] = generation;
    if (isGoal(current)) return reconstruct(start, current);
    // The runaway-search cap. Its only job is bounding an UNREACHABLE
    // search, which expands the whole walkable component before it can
    // fail; a reachable goal must never hit it.
    //
    // That makes the component size the floor, and half the play area was
    // below it. Seed 9 measured the failure: a 96 map with a 5016-tile
    // walkable component against a cap of (96*96)>>1 = 4608, so a march
    // from one castle to the other — 74 tiles across a valley the flood
    // fill says is fully connected — returned null. The army then sat in
    // `raid` forever, re-trying every 45 ticks (Unit.repathAt) against a
    // goal it was never allowed to find, which is why the impatience ramp
    // in systems/ai.ts walked the muster bar down to one soldier and STILL
    // never ended the match. Not an AI bug: the order was dropped under it.
    //
    // The play square is the honest bound — no walkable component can
    // exceed it, since the margin outside is blocked scenery no search can
    // enter. It costs a stuck unit up to 2x its old worst case at 96 and
    // nothing at all when the goal is reachable, because a search that
    // succeeds stops at the goal.
    if (++expansions > Math.max(4096, map.play * map.play)) return null;

    const cx = tileX(current, size);
    const cy = tileY(current, size);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (!inBounds(nx, ny, size)) continue;
        const n = tileIdx(nx, ny, size);
        if (map.blocked[n]) continue;
        // No corner cutting: a diagonal needs both orthogonal neighbors open.
        if (dx !== 0 && dy !== 0) {
          if (map.blocked[tileIdx(cx + dx, cy, size)] || map.blocked[tileIdx(cx, cy + dy, size)]) continue;
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
  const size = map.size;
  if (!inBounds(tx, ty, size) || map.blocked[tileIdx(tx, ty, size)]) return null;
  const goal = tileIdx(tx, ty, size);
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
  const size = map.size;
  for (let r = 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = tx + dx;
        const y = ty + dy;
        if (inBounds(x, y, size) && !map.blocked[tileIdx(x, y, size)]) return tileIdx(x, y, size);
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
  const size = map.size;
  const isGoal = (idx: number): boolean => {
    const x = tileX(idx, size);
    const y = tileY(idx, size);
    return x >= bx - 1 && x <= bx + bw && y >= by - 1 && y <= by + bh;
  };
  // Heuristic rect is the ring's bounding box (admissible).
  return search(map, sx, sy, isGoal, bx - 1, by - 1, bx + bw, by + bh);
}
