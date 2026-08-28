/**
 * How worn a tile's path is, as a JS enum module (see shared/enum.ts).
 * The values are the bytes in GameMap.pathLevel and index LEVEL_COST in the
 * pathfinder's inner loop.
 */
export const None = 0 as const;
export type None = typeof None;
export const Trail = 1 as const;
export type Trail = typeof Trail;
export const Road = 2 as const;
export type Road = typeof Road;
