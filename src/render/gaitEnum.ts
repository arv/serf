/**
 * How a walker's legs are moving, as a JS enum module. Picked per unit per
 * frame from its ground speed.
 */
export const walk = 1 as const;
export type walk = typeof walk;
export const jog = 2 as const;
export type jog = typeof jog;
