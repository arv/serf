/**
 * What the main thread asks the sim worker for, as a JS enum module — the
 * discriminant of MainToWorker.
 */
export const init = 1 as const;
export type init = typeof init;
export const commands = 2 as const;
export type commands = typeof commands;
export const aiAdvice = 3 as const;
export type aiAdvice = typeof aiAdvice;
export const setSpeed = 4 as const;
export type setSpeed = typeof setSpeed;
export const setDebug = 5 as const;
export type setDebug = typeof setDebug;
export const setHidden = 6 as const;
export type setHidden = typeof setHidden;
export const requestSave = 7 as const;
export type requestSave = typeof requestSave;
export const requestReplay = 8 as const;
export type requestReplay = typeof requestReplay;
