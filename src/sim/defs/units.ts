import type {Enum} from '../../shared/enum.ts';
import * as GoodId from './goodIdEnum.ts';
import * as UnitClassNs from './unitClassEnum.ts';
import * as UnitTypeIdNs from './unitTypeIdEnum.ts';

type GoodId = Enum<typeof GoodId>;

export type UnitClass = Enum<typeof UnitClassNs>;

export type UnitTypeId = Enum<typeof UnitTypeIdNs>;

const U = UnitTypeIdNs;

/**
 * Unit definitions. A unit's id IS its compact byte encoding in the SAB hot
 * path (unitTypeIdEnum.ts) — keep the numbers stable.
 */

/**
 * The stat block a unit actually fights by — what target acquisition, the
 * chase, the strike and the siege all read.
 *
 * `class` is where the man stands in the counter triangle, and it is
 * optional because one fighter stands outside it: a villager with a knife
 * (see MILITIA). His blows land flat and he scores his targets by plain
 * distance, because the triangle prices trained arms against each other
 * and a pitchfork is not one.
 */
export interface FightStats {
  class: UnitClass | undefined;
  damage: number;
  cooldownTicks: number;
  range: number; // tiles
  acquireRadius: number; // tiles
}

/** A soldier's: the same block with his place in the triangle fixed. */
export interface CombatStats extends FightStats {
  class: UnitClass;
}

export interface UnitDef {
  id: UnitTypeId;
  speed: number; // tiles/sec
  hp: number;
  /** How far this unit reveals the map, in tiles. Read by both the server's
   * visibility filter and the renderer's fog, so the two cannot drift. */
  sight: number;
  combat?: CombatStats;
  /**
   * The civilians'. A unit has this or `combat`, never both — a soldier's
   * last resort is his weapon. See MILITIA for what it costs him, and
   * systems/combat.ts for the two modes it is read in.
   */
  militia?: FightStats;
}

/**
 * The villager's knife.
 *
 * Deliberately NOT spelled as `UnitDef.combat`: that field is the whole
 * engine's word for "this one is a soldier" — the army count, the
 * formation rank, the select-army key, the AI's reading of a rival's
 * strength, the tower's counter-scored pick, who takes up room on the
 * field — and a serf holding a knife is still a serf in every one of
 * them. What he gains is a way to strike, not a place in the order of
 * battle.
 *
 * A fifth of a bandit's output and slower than any weapon on the field.
 *
 * Two modes, two prices. Cut down one at a time on their errands, a serf
 * lands about three of these before he falls, so a bandit walks through
 * some seven of them before the last one's knife finishes him. Sent in
 * together under an A order they trade better — four take a bandit, seven
 * take a knight and three of those seven walk away — and still badly
 * enough that it is never the plan. It is an answer, not an army.
 *
 * No class, so no counter table on either side of the blow: he neither
 * counters nor is countered, and against a wall he is the worst siege
 * engine on the map (MILITIA_BUILDING_MULT in systems/combat.ts).
 *
 * Reach is every melee arm's (1.3) — he fights like the melee unit he is
 * imitating, and shorter would be no reach at all in the mode where he
 * never takes a step. The acquire radius is his own: four tiles against a
 * soldier's six or eight, because a man with a knife notices what is on
 * top of him, not what is across the field.
 */
export const MILITIA: FightStats = {
  class: undefined,
  damage: 2,
  cooldownTicks: 30,
  range: 1.3,
  acquireRadius: 4,
};

/**
 * The military triangle: heavy beats light, light catches ranged, ranged
 * kites heavy. Enemy kinds mirror the classes so counters matter both ways.
 */
export const UNIT_DEFS: Record<UnitTypeId, UnitDef> = {
  [U.serf]: {
    id: U.serf,
    speed: 1.5,
    hp: 25,
    sight: 6.5,
    militia: MILITIA,
  },
  // A worker is a serf who took a post, so he keeps the serf's knife: the
  // same man does not disarm himself by going to work at the mill.
  [U.worker]: {
    id: U.worker,
    speed: 1.4,
    hp: 25,
    sight: 6.5,
    militia: MILITIA,
  },
  [U.knight]: {
    id: U.knight,
    speed: 1.6,
    hp: 80,
    sight: 6.5,
    combat: {
      class: UnitClassNs.heavy,
      damage: 10,
      cooldownTicks: 20,
      range: 1.3,
      acquireRadius: 6,
    },
  },
  [U.spearman]: {
    id: U.spearman,
    speed: 2.4,
    hp: 45,
    sight: 6.5,
    combat: {
      class: UnitClassNs.light,
      damage: 7,
      cooldownTicks: 20,
      range: 1.3,
      acquireRadius: 6,
    },
  },
  [U.archer]: {
    id: U.archer,
    speed: 2.0,
    // 32 rather than 35: the archer's staying power is what the kite is
    // bought with, and until KITE_PLANT_TICKS (systems/combat.ts) the kite
    // cost nothing at all. Hit points are the one dial that prices it
    // without reaching past the duel — damage, cooldown and range all also
    // set the tower garrison's output, the bandit archer's identity, or
    // both. Still above the bandit archer's 30, which is the floor: a bow
    // off the village barracks must beat a bow off a camp.
    hp: 32,
    sight: 6.5,
    combat: {
      class: UnitClassNs.ranged,
      damage: 6,
      cooldownTicks: 24,
      range: 5,
      acquireRadius: 7,
    },
  },
  [U.bandit]: {
    id: U.bandit,
    speed: 2.0,
    hp: 40,
    sight: 6.5,
    combat: {
      class: UnitClassNs.light,
      damage: 6,
      cooldownTicks: 20,
      range: 1.3,
      acquireRadius: 8,
    },
  },
  [U.banditArcher]: {
    id: U.banditArcher,
    speed: 1.9,
    hp: 30,
    sight: 6.5,
    combat: {
      class: UnitClassNs.ranged,
      damage: 5,
      cooldownTicks: 24,
      range: 5,
      acquireRadius: 8,
    },
  },
  [U.marauder]: {
    id: U.marauder,
    speed: 1.5,
    hp: 70,
    sight: 6.5,
    combat: {
      class: UnitClassNs.heavy,
      damage: 9,
      cooldownTicks: 20,
      range: 1.3,
      acquireRadius: 8,
    },
  },
};

/** The whole RPS system: damage multiplier attacker-class -> defender-class. */
export const COUNTER_TABLE: Record<UnitClass, Record<UnitClass, number>> = {
  [UnitClassNs.heavy]: {
    [UnitClassNs.heavy]: 1.0,
    [UnitClassNs.light]: 1.5,
    [UnitClassNs.ranged]: 0.67,
  },
  [UnitClassNs.light]: {
    [UnitClassNs.heavy]: 0.67,
    [UnitClassNs.light]: 1.0,
    [UnitClassNs.ranged]: 1.5,
  },
  [UnitClassNs.ranged]: {
    [UnitClassNs.heavy]: 1.5,
    [UnitClassNs.light]: 0.67,
    [UnitClassNs.ranged]: 1.0,
  },
};

/**
 * Battle order for a mixed move order: lower ranks take the tiles nearest
 * the front. Heavy walks point so a charge out of the destination breaks on
 * it, light backs the line, and ranged shelters behind, shooting over both.
 */
export const FORMATION_RANK: Record<UnitClass, number> = {
  [UnitClassNs.heavy]: 0,
  [UnitClassNs.light]: 1,
  [UnitClassNs.ranged]: 2,
};

/** The rank of a unit with no combat def: civilians caught in the same
 * order file in behind every soldier. */
export const CIVILIAN_FORMATION_RANK = 3;

/**
 * A unit's own ground speed, tiles/sec: the def's speed, with the civilian
 * walk-speed tech (ModifierKey.serfSpeed) applied for serfs and workers.
 * The one spelling of that rule — movement's budget and a squad's marching
 * pace must agree on it, or a booted serf outruns the column that paced
 * itself by his raw stride.
 */
export function effectiveSpeed(kind: UnitTypeId, serfSpeedMod: number): number {
  const civilian = kind === U.serf || kind === U.worker;
  return UNIT_DEFS[kind].speed * (civilian ? serfSpeedMod : 1);
}

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

const UNIT_BY_KEY = new Map<string, UnitTypeId>(
  UNIT_TYPES.map(u => [UNIT_KEYS[u], u]),
);

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
