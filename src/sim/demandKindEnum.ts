/**
 * Which of a building's demands is keeping one of its FIFO clocks, as a JS
 * enum module (see shared/enum.ts) — and bit flags rather than a plain
 * enum, because one clock can be kept by several demands at once: the age
 * is per (building, good) while the demands are not (Building.demandHeld,
 * and settleAges in systems/logistics.ts, which reads them).
 */
/** A site's construction materials. */
export const site = 1 as const;
export type site = typeof site;
/**
 * A post's tool: pre-ordered while the walls rise, called for while the
 * post stands open. One demand across the day the roof tops out, so one
 * mark — the axe still on the road when the builder walks onto the post
 * keeps the place in the queue it was ordered at.
 */
export const tool = 2 as const;
export type tool = typeof tool;
/** An ordered repair's bill. */
export const repair = 4 as const;
export type repair = typeof repair;
/** A study's bill. */
export const research = 8 as const;
export type research = typeof research;
/** A convert recipe's inputs — the Smith's follow what it forges next. */
export const input = 16 as const;
export type input = typeof input;
/** A mine's pantry. */
export const ration = 32 as const;
export type ration = typeof ration;
/** The Abbey's standing ale, with Festivals in. */
export const festival = 64 as const;
export type festival = typeof festival;
/** The barracks' ration cask, with Ale Rations in. */
export const cask = 128 as const;
export type cask = typeof cask;
/** A training queue's wheat and weapons. */
export const training = 256 as const;
export type training = typeof training;
/**
 * A producer's surplus, waiting to be carried to the storehouse. The
 * demand is the storehouse's, but the age is kept on the producer.
 */
export const evac = 512 as const;
export type evac = typeof evac;
