/**
 * What kind of game a rival appears to be playing, as a JS enum module —
 * read off its sighted buildings and army, never told to anyone.
 */
export const rusher = 1 as const;
export type rusher = typeof rusher;
export const booming = 2 as const;
export type booming = typeof booming;
export const turtling = 3 as const;
export type turtling = typeof turtling;
/** `unmet` rather than `unknown`: a type alias cannot be named for a
 * built-in type. It means the same thing — nothing sighted yet. */
export const unmet = 4 as const;
export type unmet = typeof unmet;
