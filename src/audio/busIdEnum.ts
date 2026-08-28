/**
 * The mixer buses, as a JS enum module. Every cue names one, and the mixer
 * looks it up per cue — several a frame in a fight.
 */
export const ui = 1 as const;
export type ui = typeof ui;
export const combat = 2 as const;
export type combat = typeof combat;
export const work = 3 as const;
export type work = typeof work;
export const world = 4 as const;
export type world = typeof world;
export const ambient = 5 as const;
export type ambient = typeof ambient;
export const music = 6 as const;
export type music = typeof music;
