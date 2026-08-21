import { tileIdx } from '../shared/grid';
import { PathLevel } from '../sim/map';
import { vnoise } from './noise';

/**
 * Paths as ribbons rather than painted squares.
 *
 * A worn tile on its own says nothing about where the feet actually fell, so
 * painting the whole square reads as a checkerboard stain. What makes a trail
 * look like a trail is the *line* through it: each path tile draws a
 * half-segment from its center out toward every neighboring path tile (8-way,
 * the directions the pathfinder actually steps), so two adjacent tiles meet
 * at the edge they share and a run of them becomes one continuous band.
 * Corners bend, junctions fan out, dead ends round off, and the ground
 * between the ribbon and the tile border stays grass.
 *
 * Distances are in tiles, measured on the flat grid — height is ignored, the
 * same simplification the sim pathfinder makes.
 */

/** Neighbor offsets, 8-way: the steps a unit can take between tiles. */
const DX = [1, 1, 0, -1, -1, -1, 0, 1] as const;
const DY = [0, 1, 1, 1, 0, -1, -1, -1] as const;

/** Half-width of a dirt trail, in tiles, edge included. */
export const TRAIL_HALF = 0.36;
/** Roads are laid, not worn — wider than the trails they replace. */
export const ROAD_HALF = 0.44;
/** Fade at the shoulder: bare in the middle, thinning turf toward the edge. */
export const RIBBON_EDGE = 0.18;

/** Distance from a sample point to the nearest ribbon of each kind. */
export interface RibbonDist {
  /** Tiles to the nearest dirt-trail centerline; Infinity when far off. */
  trail: number;
  /** Tiles to the nearest stone-road centerline; Infinity when far off. */
  road: number;
}

export function newRibbonDist(): RibbonDist {
  return { trail: Infinity, road: Infinity };
}

let sideForLen = -1;
let sideValue = 0;
/** The grid side, memoized on the array length (see ribbonDistances). */
function gridSideOf(len: number): number {
  if (len !== sideForLen) {
    sideForLen = len;
    sideValue = Math.sqrt(len) | 0;
  }
  return sideValue;
}

/**
 * Distance from world point (px, pz) to the nearest trail and road
 * centerlines, written into `out` to keep the hot vertex loop allocation-free.
 *
 * Only the 3x3 tile block around the point is consulted: every half-segment
 * stays inside its own tile, so anything two tiles away is at least a full
 * tile off and can never be the nearest.
 */
export function ribbonDistances(
  path: Uint8Array,
  px: number,
  pz: number,
  out: RibbonDist,
): void {
  out.trail = Infinity;
  out.road = Infinity;
  // The path grid is square (size² tiles), so the grid size rides along in
  // the array itself — no separate parameter to thread through every caller.
  // Memoized on the length: a full terrain repaint calls this once per
  // vertex (~333k times at play=96) to recover the same constant.
  const size = gridSideOf(path.length);
  const bx = Math.floor(px);
  const bz = Math.floor(pz);
  for (let ty = bz - 1; ty <= bz + 1; ty++) {
    if (ty < 0 || ty >= size) continue;
    for (let tx = bx - 1; tx <= bx + 1; tx++) {
      if (tx < 0 || tx >= size) continue;
      const level = path[tileIdx(tx, ty, size)]!;
      if (level === PathLevel.None) continue;
      // Sample point relative to this tile's center, where its segments start.
      const wx = px - (tx + 0.5);
      const wz = pz - (ty + 0.5);
      // Round cap at the center: what a lone tile or a dead end looks like.
      let d = Math.sqrt(wx * wx + wz * wz);
      for (let k = 0; k < 8; k++) {
        const nx = tx + DX[k]!;
        const ny = ty + DY[k]!;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        if (path[tileIdx(nx, ny, size)] === PathLevel.None) continue;
        // Center -> shared edge (or corner); the neighbor draws the other half.
        const vx = DX[k]! * 0.5;
        const vz = DY[k]! * 0.5;
        const t = Math.min(Math.max((wx * vx + wz * vz) / (vx * vx + vz * vz), 0), 1);
        const ex = wx - vx * t;
        const ez = wz - vz * t;
        const seg = Math.sqrt(ex * ex + ez * ez);
        if (seg < d) d = seg;
      }
      if (level === PathLevel.Road) {
        if (d < out.road) out.road = d;
      } else if (d < out.trail) {
        out.trail = d;
      }
    }
  }
}

/** Ribbon coverage at a distance: 1 on the centerline, 0 past `half`. */
export function ribbonStrength(d: number, half: number): number {
  if (d >= half) return 0;
  const t = Math.min((half - d) / RIBBON_EDGE, 1);
  return t * t * (3 - 2 * t);
}

/*
 * The three noise fields below are what keep a ribbon from reading as a
 * ruler-drawn stripe: the sample point drifts (the track meanders), and the
 * width breathes (squeezes and trodden-out wide spots). Everything that
 * draws along a path samples these same functions, so the terrain paint,
 * the road's cobbles and the grass that survives beside them share one edge.
 */

/** Sideways drift of the sample point, in tiles. */
export function ribbonWarpX(x: number, z: number): number {
  return (vnoise(61, x, z, 3.3) - 0.5) * 0.34 + (vnoise(71, x, z, 0.7) - 0.5) * 0.1;
}

export function ribbonWarpZ(x: number, z: number): number {
  return (vnoise(63, x, z, 3.3) - 0.5) * 0.34 + (vnoise(73, x, z, 0.7) - 0.5) * 0.1;
}

/** Multiplier on the half-width where the ribbon passes through here. */
export function ribbonWidth(x: number, z: number): number {
  return 0.72 + vnoise(67, x, z, 2.6) * 0.62;
}

/** How much of each kind of path covers a world point: 0 clear, 1 bare. */
export interface RibbonCover {
  trail: number;
  road: number;
}

/** `RibbonDist` plus the wobble — the whole ribbon test at a world point. */
export function ribbonCover(path: Uint8Array, x: number, z: number, out: RibbonCover): void {
  ribbonDistances(path, x + ribbonWarpX(x, z), z + ribbonWarpZ(x, z), COVER_DIST);
  const w = ribbonWidth(x, z);
  out.trail = ribbonStrength(COVER_DIST.trail, TRAIL_HALF * w);
  out.road = ribbonStrength(COVER_DIST.road, ROAD_HALF * w);
}

const COVER_DIST = newRibbonDist();
