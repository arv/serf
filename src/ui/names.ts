import { BUILDING_DEFS, type BuildingTypeId } from '../sim/defs/buildings';
import type { GoodId } from '../sim/defs/goods';
import { TECH_DEFS, type TechId } from '../sim/defs/techs';
import type { UnitTypeId } from '../sim/defs/units';

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
  serf: 'Serf',
  worker: 'Worker',
  knight: 'Knight',
  spearman: 'Spearman',
  archer: 'Archer',
  bandit: 'Bandit',
  banditArcher: 'Bandit Archer',
  marauder: 'Marauder',
};

export function unitName(unit: UnitTypeId): string {
  return UNIT_NAMES[unit];
}

const GOOD_NAMES: Record<GoodId, string> = {
  water: 'Water',
  wheat: 'Wheat',
  wood: 'Wood',
  stone: 'Stone',
  iron: 'Iron',
  silver: 'Silver',
  gold: 'Gold',
  sword: 'Sword',
  spear: 'Spear',
  bow: 'Bow',
  ale: 'Ale',
  flour: 'Flour',
  food: 'Food',
};

export function goodName(good: GoodId): string {
  return GOOD_NAMES[good];
}
