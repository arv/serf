/** Default PLAYABLE area side; missions and (one day) the level editor may
 * pick their own within [MIN_MAP_SIZE, MAX_MAP_SIZE]. The live sizes are
 * per-game data — `map.size` is the full grid, `map.play` the playable
 * square centered in it. */
export const DEFAULT_MAP_SIZE = 96;
/** Floor: the start-relative gameplay radii (home plateau 9, ore rings
 * 13–17) are fixed distances and need at least this much room. */
export const MIN_MAP_SIZE = 64;
/** Ceiling: the high-resolution terrain mesh (6 segments per tile) over the
 * playable area is the cost that grows fastest; beyond this it wants
 * chunking, not a bigger allowance. */
export const MAX_MAP_SIZE = 128;

/**
 * Warcraft-style world layout: the grid is larger than the playable area,
 * and the ring around the play square is real, editable tiles — scenery the
 * camera can see but nothing can walk, build, or gather on.
 *
 * The depth is not a free number: it is however far a frame reaches past
 * the boundary, and that is the zoom-out cap's to say. So this constant
 * and MAX_VIEW_FRACTION (render/cameraRig.ts) are one decision written in
 * two places, and the comment there is the other half of this one.
 *
 * It was half a side, against a cap of 0.8 — a grid four times the area
 * anyone could play on, three quarters of it ground nobody could enter,
 * most of that seen only in the corner of one zoom level. The pair is now
 * 0.42 against 0.5: the ring is a sixth shallower, the grid 3.4x the
 * playable area rather than 4x, and full zoom-out frames the valley
 * roughly to its own edges instead of the valley and a valley of scenery
 * around it.
 *
 * There is a floor under this, and it is not the cap. A square play area
 * on a 16:9 screen that fits the frame's height leaves the frame 1.78x as
 * wide as the map — about 0.39 sides showing past each side edge before
 * pitch or panning enter into it. A ring much under two fifths cannot
 * frame the valley at any cap.
 */
const MARGIN_FRACTION = 0.42;

/**
 * A whole number of texture repeats, not just a whole number of tiles: the
 * ground detail texture repeats every four tiles, measured from the play
 * square's corner on the fine mesh and from the grid's on the margin mesh
 * (render/groundTexture.ts). An offset between those corners that is not a
 * multiple of four puts the two out of phase along the boundary, and the
 * seam the meshes work so hard to hide reappears as a step in the speckle.
 */
export function marginFor(play: number): number {
  return 4 * Math.round((play * MARGIN_FRACTION) / 4);
}

/** Full grid side for a playable side (play sizes are even by contract). */
export function gridFor(play: number): number {
  return play + 2 * marginFor(play);
}

export function tileCount(size: number): number {
  return size * size;
}

export function tileIdx(x: number, y: number, size: number): number {
  return y * size + x;
}

export function tileX(idx: number, size: number): number {
  return idx % size;
}

export function tileY(idx: number, size: number): number {
  return (idx / size) | 0;
}

export function inBounds(x: number, y: number, size: number): boolean {
  return x >= 0 && y >= 0 && x < size && y < size;
}

/** Chebyshev distance to the nearest map edge. */
export function edgeDist(x: number, y: number, size: number): number {
  return Math.min(x, y, size - 1 - x, size - 1 - y);
}
