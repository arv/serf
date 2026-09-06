/**
 * What is standing or buried on a tile, as a JS enum module (see
 * shared/enum.ts).
 *
 * The values are the bytes in GameMap.resource and the codes the gather
 * recipes name, so they ride in saves and map files. This used to be two
 * things — these codes, and a parallel union of words on the recipes
 * (TileResourceName), bridged by a lookup table. One enum, no bridge.
 */
export const None = 0 as const;
export type None = typeof None;
export const Wood = 1 as const;
export type Wood = typeof Wood;
export const Rock = 2 as const;
export type Rock = typeof Rock;
export const IronDep = 3 as const;
export type IronDep = typeof IronDep;
export const SilverDep = 4 as const;
export type SilverDep = typeof SilverDep;
export const GoldDep = 5 as const;
export type GoldDep = typeof GoldDep;
/**
 * A gold seam that has been worked out: tailings, not ore.
 *
 * Every other resource simply becomes `None` when its last unit is taken,
 * because nothing in the game asks where a tree used to stand. The Monument
 * does: it must be raised within reach of a gold seam, and a rule that read
 * live ore alone made the gold a trap — digging the seam a monument is
 * gilded from deleted every legal site for it, permanently and invisibly,
 * on the whole map. So the ground keeps the memory. Spoil is not ore: no
 * mine can work it, and the code alone still answers every question the
 * render side and the placement ghost ask, which is why this is a code of
 * its own rather than a seam left standing with nothing in it.
 *
 * Never written by an authored map (it is not in TILE_RESOURCE_KINDS, so a
 * map file carrying one is refused) — only by the sim, and only by the last
 * load out of the last tile of a seam.
 */
export const GoldSpoil = 6 as const;
export type GoldSpoil = typeof GoldSpoil;
