import { GOODS } from './goods.ts';
import { GoodId } from './goods.ts';

/**
 * Unit definitions. `kindCode`/`ownerCode` are the compact byte encodings
 * used in the SAB hot path — keep them stable.
 */
export type UnitClass = 'heavy' | 'light' | 'ranged';

export interface CombatStats {
  class: UnitClass;
  damage: number;
  cooldownTicks: number;
  range: number; // tiles
  acquireRadius: number; // tiles
}

export interface UnitDef {
  id: UnitTypeId;
  kindCode: number;
  speed: number; // tiles/sec
  hp: number;
  /** How far this unit reveals the map, in tiles. Read by both the server's
   * visibility filter and the renderer's fog, so the two cannot drift. */
  sight: number;
  combat?: CombatStats;
}

export type UnitTypeId =
  | 'serf'
  | 'worker'
  | 'knight'
  | 'spearman'
  | 'archer'
  | 'bandit'
  | 'banditArcher'
  | 'marauder';

/**
 * The military triangle: heavy beats light, light catches ranged, ranged
 * kites heavy. Enemy kinds mirror the classes so counters matter both ways.
 */
export const UNIT_DEFS: Record<UnitTypeId, UnitDef> = {
  serf: { id: 'serf', kindCode: 1, speed: 1.5, hp: 25, sight: 6.5 },
  worker: { id: 'worker', kindCode: 2, speed: 1.4, hp: 25, sight: 6.5 },
  knight: {
    id: 'knight',
    kindCode: 3,
    speed: 1.6,
    hp: 80,
    sight: 6.5,
    combat: { class: 'heavy', damage: 10, cooldownTicks: 20, range: 1.3, acquireRadius: 6 },
  },
  spearman: {
    id: 'spearman',
    kindCode: 4,
    speed: 2.4,
    hp: 45,
    sight: 6.5,
    combat: { class: 'light', damage: 7, cooldownTicks: 20, range: 1.3, acquireRadius: 6 },
  },
  archer: {
    id: 'archer',
    kindCode: 5,
    speed: 2.0,
    hp: 35,
    sight: 6.5,
    combat: { class: 'ranged', damage: 6, cooldownTicks: 24, range: 5, acquireRadius: 7 },
  },
  bandit: {
    id: 'bandit',
    kindCode: 6,
    speed: 2.0,
    hp: 40,
    sight: 6.5,
    combat: { class: 'light', damage: 6, cooldownTicks: 20, range: 1.3, acquireRadius: 8 },
  },
  banditArcher: {
    id: 'banditArcher',
    kindCode: 7,
    speed: 1.9,
    hp: 30,
    sight: 6.5,
    combat: { class: 'ranged', damage: 5, cooldownTicks: 24, range: 5, acquireRadius: 8 },
  },
  marauder: {
    id: 'marauder',
    kindCode: 8,
    speed: 1.5,
    hp: 70,
    sight: 6.5,
    combat: { class: 'heavy', damage: 9, cooldownTicks: 20, range: 1.3, acquireRadius: 8 },
  },
};

/** The whole RPS system: damage multiplier attacker-class -> defender-class. */
export const COUNTER_TABLE: Record<UnitClass, Record<UnitClass, number>> = {
  heavy: { heavy: 1.0, light: 1.5, ranged: 0.67 },
  light: { heavy: 0.67, light: 1.0, ranged: 1.5 },
  ranged: { heavy: 1.5, light: 0.67, ranged: 1.0 },
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
  knight: GoodId.sword,
  spearman: GoodId.spear,
  archer: GoodId.bow,
};
