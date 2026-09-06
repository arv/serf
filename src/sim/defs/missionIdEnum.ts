/**
 * The campaign's commissions, as a JS enum module. The id rides in saves
 * and in the ?mission URL parameter, so MISSION_KEYS carries its spelling
 * for the boundaries that are read by people.
 */
export const clearing = 1 as const;
export type clearing = typeof clearing;
export const breadAndWater = 2 as const;
export type breadAndWater = typeof breadAndWater;
export const ledger = 3 as const;
export type ledger = typeof ledger;
export const hammerAndHaft = 4 as const;
export type hammerAndHaft = typeof hammerAndHaft;
export const levy = 5 as const;
export type levy = typeof levy;
export const holdTheValley = 6 as const;
export type holdTheValley = typeof holdTheValley;
export const rivalBanner = 7 as const;
export type rivalBanner = typeof rivalBanner;
export const gildedValley = 8 as const;
export type gildedValley = typeof gildedValley;
