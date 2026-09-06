/**
 * Every building that can stand in the valley, as a JS enum module (see
 * shared/enum.ts).
 *
 * Order is BUILDING_DEFS' order, which is the order the build ribbon and
 * the docs index read in; one-based, so 0 is free to mean "no building"
 * wherever a slot is optional.
 *
 * The numbers ride in saves and in command frames, so they are append-only
 * — a new roof takes the next id rather than a tidy place in the middle.
 */
export const storehouse = 1 as const;
export type storehouse = typeof storehouse;
export const banditCamp = 2 as const;
export type banditCamp = typeof banditCamp;
export const woodcutter = 3 as const;
export type woodcutter = typeof woodcutter;
export const quarry = 4 as const;
export type quarry = typeof quarry;
export const house = 5 as const;
export type house = typeof house;
export const well = 6 as const;
export type well = typeof well;
export const wheatFarm = 7 as const;
export type wheatFarm = typeof wheatFarm;
export const mill = 8 as const;
export type mill = typeof mill;
export const bakery = 9 as const;
export type bakery = typeof bakery;
export const fishery = 10 as const;
export type fishery = typeof fishery;
export const brewery = 11 as const;
export type brewery = typeof brewery;
export const ironMine = 12 as const;
export type ironMine = typeof ironMine;
export const silverMine = 13 as const;
export type silverMine = typeof silverMine;
export const goldMine = 14 as const;
export type goldMine = typeof goldMine;
export const weaponsmith = 15 as const;
export type weaponsmith = typeof weaponsmith;
export const abbey = 16 as const;
export type abbey = typeof abbey;
export const barracks = 17 as const;
export type barracks = typeof barracks;
export const guardTower = 18 as const;
export type guardTower = typeof guardTower;
export const roadSite = 19 as const;
export type roadSite = typeof roadSite;
export const salvage = 20 as const;
export type salvage = typeof salvage;
export const monument = 21 as const;
export type monument = typeof monument;
