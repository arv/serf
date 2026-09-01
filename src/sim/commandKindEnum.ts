/**
 * Every order the sim takes, as a JS enum module (see shared/enum.ts).
 *
 * The values ride in command frames and in replay logs, so they are
 * append-only: a new order takes the next number.
 */
export const moveUnits = 1 as const;
export type moveUnits = typeof moveUnits;
export const placeBuilding = 2 as const;
export type placeBuilding = typeof placeBuilding;
export const hireSerf = 3 as const;
export type hireSerf = typeof hireSerf;
export const sellBuilding = 4 as const;
export type sellBuilding = typeof sellBuilding;
export const setBuildingPaused = 5 as const;
export type setBuildingPaused = typeof setBuildingPaused;
export const setBuildingRepair = 6 as const;
export type setBuildingRepair = typeof setBuildingRepair;
export const setBuildingRecipe = 7 as const;
export type setBuildingRecipe = typeof setBuildingRecipe;
export const enqueueForge = 8 as const;
export type enqueueForge = typeof enqueueForge;
export const cancelForge = 9 as const;
export type cancelForge = typeof cancelForge;
export const research = 10 as const;
export type research = typeof research;
export const trainUnit = 11 as const;
export type trainUnit = typeof trainUnit;
export const cancelTraining = 12 as const;
export type cancelTraining = typeof cancelTraining;
export const setRallyPoint = 13 as const;
export type setRallyPoint = typeof setRallyPoint;
export const admin = 14 as const;
export type admin = typeof admin;
export const herald = 15 as const;
export type herald = typeof herald;
export const cancelHire = 16 as const;
export type cancelHire = typeof cancelHire;
export const focusTarget = 17 as const;
export type focusTarget = typeof focusTarget;
