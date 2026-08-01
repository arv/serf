import type { GoodAmounts } from './goods.ts';
import type { BuildingTypeId } from './buildings.ts';
import type { UnitTypeId } from './units.ts';

/**
 * The tech tree: three short branches researched at the Abbey for goods +
 * time. Effects are typed and read on demand — `unlock*` gates checks,
 * `modifier` multipliers are combined by getModifier(), so adding a tech is
 * pure data.
 */
export type TechId =
  | 'irrigation'
  | 'brewing'
  | 'festivals'
  | 'cobbledBoots'
  | 'ironworking'
  | 'deepMining'
  | 'masonry'
  | 'soldiery'
  | 'archery'
  | 'mailArmor'
  | 'gildedArms';

export type ModifierKey =
  | 'farmSpeed' // wheat farm batch speed
  | 'mineSpeed' // mine gather speed
  | 'serfSpeed' // serf + worker walk speed
  | 'workSpeed' // all production speed (festival buff)
  | 'militaryHp'; // military max hp at training time

export type TechEffect =
  | { kind: 'unlockBuilding'; building: BuildingTypeId }
  | { kind: 'unlockUnit'; unit: UnitTypeId }
  | { kind: 'modifier'; key: ModifierKey; multiplier: number }
  | { kind: 'unlockPaving' };

export type TechBranch = 'agriculture' | 'craft' | 'warfare';

export interface TechDef {
  id: TechId;
  name: string;
  branch: TechBranch;
  prereqs: TechId[];
  cost: GoodAmounts;
  durationTicks: number;
  effects: TechEffect[];
  desc: string;
}

const S = 20; // ticks per second

export const TECH_DEFS: Record<TechId, TechDef> = {
  // — Agriculture —
  irrigation: {
    id: 'irrigation',
    name: 'Irrigation',
    branch: 'agriculture',
    prereqs: [],
    cost: { wheat: 5, silver: 3 },
    durationTicks: 25 * S,
    effects: [{ kind: 'modifier', key: 'farmSpeed', multiplier: 1.3 }],
    desc: 'Field channels: farms grow wheat 30% faster.',
  },
  brewing: {
    id: 'brewing',
    name: 'Brewing',
    branch: 'agriculture',
    prereqs: ['irrigation'],
    cost: { wheat: 8, silver: 4 },
    durationTicks: 30 * S,
    effects: [{ kind: 'unlockBuilding', building: 'brewery' }],
    desc: 'Unlocks the Brewery.',
  },
  festivals: {
    id: 'festivals',
    name: 'Festivals',
    branch: 'agriculture',
    prereqs: ['brewing'],
    cost: { ale: 2, silver: 6 },
    durationTicks: 30 * S,
    effects: [], // enables the abbey's ale-fed festival buff
    desc: 'Ale delivered to the Abbey holds festivals: everyone works 25% faster for a while.',
  },

  // — Craft —
  cobbledBoots: {
    id: 'cobbledBoots',
    name: 'Cobbled Boots',
    branch: 'craft',
    prereqs: [],
    cost: { wheat: 4, silver: 2 },
    durationTicks: 20 * S,
    effects: [{ kind: 'modifier', key: 'serfSpeed', multiplier: 1.15 }],
    desc: 'Serfs and workers walk 15% faster.',
  },
  ironworking: {
    id: 'ironworking',
    name: 'Ironworking',
    branch: 'craft',
    prereqs: ['cobbledBoots'],
    cost: { stone: 6, silver: 8 },
    durationTicks: 40 * S,
    effects: [
      { kind: 'unlockBuilding', building: 'ironMine' },
      { kind: 'unlockBuilding', building: 'swordsmith' },
      { kind: 'unlockBuilding', building: 'spearmaker' },
    ],
    desc: 'Unlocks the Iron Mine, Swordsmith, and Spearmaker.',
  },
  deepMining: {
    id: 'deepMining',
    name: 'Deep Mining',
    branch: 'craft',
    prereqs: ['ironworking'],
    cost: { iron: 4, silver: 8 },
    durationTicks: 35 * S,
    effects: [
      { kind: 'modifier', key: 'mineSpeed', multiplier: 1.3 },
      { kind: 'unlockBuilding', building: 'goldMine' },
    ],
    desc: 'Mines work 30% faster; unlocks the Gold Mine.',
  },
  masonry: {
    id: 'masonry',
    name: 'Masonry',
    branch: 'craft',
    prereqs: ['cobbledBoots'],
    cost: { stone: 8, silver: 4 },
    durationTicks: 30 * S,
    effects: [{ kind: 'unlockPaving' }],
    desc: 'Heavily-trodden trails are paved into stone roads (+35% speed, permanent).',
  },

  // — Warfare —
  soldiery: {
    id: 'soldiery',
    name: 'Soldiery',
    branch: 'warfare',
    prereqs: [],
    cost: { wheat: 6, silver: 6 },
    durationTicks: 30 * S,
    effects: [
      { kind: 'unlockBuilding', building: 'barracks' },
      { kind: 'unlockUnit', unit: 'spearman' },
    ],
    desc: 'Unlocks the Barracks and Spearmen.',
  },
  archery: {
    id: 'archery',
    name: 'Archery',
    branch: 'warfare',
    prereqs: ['soldiery'],
    cost: { wood: 8, silver: 6 },
    durationTicks: 30 * S,
    effects: [
      { kind: 'unlockBuilding', building: 'bowyer' },
      { kind: 'unlockUnit', unit: 'archer' },
    ],
    desc: 'Unlocks the Bowyer and Archers.',
  },
  mailArmor: {
    id: 'mailArmor',
    name: 'Mail Armor',
    branch: 'warfare',
    prereqs: ['soldiery'],
    cost: { iron: 4, silver: 8 },
    durationTicks: 35 * S,
    effects: [{ kind: 'modifier', key: 'militaryHp', multiplier: 1.25 }],
    desc: 'Military units train with 25% more health.',
  },
  gildedArms: {
    id: 'gildedArms',
    name: 'Gilded Arms',
    branch: 'warfare',
    prereqs: ['mailArmor'],
    cost: { gold: 4, silver: 10 },
    durationTicks: 40 * S,
    effects: [{ kind: 'modifier', key: 'militaryHp', multiplier: 1.2 }],
    desc: 'Gilded arms: military units train with a further 20% more health.',
  },
};

export const TECH_BRANCHES: TechBranch[] = ['agriculture', 'craft', 'warfare'];
