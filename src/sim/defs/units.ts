import type { Enum } from '../../shared/enum.ts';
import { GoodId } from './goods.ts';
import * as UnitTypeIdNs from './unitTypeIdEnum.ts';
import * as UnitClassNs from './unitClassEnum.ts';

export * as UnitClass from './unitClassEnum.ts';
export type UnitClass = Enum<typeof UnitClassNs>;

export * as UnitTypeId from './unitTypeIdEnum.ts';
export type UnitTypeId = Enum<typeof UnitTypeIdNs>;

const U = UnitTypeIdNs;

/**
 * Unit definitions. A unit's id IS its compact byte encoding in the SAB hot
 * path (unitTypeIdEnum.ts) — keep the numbers stable.
 */


export interface CombatStats {
  class: UnitClass;
  damage: number;
  cooldownTicks: number;
  range: number; // tiles
  acquireRadius: number; // tiles
}

export interface UnitDef {
  id: UnitTypeId;
  speed: number; // tiles/sec
  hp: number;
  /** How far this unit reveals the map, in tiles. Read by both the server's
   * visibility filter and the renderer's fog, so the two cannot drift. */
  sight: number;
  combat?: CombatStats;
}

/**
 * The military triangle: heavy beats light, light catches ranged, ranged
 * kites heavy. Enemy kinds mirror the classes so counters matter both ways.
 */
export const UNIT_DEFS: Record<UnitTypeId, UnitDef> = {
  [U.serf]: { id: U.serf, speed: 1.5, hp: 25, sight: 6.5 },
  [U.worker]: { id: U.worker, speed: 1.4, hp: 25, sight: 6.5 },
  [U.knight]: {
    id: U.knight,
    speed: 1.6,
    hp: 80,
    sight: 6.5,
    combat: { class: UnitClassNs.heavy, damage: 10, cooldownTicks: 20, range: 1.3, acquireRadius: 6 },
  },
  [U.spearman]: {
    id: U.spearman,
    speed: 2.4,
    hp: 45,
    sight: 6.5,
    combat: { class: UnitClassNs.light, damage: 7, cooldownTicks: 20, range: 1.3, acquireRadius: 6 },
  },
  [U.archer]: {
    id: U.archer,
    speed: 2.0,
    hp: 35,
    sight: 6.5,
    combat: { class: UnitClassNs.ranged, damage: 6, cooldownTicks: 24, range: 5, acquireRadius: 7 },
  },
  [U.bandit]: {
    id: U.bandit,
    speed: 2.0,
    hp: 40,
    sight: 6.5,
    combat: { class: UnitClassNs.light, damage: 6, cooldownTicks: 20, range: 1.3, acquireRadius: 8 },
  },
  [U.banditArcher]: {
    id: U.banditArcher,
    speed: 1.9,
    hp: 30,
    sight: 6.5,
    combat: { class: UnitClassNs.ranged, damage: 5, cooldownTicks: 24, range: 5, acquireRadius: 8 },
  },
  [U.marauder]: {
    id: U.marauder,
    speed: 1.5,
    hp: 70,
    sight: 6.5,
    combat: { class: UnitClassNs.heavy, damage: 9, cooldownTicks: 20, range: 1.3, acquireRadius: 8 },
  },
};

/** The whole RPS system: damage multiplier attacker-class -> defender-class. */
export const COUNTER_TABLE: Record<UnitClass, Record<UnitClass, number>> = {
  [UnitClassNs.heavy]: { [UnitClassNs.heavy]: 1.0, [UnitClassNs.light]: 1.5, [UnitClassNs.ranged]: 0.67 },
  [UnitClassNs.light]: { [UnitClassNs.heavy]: 0.67, [UnitClassNs.light]: 1.0, [UnitClassNs.ranged]: 1.5 },
  [UnitClassNs.ranged]: { [UnitClassNs.heavy]: 1.5, [UnitClassNs.light]: 0.67, [UnitClassNs.ranged]: 1.0 },
};

/**
 * SAB byte for a carried good: the good's own id, and 0 for empty hands.
 *
 * The two were a table lookup apart while a good was a word; now that a
 * good is a number chosen to be its own carry code (goodIdEnum.ts is
 * one-based for exactly this), the encoding is the identity and these
 * exist only to say so at the boundary.
 */
export function carryingCode(good: GoodId | undefined): number {
  return good ?? 0;
}

export function goodFromCarryingCode(code: number): GoodId | undefined {
  return code === 0 ? undefined : (code as GoodId);
}

/** What a soldier needs forged before the barracks can start on them. */
export const WEAPON_OF: Partial<Record<UnitTypeId, GoodId>> = {
  [U.knight]: GoodId.sword,
  [U.spearman]: GoodId.spear,
  [U.archer]: GoodId.bow,
};

/** Every unit kind, in id order — the enumeration order UNIT_DEFS had. */
export const UNIT_TYPES: readonly UnitTypeId[] = [
  U.serf,
  U.worker,
  U.knight,
  U.spearman,
  U.archer,
  U.bandit,
  U.banditArcher,
  U.marauder,
];

/** The spelling of each id, for docs URLs and the strategist's prompt. */
export const UNIT_KEYS: Readonly<Record<UnitTypeId, string>> = {
  [U.serf]: 'serf',
  [U.worker]: 'worker',
  [U.knight]: 'knight',
  [U.spearman]: 'spearman',
  [U.archer]: 'archer',
  [U.bandit]: 'bandit',
  [U.banditArcher]: 'banditArcher',
  [U.marauder]: 'marauder',
};

const UNIT_BY_KEY = new Map<string, UnitTypeId>(UNIT_TYPES.map((u) => [UNIT_KEYS[u], u]));

/** The id a spelling names, or undefined — the read side of UNIT_KEYS. */
export function unitFromKey(key: string): UnitTypeId | undefined {
  return UNIT_BY_KEY.get(key);
}

/**
 * One untrusted value as a unit id, or undefined.
 *
 * Two dialects reach the advice screen and both are legitimate: the model
 * answers in words, because the menu it was shown is words, while the lab's
 * mutator builds advice out of ids directly. Neither is more trusted than
 * the other, so both are screened here rather than at either caller.
 */
export function asUnitTypeId(value: unknown): UnitTypeId | undefined {
  if (typeof value === 'string') return unitFromKey(value);
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  return Object.hasOwn(UNIT_KEYS, value) ? (value as UnitTypeId) : undefined;
}
