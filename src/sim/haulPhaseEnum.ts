/**
 * How far along a haul job is, as a JS enum module (see shared/enum.ts).
 * Walked by the logistics pass over every open job, every tick.
 */
export const open = 1 as const;
export type open = typeof open;
export const toPickup = 2 as const;
export type toPickup = typeof toPickup;
export const toDropoff = 3 as const;
export type toDropoff = typeof toDropoff;
