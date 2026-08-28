/**
 * Whether the match is still being played, as a JS enum module — the
 * discriminant of MatchOutcome and of the snapshot that mirrors it.
 */
export const playing = 1 as const;
export type playing = typeof playing;
export const over = 2 as const;
export type over = typeof over;
