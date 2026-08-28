/**
 * What a tech does when it lands, as a JS enum module — the discriminant
 * of TechEffect.
 */
export const unlockBuilding = 1 as const;
export type unlockBuilding = typeof unlockBuilding;
export const unlockUnit = 2 as const;
export type unlockUnit = typeof unlockUnit;
export const modifier = 3 as const;
export type modifier = typeof modifier;
export const unlockPaving = 4 as const;
export type unlockPaving = typeof unlockPaving;
