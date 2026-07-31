import { GOODS, type GoodId } from './goods.ts';

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
  combat?: CombatStats;
}

export type UnitTypeId =
  | 'serf'
  | 'worker'
  | 'samurai'
  | 'ashigaru'
  | 'archer'
  | 'bandit'
  | 'banditArcher'
  | 'ronin';

/**
 * The military triangle: heavy beats light, light catches ranged, ranged
 * kites heavy. Enemy kinds mirror the classes so counters matter both ways.
 */
export const UNIT_DEFS: Record<UnitTypeId, UnitDef> = {
  serf: { id: 'serf', kindCode: 1, speed: 1.8, hp: 25 },
  worker: { id: 'worker', kindCode: 2, speed: 1.7, hp: 25 },
  samurai: {
    id: 'samurai',
    kindCode: 3,
    speed: 1.6,
    hp: 80,
    combat: { class: 'heavy', damage: 10, cooldownTicks: 20, range: 1.3, acquireRadius: 6 },
  },
  ashigaru: {
    id: 'ashigaru',
    kindCode: 4,
    speed: 2.4,
    hp: 45,
    combat: { class: 'light', damage: 7, cooldownTicks: 20, range: 1.3, acquireRadius: 6 },
  },
  archer: {
    id: 'archer',
    kindCode: 5,
    speed: 2.0,
    hp: 35,
    combat: { class: 'ranged', damage: 6, cooldownTicks: 24, range: 5, acquireRadius: 7 },
  },
  bandit: {
    id: 'bandit',
    kindCode: 6,
    speed: 2.0,
    hp: 40,
    combat: { class: 'light', damage: 6, cooldownTicks: 20, range: 1.3, acquireRadius: 8 },
  },
  banditArcher: {
    id: 'banditArcher',
    kindCode: 7,
    speed: 1.9,
    hp: 30,
    combat: { class: 'ranged', damage: 5, cooldownTicks: 24, range: 5, acquireRadius: 8 },
  },
  ronin: {
    id: 'ronin',
    kindCode: 8,
    speed: 1.5,
    hp: 70,
    combat: { class: 'heavy', damage: 9, cooldownTicks: 20, range: 1.3, acquireRadius: 8 },
  },
};

/** The whole RPS system: damage multiplier attacker-class -> defender-class. */
export const COUNTER_TABLE: Record<UnitClass, Record<UnitClass, number>> = {
  heavy: { heavy: 1.0, light: 1.5, ranged: 0.67 },
  light: { heavy: 0.67, light: 1.0, ranged: 1.5 },
  ranged: { heavy: 1.5, light: 0.67, ranged: 1.0 },
};

/** SAB byte for a carried good: 0 = nothing, else GOODS index + 1. */
export function carryingCode(good: GoodId | undefined): number {
  return good === undefined ? 0 : GOODS.indexOf(good) + 1;
}

export function goodFromCarryingCode(code: number): GoodId | undefined {
  return code === 0 ? undefined : GOODS[code - 1];
}
