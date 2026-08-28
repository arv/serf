import { BUILDING_DEFS, type BuildingTypeId } from '../sim/defs/buildings';
import { TECH_DEFS, type TechId } from '../sim/defs/techs';
import { GoodId } from '../sim/defs/goods';
import { UnitTypeId } from '../sim/defs/units';

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
