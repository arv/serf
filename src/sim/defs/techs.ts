import type { GoodAmounts } from './goods.ts';
import type { BuildingTypeId } from './buildings.ts';
import { GoodId } from './goods.ts';
import { UnitTypeId } from './units.ts';

/**
 * The tech tree: three short branches researched at the Abbey for goods +
 * time. Effects are typed and read on demand — `unlock*` gates checks,
 * `modifier` multipliers are combined by getModifier(), so adding a tech is
 * pure data.
 */
export type TechId =
  | 'irrigation'
  | 'millstones'
  | 'brewing'
  | 'festivals'
  | 'aleRations'
  | 'cobbledBoots'
  | 'ironworking'
  | 'deepMining'
  | 'bellows'
  | 'masonry'
  | 'soldiery'
  | 'archery'
  | 'mailArmor'
  | 'gildedArms';

export type ModifierKey =
  | 'farmSpeed' // wheat farm batch speed
  | 'foodSpeed' // mill + bakery batch speed
  | 'forgeSpeed' // Smith batch speed
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
    cost: { [GoodId.wheat]: 5, [GoodId.silver]: 3 },
    durationTicks: 25 * S,
    effects: [{ kind: 'modifier', key: 'farmSpeed', multiplier: 1.3 }],
    desc: 'Field channels: farms grow wheat 30% faster.',
  },
  millstones: {
    id: 'millstones',
    name: 'Millstones',
    branch: 'agriculture',
    prereqs: ['irrigation'],
    // Stone for the stones: the one agriculture tech the quarry pays for.
    cost: { [GoodId.stone]: 6, [GoodId.silver]: 5 },
    durationTicks: 30 * S,
    // The chain's designed bottleneck is the mill (one mill serves two
    // farms), so this is the lever on bread itself. Deliberately not the
    // fishery: the shore is the poor village's option, and a late-game
    // buff to it would undercut the fish-then-bake fork.
    effects: [{ kind: 'modifier', key: 'foodSpeed', multiplier: 1.3 }],
    desc: 'Dressed millstones: the mill and the bakery work 30% faster.',
  },
  brewing: {
    id: 'brewing',
    name: 'Brewing',
    branch: 'agriculture',
    prereqs: ['irrigation'],
    cost: { [GoodId.wheat]: 8, [GoodId.silver]: 4 },
    durationTicks: 30 * S,
    effects: [{ kind: 'unlockBuilding', building: 'brewery' }],
    desc: 'Unlocks the Brewery.',
  },
  festivals: {
    id: 'festivals',
    name: 'Festivals',
    branch: 'agriculture',
    prereqs: ['brewing'],
    cost: { [GoodId.ale]: 2, [GoodId.silver]: 6 },
    durationTicks: 30 * S,
    effects: [], // enables the abbey's ale-fed festival buff
    desc: 'Ale delivered to the Abbey holds festivals: everyone works 25% faster for a while.',
  },
  aleRations: {
    id: 'aleRations',
    name: 'Ale Rations',
    branch: 'agriculture',
    prereqs: ['festivals'],
    // Paying the unlock in ale means the brewery is already employed
    // before the effect ever lands.
    cost: { [GoodId.ale]: 4, [GoodId.silver]: 6 },
    durationTicks: 30 * S,
    // Like festivals, a mechanic rather than a modifier: the barracks
    // stocks ale, and each soldier drinks one at training start for a
    // faster course (staffing.ts). No ale never blocks training — the
    // drink is an accelerant, not an ingredient.
    effects: [],
    desc: 'The barracks keeps a cask: each soldier drinks 1 ale and trains 25% faster.',
  },

  // — Craft —
  cobbledBoots: {
    id: 'cobbledBoots',
    name: 'Cobbled Boots',
    branch: 'craft',
    prereqs: [],
    cost: { [GoodId.wheat]: 4, [GoodId.silver]: 2 },
    durationTicks: 20 * S,
    effects: [{ kind: 'modifier', key: 'serfSpeed', multiplier: 1.15 }],
    desc: 'Serfs and workers walk 15% faster.',
  },
  ironworking: {
    id: 'ironworking',
    name: 'Ironworking',
    branch: 'craft',
    // A root of the craft branch since the Smith went civilian: every
    // iron tool the village staffs itself with waits on this, so it
    // cannot sit behind boots the way it did when only the army cared.
    // Cheaper and quicker for the same reason.
    prereqs: [],
    cost: { [GoodId.stone]: 4, [GoodId.silver]: 5 },
    durationTicks: 30 * S,
    // The Smith itself is ungated (the village's only tool source must be
    // reachable from a standing start) — this opens the ore and the iron
    // recipes on its menu.
    effects: [{ kind: 'unlockBuilding', building: 'ironMine' }],
    desc: 'Unlocks the Iron Mine, and ironwork at the Smith: weapons and tools.',
  },
  deepMining: {
    id: 'deepMining',
    name: 'Deep Mining',
    branch: 'craft',
    prereqs: ['ironworking'],
    cost: { [GoodId.iron]: 4, [GoodId.silver]: 8 },
    durationTicks: 35 * S,
    effects: [
      { kind: 'modifier', key: 'mineSpeed', multiplier: 1.3 },
      { kind: 'unlockBuilding', building: 'goldMine' },
    ],
    desc: 'Mines work 30% faster; unlocks the Gold Mine.',
  },
  bellows: {
    id: 'bellows',
    name: 'Bellows',
    branch: 'craft',
    prereqs: ['ironworking'],
    cost: { [GoodId.iron]: 3, [GoodId.silver]: 6 },
    durationTicks: 30 * S,
    // Deep Mining's rival for the post-ironworking slot: faster ore or
    // faster weapons out of the same forge. One roof, one bellows — the
    // buff covers every recipe the smith runs, bowstaves included.
    effects: [{ kind: 'modifier', key: 'forgeSpeed', multiplier: 1.3 }],
    desc: 'Forced draft at the forge: the Smith works 30% faster.',
  },
  masonry: {
    id: 'masonry',
    name: 'Masonry',
    branch: 'craft',
    prereqs: ['cobbledBoots'],
    cost: { [GoodId.stone]: 8, [GoodId.silver]: 4 },
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
    cost: { [GoodId.wheat]: 6, [GoodId.silver]: 6 },
    durationTicks: 30 * S,
    effects: [
      { kind: 'unlockBuilding', building: 'barracks' },
      { kind: 'unlockUnit', unit: UnitTypeId.spearman },
    ],
    desc: 'Unlocks the Barracks and Spearmen.',
  },
  archery: {
    id: 'archery',
    name: 'Archery',
    branch: 'warfare',
    prereqs: ['soldiery'],
    cost: { [GoodId.wood]: 8, [GoodId.silver]: 6 },
    durationTicks: 30 * S,
    effects: [{ kind: 'unlockUnit', unit: UnitTypeId.archer }],
    desc: 'Unlocks bowmaking at the Smith, and Archers.',
  },
  mailArmor: {
    id: 'mailArmor',
    name: 'Mail Armor',
    branch: 'warfare',
    prereqs: ['soldiery'],
    cost: { [GoodId.iron]: 4, [GoodId.silver]: 8 },
    durationTicks: 35 * S,
    effects: [{ kind: 'modifier', key: 'militaryHp', multiplier: 1.25 }],
    desc: 'Military units train with 25% more health.',
  },
  gildedArms: {
    id: 'gildedArms',
    name: 'Gilded Arms',
    branch: 'warfare',
    prereqs: ['mailArmor'],
    cost: { [GoodId.gold]: 4, [GoodId.silver]: 10 },
    durationTicks: 40 * S,
    effects: [{ kind: 'modifier', key: 'militaryHp', multiplier: 1.2 }],
    desc: 'Gilded arms: military units train with a further 20% more health.',
  },
};

export const TECH_BRANCHES: TechBranch[] = ['agriculture', 'craft', 'warfare'];
