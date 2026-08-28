/**
 * The stances the strategist model chooses between, as a JS enum module.
 * 
 * POSTURE_KEYS carries the spelling, and it is load-bearing at two doors:
 * the menu is quoted into the prompt in words, and the model answers with a
 * word. Inside the seat a posture is a number like anything else.
 */
export const expand = 1 as const;
export type expand = typeof expand;
export const fortify = 2 as const;
export type fortify = typeof fortify;
export const raid = 3 as const;
export type raid = typeof raid;
export const muster = 4 as const;
export type muster = typeof muster;
export const siege = 5 as const;
export type siege = typeof siege;
export const pounce = 6 as const;
export type pounce = typeof pounce;
