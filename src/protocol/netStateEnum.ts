/**
 * How the socket is doing, as a JS enum module — the discriminant of
 * NetStatus. 'gone' is terminal: the room no longer knows us, so there is
 * nothing to reconnect to.
 */
export const ok = 1 as const;
export type ok = typeof ok;
export const disconnected = 2 as const;
export type disconnected = typeof disconnected;
export const gone = 3 as const;
export type gone = typeof gone;
