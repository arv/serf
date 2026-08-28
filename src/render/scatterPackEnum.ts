/**
 * Which scenery pack a baked mesh came out of, as a JS enum module. The
 * two ship separate palette sheets, so a mesh has to remember which.
 */
export const nature = 1 as const;
export type nature = typeof nature;
export const forest = 2 as const;
export type forest = typeof forest;
