/**
 * Who is holding a seat, as a JS enum module. Rides WorldConfig, the lobby
 * protocol and the saved room, so PLAYER_KIND_KEYS carries the spelling
 * those wire formats used to send.
 */
export const human = 1 as const;
export type human = typeof human;
export const ai = 2 as const;
export type ai = typeof ai;
