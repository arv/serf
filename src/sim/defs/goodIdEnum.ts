/**
 * Every good the valley moves, as a JS enum module (see shared/enum.ts).
 *
 * The values are identity, not decoration: a good's number is the SAB carry
 * code a hauler rides with, the last tiebreak in the job sort, and the key
 * every shelf in the game is stocked by. Renumbering one renumbers every
 * carried good in flight and rewrites every save, so members are appended
 * rather than slotted in — which is why the food chain and the tools sit at
 * the end instead of beside the wheat and the iron they belong with.
 *
 * One-based, so 0 is free to mean "nothing carried" in the aux byte and in
 * every optional good on a record. A falsy good id would be a bug waiting
 * on whichever hand happened to be carrying water.
 */
export const water = 1 as const;
export type water = typeof water;
export const wheat = 2 as const;
export type wheat = typeof wheat;
export const wood = 3 as const;
export type wood = typeof wood;
export const stone = 4 as const;
export type stone = typeof stone;
export const iron = 5 as const;
export type iron = typeof iron;
export const silver = 6 as const;
export type silver = typeof silver;
export const gold = 7 as const;
export type gold = typeof gold;
export const sword = 8 as const;
export type sword = typeof sword;
export const spear = 9 as const;
export type spear = typeof spear;
export const bow = 10 as const;
export type bow = typeof bow;
export const ale = 11 as const;
export type ale = typeof ale;

// The food chain, appended rather than slotted in beside wheat.
export const flour = 12 as const;
export type flour = typeof flour;
export const food = 13 as const;
export type food = typeof food;

// The tools, appended for the same reason. Six of them gate nine of the ten
// resident-worker posts (TOOL_OF in buildings.ts); the Smith that forges
// them is deliberately the one post that needs none, since it is the only
// source.
export const axe = 14 as const;
export type axe = typeof axe;
export const pickaxe = 15 as const;
export type pickaxe = typeof pickaxe;
export const scythe = 16 as const;
export type scythe = typeof scythe;
export const hammer = 17 as const;
export type hammer = typeof hammer;
export const cauldron = 18 as const;
export type cauldron = typeof cauldron;
export const rod = 19 as const;
export type rod = typeof rod;
