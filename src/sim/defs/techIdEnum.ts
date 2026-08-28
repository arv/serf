/**
 * Every research, as a JS enum module (see shared/enum.ts).
 * 
 * Order is TECH_DEFS' order, which is the order the tech tree lays its
 * branches out; one-based, and append-only — the ids ride in saves and in
 * the research command.
 */
export const irrigation = 1 as const;
export type irrigation = typeof irrigation;
export const millstones = 2 as const;
export type millstones = typeof millstones;
export const brewing = 3 as const;
export type brewing = typeof brewing;
export const festivals = 4 as const;
export type festivals = typeof festivals;
export const aleRations = 5 as const;
export type aleRations = typeof aleRations;
export const cobbledBoots = 6 as const;
export type cobbledBoots = typeof cobbledBoots;
export const ironworking = 7 as const;
export type ironworking = typeof ironworking;
export const deepMining = 8 as const;
export type deepMining = typeof deepMining;
export const bellows = 9 as const;
export type bellows = typeof bellows;
export const masonry = 10 as const;
export type masonry = typeof masonry;
export const soldiery = 11 as const;
export type soldiery = typeof soldiery;
export const archery = 12 as const;
export type archery = typeof archery;
export const mailArmor = 13 as const;
export type mailArmor = typeof mailArmor;
export const gildedArms = 14 as const;
export type gildedArms = typeof gildedArms;
