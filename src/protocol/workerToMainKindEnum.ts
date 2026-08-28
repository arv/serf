/**
 * What the sim worker sends back, as a JS enum module — the discriminant
 * of WorkerToMain. 'structural' is the one that rides every few ticks; the
 * rest are answers to a request.
 */
export const ready = 1 as const;
export type ready = typeof ready;
export const structural = 2 as const;
export type structural = typeof structural;
export const saved = 3 as const;
export type saved = typeof saved;
export const replayData = 4 as const;
export type replayData = typeof replayData;
export const aiSummary = 5 as const;
export type aiSummary = typeof aiSummary;
export const netStatus = 6 as const;
export type netStatus = typeof netStatus;
export const fatal = 7 as const;
export type fatal = typeof fatal;
export const replayEnded = 8 as const;
export type replayEnded = typeof replayEnded;
export const log = 9 as const;
export type log = typeof log;
