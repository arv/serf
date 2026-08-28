/**
 * Which way the camera is looking, as a JS enum module: the game's angled
 * view, or straight down.
 */
export const game = 1 as const;
export type game = typeof game;
export const topDown = 2 as const;
export type topDown = typeof topDown;
