/**
 * What a playbook's build step sites itself against, as a JS enum module:
 * the keep, or the nearest of a resource.
 */
export const base = 1 as const;
export type base = typeof base;
export const wood = 2 as const;
export type wood = typeof wood;
export const rock = 3 as const;
export type rock = typeof rock;
export const iron = 4 as const;
export type iron = typeof iron;
export const silver = 5 as const;
export type silver = typeof silver;
export const gold = 6 as const;
export type gold = typeof gold;
export const water = 7 as const;
export type water = typeof water;
