import { THEME } from '../render/medieval';
import { BUILDING_DEFS, type BuildingTypeId } from '../sim/defs/buildings';
import type { GoodId } from '../sim/defs/goods';
import { TECH_DEFS, type TechId } from '../sim/defs/techs';
import type { UnitTypeId } from '../sim/defs/units';

/**
 * Theme-aware display names. Sim ids stay Japanese (they're internal
 * plumbing and saves depend on them); only what the player reads changes.
 * With ?theme=japan everything falls through to the def names.
 */

const M = THEME === 'medieval';

const MEDIEVAL_BUILDINGS: Partial<Record<BuildingTypeId, string>> = {
  storehouse: 'Castle',
  bambooHut: 'Woodcutter',
  ricePaddy: 'Wheat Farm',
  sakeBrewery: 'Brewery',
  dojo: 'Barracks',
  terakoya: 'Abbey',
};

export function buildingName(type: BuildingTypeId): string {
  return (M ? MEDIEVAL_BUILDINGS[type] : undefined) ?? BUILDING_DEFS[type].name;
}

const MEDIEVAL_TECHS: Partial<Record<TechId, { name?: string; desc?: string }>> = {
  irrigation: { desc: 'Field channels: farms grow wheat 30% faster.' },
  sakeBrewing: { name: 'Brewing', desc: 'Unlocks the Brewery.' },
  festivals: {
    desc: 'Ale delivered to the Abbey holds festivals: everyone works 25% faster for a while.',
  },
  strawSandals: { name: 'Cobbled Boots' },
  bushido: { name: 'Soldiery', desc: 'Unlocks the Barracks and Spearmen.' },
  archery: { desc: 'Unlocks the Bowyer and Archers.' },
  lamellarArmor: { name: 'Mail Armor' },
  goldInlay: { name: 'Gilded Arms' },
};

export function techName(id: TechId): string {
  return (M ? MEDIEVAL_TECHS[id]?.name : undefined) ?? TECH_DEFS[id].name;
}

export function techDesc(id: TechId): string {
  return (M ? MEDIEVAL_TECHS[id]?.desc : undefined) ?? TECH_DEFS[id].desc;
}

const JAPAN_UNITS: Record<UnitTypeId, string> = {
  serf: 'Serf',
  worker: 'Worker',
  samurai: 'Samurai',
  ashigaru: 'Ashigaru',
  archer: 'Archer',
  bandit: 'Bandit',
  banditArcher: 'Bandit Archer',
  ronin: 'Rōnin',
};

const MEDIEVAL_UNITS: Partial<Record<UnitTypeId, string>> = {
  samurai: 'Knight',
  ashigaru: 'Spearman',
  ronin: 'Marauder',
};

export function unitName(unit: UnitTypeId): string {
  return (M ? MEDIEVAL_UNITS[unit] : undefined) ?? JAPAN_UNITS[unit];
}

const JAPAN_GOODS: Record<GoodId, string> = {
  water: 'Water',
  rice: 'Rice',
  bamboo: 'Bamboo',
  stone: 'Stone',
  iron: 'Iron',
  silver: 'Silver',
  gold: 'Gold',
  katana: 'Katana',
  yari: 'Yari',
  yumi: 'Yumi',
  sake: 'Sake',
};

const MEDIEVAL_GOODS: Partial<Record<GoodId, string>> = {
  rice: 'Wheat',
  bamboo: 'Wood',
  katana: 'Sword',
  yari: 'Spear',
  yumi: 'Bow',
  sake: 'Ale',
};

export function goodName(good: GoodId): string {
  return (M ? MEDIEVAL_GOODS[good] : undefined) ?? JAPAN_GOODS[good];
}
