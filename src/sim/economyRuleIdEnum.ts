/**
 * The stall-watchdog rules, as a JS enum module. Named so a trace can say
 * which rule spoke; the seat compares them by number.
 */
export const resiteExtractor = 1 as const;
export type resiteExtractor = typeof resiteExtractor;
export const freeCappedHauler = 2 as const;
export type freeCappedHauler = typeof freeCappedHauler;
export const resumeDrainedPost = 3 as const;
export type resumeDrainedPost = typeof resumeDrainedPost;
export const keepTheToolsComing = 4 as const;
export type keepTheToolsComing = typeof keepTheToolsComing;
export const forgeTheCounter = 5 as const;
export type forgeTheCounter = typeof forgeTheCounter;
export const holdTheGlutForge = 6 as const;
export type holdTheGlutForge = typeof holdTheGlutForge;
export const handsBeforeSoldiers = 7 as const;
export type handsBeforeSoldiers = typeof handsBeforeSoldiers;
export const keepTheQueueWarm = 8 as const;
export type keepTheQueueWarm = typeof keepTheQueueWarm;
export const openReserveMine = 9 as const;
export type openReserveMine = typeof openReserveMine;
