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
 * The depth is not a free number. It is exactly how far a frame overshoots
 * the play square at full zoom-out, which two constants in
 * render/cameraRig.ts decide between them: MAX_VIEW_FRACTION, how much
 * world a frame covers, and VIEW_PAN_INSET, how much of that frame the pan
 * clamp charges against the play square before it stops. The comments
 * there are the other half of this one, and cameraRig.test.ts is what
 * holds the three together — prose cannot.
 *
 * Working the overshoot out gives its shape. With the pan allowance still
 * in play the clamp puts the frame's centre at `play/2 + PAN_MARGIN -
 * 2·ext·INSET` from the middle, so the far edge lands
 *
 *     ring = ext·(1 - 2·INSET) + PAN_MARGIN
 *
 * past the boundary. `ext` — the frame's half-footprint, stretched by the
 * 35° pitch and turned by the yaw — scales with the play side; PAN_MARGIN
 * does not. So the ring is **affine, not proportional**: a share of the
 * play side plus a flat few tiles of shore. That is why this is not a
 * fraction any more. A fraction has to be cut deep enough for the smallest
 * map, where four flat tiles are a sixteenth of the side, and then spends
 * that same share on the largest, where they are a thirty-second.
 *
 * At the shipped pair (cap 0.5, inset 0.28) the overshoot measures
 * 0.274·play + 4 on a 16:9 window, which is what the constants below
 * carry, with four tiles and more in hand at every legal size. A 21:9
 * window wants 0.322·play + 4 and is still a tile short at the largest
 * maps — better than the tile and a half it was short before, and the same
 * standing exception rather than a new one.
 *
 * What that leaves: rings of 28 / 36 / 44 tiles at the smallest, default
 * and largest maps, against 28 / 40 / 52 before and 32 / 48 / 64 before
 * that. The grid is 3.1x the playable area where it was 3.4x, and 4x when
 * this started.
 *
 * It does not go much below this without paying in something worth more.
 * VIEW_PAN_INSET is the lever, and it runs into a wall well before the
 * arithmetic does: at 0.30 the largest valley's corners stop being
 * reachable on the default camera line at full zoom-out, and at 0.35 no
 * valley's are. 0.28 is the last step that leaves the camera doing what it
 * already did, and cameraRig.test.ts holds it there from both sides.
 *
 * Warcraft III gets a ring near a tenth of its side, and the difference is
 * not this number: its frame never grows anywhere near the size of its
 * map. Going further here is a question for the wheel, not for the ring.
 *
 * (MARGIN_SLOPE and VIEW_PAN_INSET are both 0.28 and have nothing to do
 * with each other — one is a share of the play side, the other a share of
 * a frustum. Do not be tempted to fold them together.)
 */
const MARGIN_SLOPE = 0.28;
const MARGIN_FLAT = 8;

/**
 * The ring, in tiles, rounded UP to a whole number of texture repeats.
 *
 * Four, because that is a whole number of repeats and not merely a whole
 * number of tiles: the ground detail texture repeats every four, measured
 * from the play square's corner on the fine mesh and from the grid's on
 * the margin mesh (render/groundTexture.ts). An offset between those
 * corners that is not a multiple of four puts the two out of phase along
 * the boundary, and the seam the meshes work so hard to hide reappears as
 * a step in the speckle.
 *
 * Up rather than to the nearest, now that the target is the overshoot
 * itself rather than a fraction chosen with slack in it: rounding down
 * from a figure that IS the requirement is rounding into the void.
 *
 * marginTargetFor is that unrounded depth, exported so grid.test.ts can
 * pin the rounding's direction without restating the slope and the flat
 * term where they could drift apart from these.
 */
export function marginTargetFor(play: number): number {
  return play * MARGIN_SLOPE + MARGIN_FLAT;
}

export function marginFor(play: number): number {
  return 4 * Math.ceil(marginTargetFor(play) / 4);
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
