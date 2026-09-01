/**
 * How hard a match is set to, as a JS enum module. The id rides
 * WorldConfig, PlayerState, the lobby protocol and the ?difficulty URL
 * parameter, so DIFFICULTY_KEYS (defs/difficulty.ts) carries its spelling
 * for those.
 */
export const easy = 1 as const;
export type easy = typeof easy;
export const normal = 2 as const;
export type normal = typeof normal;
export const hard = 3 as const;
export type hard = typeof hard;
