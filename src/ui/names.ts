import type {Enum} from '../shared/enum.ts';
import {BUILDING_DEFS, type BuildingTypeId} from '../sim/defs/buildings';
import * as GoodId from '../sim/defs/goodIdEnum.ts';
import {TECH_DEFS, type TechId} from '../sim/defs/techs';
import * as UnitTypeId from '../sim/defs/unitTypeIdEnum.ts';

type GoodId = Enum<typeof GoodId>;
type UnitTypeId = Enum<typeof UnitTypeId>;

/**
 * Display-name helpers. Buildings and techs carry their names and
 * descriptions on their defs; units and goods have no display fields, so
 * their name maps live here.
 */

export function buildingName(type: BuildingTypeId): string {
  return BUILDING_DEFS[type].name;
}

export function techName(id: TechId): string {
  return TECH_DEFS[id].name;
}

export function techDesc(id: TechId): string {
  return TECH_DEFS[id].desc;
}

const UNIT_NAMES: Record<UnitTypeId, string> = {
  [UnitTypeId.serf]: 'Serf',
  [UnitTypeId.worker]: 'Worker',
  [UnitTypeId.knight]: 'Knight',
  [UnitTypeId.spearman]: 'Spearman',
  [UnitTypeId.archer]: 'Archer',
  [UnitTypeId.bandit]: 'Bandit',
  [UnitTypeId.banditArcher]: 'Bandit Archer',
  [UnitTypeId.marauder]: 'Marauder',
};

export function unitName(unit: UnitTypeId): string {
  return UNIT_NAMES[unit];
}

/**
 * Plurals, spelled out rather than suffixed: the selection card names a
 * squad of one kind as what it is ("6 Spearmen"), and an -s on the end of
 * every name gets that one wrong. `n` of 1 gives the singular back, so the
 * caller can hand over whatever it happens to be holding.
 */
const UNIT_PLURALS: Record<UnitTypeId, string> = {
  [UnitTypeId.serf]: 'Serfs',
  [UnitTypeId.worker]: 'Workers',
  [UnitTypeId.knight]: 'Knights',
  [UnitTypeId.spearman]: 'Spearmen',
  [UnitTypeId.archer]: 'Archers',
  [UnitTypeId.bandit]: 'Bandits',
  [UnitTypeId.banditArcher]: 'Bandit Archers',
  [UnitTypeId.marauder]: 'Marauders',
};

export function unitNamePlural(unit: UnitTypeId, n: number): string {
  return n === 1 ? UNIT_NAMES[unit] : UNIT_PLURALS[unit];
}

const GOOD_NAMES: Record<GoodId, string> = {
  [GoodId.water]: 'Water',
  [GoodId.wheat]: 'Wheat',
  [GoodId.wood]: 'Wood',
  [GoodId.stone]: 'Stone',
  [GoodId.iron]: 'Iron',
  [GoodId.silver]: 'Silver',
  [GoodId.gold]: 'Gold',
  [GoodId.sword]: 'Sword',
  [GoodId.spear]: 'Spear',
  [GoodId.bow]: 'Bow',
  [GoodId.ale]: 'Ale',
  [GoodId.flour]: 'Flour',
  [GoodId.food]: 'Food',
  [GoodId.axe]: 'Axe',
  [GoodId.pickaxe]: 'Pickaxe',
  [GoodId.scythe]: 'Scythe',
  [GoodId.hammer]: 'Hammer',
  [GoodId.cauldron]: 'Cauldron',
  [GoodId.rod]: 'Fishing Rod',
};

export function goodName(good: GoodId): string {
  return GOOD_NAMES[good];
}
