/**
 * Where in a beat a rule runs, as a JS enum module. Not decoration:
 * commands apply in the order they are pushed, and within one tick that
 * order is load-bearing.
 */
export const recovery = 1 as const;
export type recovery = typeof recovery;
export const production = 2 as const;
export type production = typeof production;
