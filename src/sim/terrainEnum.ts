/**
 * What a tile is made of, as a JS enum module (see shared/enum.ts).
 *
 * The values are the bytes in GameMap.terrain, which ride in every save and
 * every map file — they are the format, not an implementation detail.
 */
export const Grass = 0 as const;
export type Grass = typeof Grass;
export const Water = 1 as const;
export type Water = typeof Water;
export const Rock = 2 as const;
export type Rock = typeof Rock;
