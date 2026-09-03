/**
 * What the next right-click will do, as a JS enum module — the pointer's
 * standing order on touch, where there is no second button.
 */
export const attack = 1 as const;
export type attack = typeof attack;
export const move = 2 as const;
export type move = typeof move;
export const rally = 3 as const;
export type rally = typeof rally;
export const patrol = 4 as const;
export type patrol = typeof patrol;
