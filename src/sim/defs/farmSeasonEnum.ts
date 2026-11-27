/**
 * What a wheat field is doing at a point in the year, as a JS enum module
 * (see shared/enum.ts). Read off the tick by farmSeasonAt (balance.ts):
 * nothing stores it.
 */
/** Ripe: the scythe goes in, and the only time the farm makes wheat. */
export const harvest = 1 as const;
export type harvest = typeof harvest;
/** The stubble turned and the seed broadcast, ahead of the snow. */
export const sow = 2 as const;
export type sow = typeof sow;
/** Asleep under the snow. */
export const fallow = 3 as const;
export type fallow = typeof fallow;
/** Up green with the thaw, and ripening gold. */
export const grow = 4 as const;
export type grow = typeof grow;
