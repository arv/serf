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
 * A quarter of the play side per edge. It was half — the distance the
 * camera looks past the boundary from a screen corner at full zoom-out, so
 * that the ring reached everywhere a frame could reach. What that bought
 * was a grid four times the area anyone could play on: every tile of the
 * far half generated, stored, saved, scattered with timber and scratched
 * by the pathfinder, to be looked at through haze in the corner of one
 * zoom level. A quarter side still frames the valley from every ordinary
 * view, and the grid is 2.25x the playable area instead of 4x.
 *
 * What it gives up is that corner: at maximum zoom-out on a wide window
 * the frame can now reach past the grid, and the melt at the ring's outer
 * edge (render/marginMesh.ts) is what the horizon has left to fade into.
 * The lever on the other side of that trade is the zoom-out cap, not this
 * number — MAX_VIEW_FRACTION in render/cameraRig.ts is what decides how
 * far a frame reaches.
 */
export function marginFor(play: number): number {
  // Rounded: playable sides are even, not necessarily multiples of four,
  // and playMin ((size - play) / 2) is a tile index.
  return Math.round(play / 4);
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
