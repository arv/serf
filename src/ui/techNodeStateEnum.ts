/**
 * How the tech tree draws one node, as a JS enum module — the five states
 * a research can be in from the panel's point of view.
 */
export const done = 1 as const;
export type done = typeof done;
export const researching = 2 as const;
export type researching = typeof researching;
export const available = 3 as const;
export type available = typeof available;
export const unaffordable = 4 as const;
export type unaffordable = typeof unaffordable;
export const locked = 5 as const;
export type locked = typeof locked;
