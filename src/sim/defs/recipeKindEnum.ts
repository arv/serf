/**
 * The two shapes a producer can take, as a JS enum module: a resident who
 * commutes out to work tiles, or a converter that turns inputs into outputs
 * on a timer.
 */
export const gather = 1 as const;
export type gather = typeof gather;
export const convert = 2 as const;
export type convert = typeof convert;
