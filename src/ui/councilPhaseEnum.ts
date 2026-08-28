/**
 * How far the war council has got, as a JS enum module: still opening the
 * socket, or in the room.
 */
export const connecting = 1 as const;
export type connecting = typeof connecting;
export const lobby = 2 as const;
export type lobby = typeof lobby;
