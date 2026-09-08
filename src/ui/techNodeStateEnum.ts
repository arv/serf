/**
 * How the tech tree draws one node, as a JS enum module — the five states a
 * research can be in from the panel's point of view. `delivering` and
 * `researching` are the two halves of the one study in hand: the serfs are
 * still carrying its goods to the Abbey, or the books are open.
 *
 * There is no `unaffordable`. There was, while a study was paid for out of
 * the storehouse the moment it was ordered; it is billed to the Abbey and
 * hauled there now, so an order costs nothing at the time it is given and
 * the shelf has nothing to say about whether it may be given.
 */
export const done = 1 as const;
export type done = typeof done;
export const researching = 2 as const;
export type researching = typeof researching;
export const available = 3 as const;
export type available = typeof available;
export const locked = 5 as const;
export type locked = typeof locked;
export const delivering = 6 as const;
export type delivering = typeof delivering;
