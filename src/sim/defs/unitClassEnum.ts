/**
 * The military triangle's three arms, as a JS enum module — heavy beats
 * light, light catches ranged, ranged kites heavy. The COUNTER_TABLE is
 * indexed by a pair of these on every blow struck.
 */
export const heavy = 1 as const;
export type heavy = typeof heavy;
export const light = 2 as const;
export type light = typeof light;
export const ranged = 3 as const;
export type ranged = typeof ranged;
