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
