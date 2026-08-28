/**
 * The three lines the tech tree lays out, as a JS enum module.
 */
export const agriculture = 1 as const;
export type agriculture = typeof agriculture;
export const craft = 2 as const;
export type craft = typeof craft;
export const warfare = 3 as const;
export type warfare = typeof warfare;
