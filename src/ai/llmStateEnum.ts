/**
 * How the local model is doing, as a JS enum module — the discriminant of
 * LlmStatus.
 */
export const loading = 1 as const;
export type loading = typeof loading;
export const ready = 2 as const;
export type ready = typeof ready;
export const failed = 3 as const;
export type failed = typeof failed;
