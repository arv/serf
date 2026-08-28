/**
 * Which HUD sheet is open, as a JS enum module. One at a time; the store
 * holds the id or null.
 */
export const build = 1 as const;
export type build = typeof build;
export const menu = 2 as const;
export type menu = typeof menu;
export const tech = 3 as const;
export type tech = typeof tech;
export const economy = 4 as const;
export type economy = typeof economy;
export const map = 5 as const;
export type map = typeof map;
