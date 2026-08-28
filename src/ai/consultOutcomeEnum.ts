/**
 * What became of one consultation, as a JS enum module: advice went
 * downstairs, the reply parsed but changed nothing, or the engine threw.
 */
export const sent = 1 as const;
export type sent = typeof sent;
export const kept = 2 as const;
export type kept = typeof kept;
export const failed = 3 as const;
export type failed = typeof failed;
