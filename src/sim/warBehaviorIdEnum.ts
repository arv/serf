/**
 * The brain's war behaviors, as a JS enum module — the reactive verbs
 * (systems/ai.ts) that make a seat visibly answer the match: harassment
 * sorties, grudges, outpost defense, the losing march that turns home, the
 * scout that runs. Named so each can be ablated alone (`--war <ids>` in the
 * lab), exactly as the economy rules are: a behavior that pays and a
 * behavior that merely fires must be tellable apart, and a behavior whose
 * payoff is drama rather than win rate still owes proof that it does not
 * COST a rate.
 */
export const harassSortie = 1 as const;
export type harassSortie = typeof harassSortie;
export const grudge = 2 as const;
export type grudge = typeof grudge;
export const defendOutpost = 3 as const;
export type defendOutpost = typeof defendOutpost;
export const retreatMarch = 4 as const;
export type retreatMarch = typeof retreatMarch;
export const scoutFlees = 5 as const;
export type scoutFlees = typeof scoutFlees;
export const heraldMarch = 6 as const;
export type heraldMarch = typeof heraldMarch;
export const focusFire = 7 as const;
export type focusFire = typeof focusFire;
export const withdrawWounded = 8 as const;
export type withdrawWounded = typeof withdrawWounded;
export const wipedMarch = 9 as const;
export type wipedMarch = typeof wipedMarch;
