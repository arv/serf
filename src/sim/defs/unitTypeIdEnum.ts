/**
 * Every kind of person on the map, as a JS enum module (see shared/enum.ts).
 *
 * The values are the SAB kind byte — what used to be UnitDef.kindCode, now
 * the id itself — so the renderer reads a unit's kind straight off the
 * shared buffer with no table in between. One-based, leaving 0 as the empty
 * slot the hot path already treats as "nobody here".
 */
export const serf = 1 as const;
export type serf = typeof serf;
export const worker = 2 as const;
export type worker = typeof worker;
export const knight = 3 as const;
export type knight = typeof knight;
export const spearman = 4 as const;
export type spearman = typeof spearman;
export const archer = 5 as const;
export type archer = typeof archer;
export const bandit = 6 as const;
export type bandit = typeof bandit;
export const banditArcher = 7 as const;
export type banditArcher = typeof banditArcher;
export const marauder = 8 as const;
export type marauder = typeof marauder;
