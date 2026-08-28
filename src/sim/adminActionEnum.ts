/**
 * The sandbox levers (the ?admin panel), as a JS enum module. Single
 * player only, so no cheat gating is needed — but they still arrive as
 * untrusted frames and are still screened.
 */
export const toggleRaids = 1 as const;
export type toggleRaids = typeof toggleRaids;
export const clearBandits = 2 as const;
export type clearBandits = typeof clearBandits;
export const grantGoods = 3 as const;
export type grantGoods = typeof grantGoods;
export const toggleInstantBuild = 4 as const;
export type toggleInstantBuild = typeof toggleInstantBuild;
export const finishResearch = 5 as const;
export type finishResearch = typeof finishResearch;
export const spawnParade = 6 as const;
export type spawnParade = typeof spawnParade;
