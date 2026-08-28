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
export const storehouse = 1;
export type storehouse = typeof storehouse;
export const banditCamp = 2;
export type banditCamp = typeof banditCamp;
export const woodcutter = 3;
export type woodcutter = typeof woodcutter;
export const quarry = 4;
export type quarry = typeof quarry;
export const house = 5;
export type house = typeof house;
export const well = 6;
export type well = typeof well;
export const wheatFarm = 7;
export type wheatFarm = typeof wheatFarm;
export const mill = 8;
export type mill = typeof mill;
export const bakery = 9;
export type bakery = typeof bakery;
export const fishery = 10;
export type fishery = typeof fishery;
export const brewery = 11;
export type brewery = typeof brewery;
export const ironMine = 12;
export type ironMine = typeof ironMine;
export const silverMine = 13;
export type silverMine = typeof silverMine;
export const goldMine = 14;
export type goldMine = typeof goldMine;
export const weaponsmith = 15;
export type weaponsmith = typeof weaponsmith;
export const abbey = 16;
export type abbey = typeof abbey;
export const barracks = 17;
export type barracks = typeof barracks;
export const guardTower = 18;
export type guardTower = typeof guardTower;
export const roadSite = 19;
export type roadSite = typeof roadSite;
