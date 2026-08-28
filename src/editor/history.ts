import { type StartSpot, tileBlocks, inPlayArea } from '../sim/map.ts';
import { tileX, tileY } from '../shared/grid.ts';
import type { EditorMapState } from './editorMap.ts';

/** What one editing action can change: the authored ground and the seats. */
interface Snapshot {
  terrain: Uint8Array;
  resource: Uint8Array;
  resourceAmt: Uint8Array;
  height: Float32Array;
  starts: StartSpot[];
}

/** Undo depth. Full-map snapshots are ~250 KB at the largest grid, so a
 * few dozen strokes of history costs single-digit megabytes of RAM. */
const CAPACITY = 30;

function capture(state: EditorMapState): Snapshot {
  return {
    terrain: Uint8Array.from(state.map.terrain),
    resource: Uint8Array.from(state.map.resource),
    resourceAmt: Uint8Array.from(state.map.resourceAmt),
    height: Float32Array.from(state.map.height),
    starts: state.starts.map((s) => ({ ...s })),
  };
}

/**
 * Write a snapshot back INTO the live state — into the existing typed
 * arrays, never fresh ones: the terrain mesh, the height field, and the
 * water shader's bed texture all hold references to these exact buffers.
 * Returns the tile indices whose ground changed (for the render resync)
 * and whether the starts moved.
 */
function apply(state: EditorMapState, snap: Snapshot): { tiles: number[]; starts: boolean } {
  const { map } = state;
  const tiles: number[] = [];
  for (let i = 0; i < map.terrain.length; i++) {
    if (
      map.terrain[i] !== snap.terrain[i] ||
      map.resource[i] !== snap.resource[i] ||
      map.resourceAmt[i] !== snap.resourceAmt[i] ||
      map.height[i] !== snap.height[i]
    ) {
      tiles.push(i);
      map.terrain[i] = snap.terrain[i]!;
      map.resource[i] = snap.resource[i]!;
      map.resourceAmt[i] = snap.resourceAmt[i]!;
      map.height[i] = snap.height[i]!;
      map.blocked[i] =
        tileBlocks(map.terrain[i]!, map.resource[i]!) ||
        !inPlayArea(map, tileX(i, map.size), tileY(i, map.size))
          ? 1
          : 0;
    }
  }
  const startsChanged =
    snap.starts.length !== state.starts.length ||
    snap.starts.some((s, p) => s.x !== state.starts[p]!.x || s.y !== state.starts[p]!.y);
  state.starts = snap.starts.map((s) => ({ ...s }));
  return { tiles, starts: startsChanged };
}

/**
 * Stroke-grained undo/redo over one map: record() at the start of every
 * action (a paint stroke, a start drag), then undo/redo swap the live
 * state against the stacks. History is per-map — New and Import begin a
 * fresh timeline (a cross-size restore would have to rebuild the whole
 * scene anyway, which is exactly what those actions already do).
 */
export class EditorHistory {
  #undo: Snapshot[] = [];
  #redo: Snapshot[] = [];

  /** Call BEFORE an action mutates the state. */
  record(state: EditorMapState): void {
    this.#undo.push(capture(state));
    if (this.#undo.length > CAPACITY) this.#undo.shift();
    this.#redo = [];
  }

  canUndo(): boolean {
    return this.#undo.length > 0;
  }

  canRedo(): boolean {
    return this.#redo.length > 0;
  }

  /** Step back; returns what changed, or null with nothing to undo. */
  undo(state: EditorMapState): { tiles: number[]; starts: boolean } | null {
    const snap = this.#undo.pop();
    if (!snap) return null;
    this.#redo.push(capture(state));
    return apply(state, snap);
  }

  /** Step forward again; returns what changed, or null with nothing to redo. */
  redo(state: EditorMapState): { tiles: number[]; starts: boolean } | null {
    const snap = this.#redo.pop();
    if (!snap) return null;
    this.#undo.push(capture(state));
    return apply(state, snap);
  }

  clear(): void {
    this.#undo = [];
    this.#redo = [];
  }
}
