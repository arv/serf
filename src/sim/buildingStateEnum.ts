/**
 * Whether a building is a scaffold or a standing roof, as a JS enum module
 * (see shared/enum.ts). The most-compared value in the sim — nearly a
 * hundred sites ask it, several of them per building per tick.
 */
export const site = 1 as const;
export type site = typeof site;
export const built = 2 as const;
export type built = typeof built;
