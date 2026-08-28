/**
 * Whether a post has its worker, as a JS enum module. Undefined on a
 * building that needs none at all — this says nothing about those.
 */
export const staffed = 1 as const;
export type staffed = typeof staffed;
export const recruiting = 2 as const;
export type recruiting = typeof recruiting;
export const needed = 3 as const;
export type needed = typeof needed;
