import { inBounds, tileIdx, tileX, tileY } from '../shared/grid.ts';
import { clamp } from '../shared/math.ts';
import { WOOD_MAX_AMT } from '../sim/defs/balance.ts';
import {
  Terrain,
  TileResource,
  inPlayArea,
  tileBlocks,
  type TerrainKind,
  type TileResourceKind,
} from '../sim/map.ts';
import type { EditorMapState } from './editorMap.ts';
import { foldBasis, rotatePoint } from './symmetry.ts';

/** What a click paints. The start-move tool lives in the controls, not here. */
export type Tool =
  | { kind: 'terrain'; terrain: TerrainKind }
  | { kind: 'resource'; res: TileResourceKind } // TileResource.None = eraser
  | { kind: 'height'; dir: 1 | -1 };

export interface BrushOptions {
  /** Disc radius in tiles (Euclidean, measured to tile centers). */
  radius: number;
  /** Kaleidoscope fold count; 1 = plain painting. */
  folds: number;
  /** Height step per stamp at the brush center, before falloff. */
  strength?: number;
}

/**
 * Per-resource starting amounts — worldgen's own cluster values, so an
 * editor grove or seam behaves exactly like a generated one.
 */
export const RESOURCE_AMOUNTS: Record<number, number> = {
  [TileResource.Wood]: WOOD_MAX_AMT,
  [TileResource.Rock]: 10,
  [TileResource.IronDep]: 24,
  [TileResource.SilverDep]: 20,
  [TileResource.GoldDep]: 12,
};

/**
 * Height bands the brush keeps terrain honest against (worldgen's own, see
 * computeTerrain): water beds run -0.34..-1.5 and must stay below the
 * water plane or the shader discards into a hole; land runs 0.04..2.55 and
 * the vertex painter reads bare rock above ~0.9.
 */
const WATER_PAINT_DEPTH = -0.75;
const WATER_BED_MIN = -1.6;
const WATER_BED_MAX = -0.4;
const LAND_MIN = 0.05;
const LAND_MAX = 2.55;
const GRASS_FLOOR = 0.3;
const ROCK_FLOOR = 1.1;

/** Default height change per stamp for the raise/lower tool. */
export const HEIGHT_STEP = 0.18;

/**
 * One brush stamp at continuous grid point (cx, cy), replicated across the
 * kaleidoscope folds. Mutates state.map and returns the deduped indices of
 * every tile it changed. A tile covered by two overlapping fold discs (near
 * the map center) is applied exactly once per stamp — height strokes would
 * otherwise double up where the copies meet.
 */
export function applyBrush(
  state: EditorMapState,
  tool: Tool,
  cx: number,
  cy: number,
  o: BrushOptions,
): number[] {
  const { map } = state;
  const size = map.size;
  const r = Math.max(0.5, o.radius);

  // Where the fold discs overlap (near the map center) a tile belongs to
  // several copies at once. Its falloff distance is the distance to the
  // NEAREST copy — "first disc wins" would break the symmetry, because
  // which disc scans first is not a rotation-invariant question.
  const touched = new Map<number, number>(); // tile index -> min dist²
  for (const step of foldBasis(o.folds)) {
    const c = rotatePoint(cx, cy, size, step);
    const x0 = Math.max(0, Math.floor(c.x - r - 1));
    const x1 = Math.min(size - 1, Math.ceil(c.x + r + 1));
    const y0 = Math.max(0, Math.floor(c.y - r - 1));
    const y1 = Math.min(size - 1, Math.ceil(c.y + r + 1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - c.x;
        const dy = y + 0.5 - c.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > r * r) continue;
        const i = tileIdx(x, y, size);
        const prev = touched.get(i);
        if (prev === undefined || d2 < prev) touched.set(i, d2);
      }
    }
  }

  const dirty: number[] = [];
  for (const [i, d2] of touched) {
    if (applyToTile(state, tool, i, Math.sqrt(d2) / r, o)) dirty.push(i);
  }

  // Walkability follows immediately: no buildings exist while editing, so
  // the landscape rule plus the play-area gate is the whole answer — the
  // scenery margin is paintable but never walkable, exactly as
  // recomputeBlocked enforces on load.
  for (const i of dirty) {
    map.blocked[i] =
      tileBlocks(map.terrain[i]!, map.resource[i]!) || !inPlayArea(map, tileX(i, size), tileY(i, size))
        ? 1
        : 0;
  }
  return dirty;
}

/** Smoothstep falloff from the stamp center (1) to the disc edge (0). */
function falloff(t: number): number {
  const inv = clamp(1 - t, 0, 1);
  return inv * inv * (3 - 2 * inv);
}

/** Apply one tool to one tile; returns whether anything changed. */
function applyToTile(
  state: EditorMapState,
  tool: Tool,
  i: number,
  distNorm: number,
  o: BrushOptions,
): boolean {
  const { map } = state;
  switch (tool.kind) {
    case 'terrain': {
      const before = map.terrain[i]!;
      const beforeH = map.height[i]!;
      map.terrain[i] = tool.terrain;
      switch (tool.terrain) {
        case Terrain.Water:
          // Water carries no standing resources, and its bed must sit
          // below the plane or the shader discards into a hole.
          map.resource[i] = TileResource.None;
          map.resourceAmt[i] = 0;
          map.height[i] = Math.min(beforeH, WATER_PAINT_DEPTH);
          break;
        case Terrain.Rock:
          map.resource[i] = TileResource.None;
          map.resourceAmt[i] = 0;
          map.height[i] = Math.max(beforeH, ROCK_FLOOR);
          break;
        default:
          // Grass: lift a former bed back above the waterline.
          if (beforeH < LAND_MIN) map.height[i] = GRASS_FLOOR;
          break;
      }
      return before !== tool.terrain || map.height[i] !== beforeH;
    }
    case 'resource': {
      if (tool.res !== TileResource.None) {
        // Standing resources and deposits live on grass only, like worldgen.
        if (map.terrain[i] !== Terrain.Grass) return false;
        if (map.resource[i] === tool.res) return false;
        map.resource[i] = tool.res;
        map.resourceAmt[i] = RESOURCE_AMOUNTS[tool.res]!;
        return true;
      }
      if (map.resource[i] === TileResource.None) return false;
      map.resource[i] = TileResource.None;
      map.resourceAmt[i] = 0;
      return true;
    }
    case 'height': {
      const step = (o.strength ?? HEIGHT_STEP) * tool.dir * falloff(distNorm);
      if (step === 0) return false;
      const before = map.height[i]!;
      // The terrain tag stays authoritative: sculpting deepens or shoals a
      // bed but never lifts it into land, and never digs a meadow under
      // the waterline — that's the water brush's job.
      const after =
        map.terrain[i] === Terrain.Water
          ? clamp(before + step, WATER_BED_MIN, WATER_BED_MAX)
          : clamp(before + step, LAND_MIN, LAND_MAX);
      if (after === before) return false;
      map.height[i] = after;
      return true;
    }
  }
}

/**
 * A stroke segment (one pointermove step): stamps every half-radius along
 * the line so a fast drag leaves no gaps. Returns deduped dirty indices.
 */
export function applyStroke(
  state: EditorMapState,
  tool: Tool,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  o: BrushOptions,
): number[] {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const stepLen = Math.max(0.5, o.radius / 2);
  const steps = Math.max(1, Math.ceil(dist / stepLen));
  const dirty = new Set<number>();
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const cx = x0 + (x1 - x0) * t;
    const cy = y0 + (y1 - y0) * t;
    for (const i of applyBrush(state, tool, cx, cy, o)) dirty.add(i);
  }
  return [...dirty];
}

/** Is there anything for this tool to do at this map point? (cursor tint) */
export function toolApplies(state: EditorMapState, tool: Tool, x: number, y: number): boolean {
  if (!inBounds(x, y, state.map.size)) return false;
  const i = tileIdx(Math.floor(x), Math.floor(y), state.map.size);
  if (tool.kind === 'resource' && tool.res !== TileResource.None) {
    return state.map.terrain[i] === Terrain.Grass;
  }
  return true;
}
