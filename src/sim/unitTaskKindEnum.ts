/**
 * What a unit is currently doing, as a JS enum module (see shared/enum.ts)
 * — the discriminant of UnitTask. Read on every unit every tick, and mixed
 * into the world digest, where it used to be hashed a character at a time.
 */
export const idle = 1 as const;
export type idle = typeof idle;
export const move = 2 as const;
export type move = typeof move;
export const attackMove = 3 as const;
export type attackMove = typeof attackMove;
export const haul = 4 as const;
export type haul = typeof haul;
export const gatherOut = 5 as const;
export type gatherOut = typeof gatherOut;
export const gatherWork = 6 as const;
export type gatherWork = typeof gatherWork;
export const gatherHome = 7 as const;
export type gatherHome = typeof gatherHome;
export const staff = 8 as const;
export type staff = typeof staff;
export const raid = 9 as const;
export type raid = typeof raid;
export const hold = 10 as const;
export type hold = typeof hold;
