/**
 * What the sim tells the client happened this tick, as a JS enum module.
 * Rides the structural update.
 */
export const raidIncoming = 1 as const;
export type raidIncoming = typeof raidIncoming;
export const playerEliminated = 2 as const;
export type playerEliminated = typeof playerEliminated;
export const gameOver = 3 as const;
export type gameOver = typeof gameOver;
export const objectiveComplete = 4 as const;
export type objectiveComplete = typeof objectiveComplete;
export const damage = 5 as const;
export type damage = typeof damage;
export const heraldIncoming = 6 as const;
export type heraldIncoming = typeof heraldIncoming;
