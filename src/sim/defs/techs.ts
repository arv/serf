import type {Enum} from '../../shared/enum.ts';
import type {GoodAmounts} from './goods.ts';
import * as TechIdNs from './techIdEnum.ts';

export type TechId = Enum<typeof TechIdNs>;
import * as ModifierKeyNs from './modifierKeyEnum.ts';
export type ModifierKey = Enum<typeof ModifierKeyNs>;
import * as TechBranchNs from './techBranchEnum.ts';
export type TechBranch = Enum<typeof TechBranchNs>;
import * as BuildingTypeId from './buildingTypeIdEnum.ts';
import * as GoodId from './goodIdEnum.ts';
import * as TechEffectKindNs from './techEffectKindEnum.ts';
import * as UnitTypeId from './unitTypeIdEnum.ts';

type BuildingTypeId = Enum<typeof BuildingTypeId>;
type UnitTypeId = Enum<typeof UnitTypeId>;
export type TechEffectKind = Enum<typeof TechEffectKindNs>;

const T = TechIdNs;

/**
 * The tech tree: three short branches researched at the Abbey for goods +
 * time. Effects are typed and read on demand — `unlock*` gates checks,
 * `modifier` multipliers are combined by getModifier(), so adding a tech is
 * pure data.
 */

export type TechEffect =
  | {kind: TechEffectKindNs.unlockBuilding; building: BuildingTypeId}
  | {kind: TechEffectKindNs.unlockUnit; unit: UnitTypeId}
  | {kind: TechEffectKindNs.modifier; key: ModifierKey; multiplier: number}
  | {kind: TechEffectKindNs.unlockPaving};

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
  [T.irrigation]: {
    id: T.irrigation,
    name: 'Irrigation',
    branch: TechBranchNs.agriculture,
    prereqs: [],
    cost: {[GoodId.wheat]: 5, [GoodId.silver]: 3},
    durationTicks: 25 * S,
    effects: [
      {
        kind: TechEffectKindNs.modifier,
        key: ModifierKeyNs.farmSpeed,
        multiplier: 1.3,
      },
    ],
    desc: 'Field channels: farms grow wheat 30% faster.',
  },
  [T.millstones]: {
    id: T.millstones,
    name: 'Millstones',
    branch: TechBranchNs.agriculture,
    prereqs: [T.irrigation],
    // Stone for the stones: the one agriculture tech the quarry pays for.
    cost: {[GoodId.stone]: 6, [GoodId.silver]: 5},
    durationTicks: 30 * S,
    // The chain's designed bottleneck is the mill (one mill serves two
    // farms), so this is the lever on bread itself. Deliberately not the
    // fishery: the shore is the poor village's option, and a late-game
    // buff to it would undercut the fish-then-bake fork.
    effects: [
      {
        kind: TechEffectKindNs.modifier,
        key: ModifierKeyNs.foodSpeed,
        multiplier: 1.3,
      },
    ],
    desc: 'Dressed millstones: the mill and the bakery work 30% faster.',
  },
  [T.brewing]: {
    id: T.brewing,
    name: 'Brewing',
    branch: TechBranchNs.agriculture,
    prereqs: [T.irrigation],
    cost: {[GoodId.wheat]: 8, [GoodId.silver]: 4},
    durationTicks: 30 * S,
    effects: [
      {kind: TechEffectKindNs.unlockBuilding, building: BuildingTypeId.brewery},
    ],
    desc: 'Unlocks the Brewery.',
  },
  [T.festivals]: {
    id: T.festivals,
    name: 'Festivals',
    branch: TechBranchNs.agriculture,
    prereqs: [T.brewing],
    cost: {[GoodId.ale]: 2, [GoodId.silver]: 6},
    durationTicks: 30 * S,
    effects: [], // enables the abbey's ale-fed festival buff
    desc: 'Ale delivered to the Abbey holds festivals: everyone works 25% faster for a while.',
  },
  [T.aleRations]: {
    id: T.aleRations,
    name: 'Ale Rations',
    branch: TechBranchNs.agriculture,
    prereqs: [T.festivals],
    // Paying the unlock in ale means the brewery is already employed
    // before the effect ever lands.
    cost: {[GoodId.ale]: 4, [GoodId.silver]: 6},
    durationTicks: 30 * S,
    // Like festivals, a mechanic rather than a modifier: the barracks
    // stocks ale, and each soldier drinks one at training start for a
    // faster course (staffing.ts). No ale never blocks training — the
    // drink is an accelerant, not an ingredient.
    effects: [],
    desc: 'The barracks keeps a cask: each soldier drinks 1 ale and trains 25% faster.',
  },

  // — Craft —
  [T.cobbledBoots]: {
    id: T.cobbledBoots,
    name: 'Cobbled Boots',
    branch: TechBranchNs.craft,
    prereqs: [],
    cost: {[GoodId.wheat]: 4, [GoodId.silver]: 2},
    durationTicks: 20 * S,
    effects: [
      {
        kind: TechEffectKindNs.modifier,
        key: ModifierKeyNs.serfSpeed,
        multiplier: 1.15,
      },
    ],
    desc: 'Serfs and workers walk 15% faster.',
  },
  [T.ironworking]: {
    id: T.ironworking,
    name: 'Ironworking',
    branch: TechBranchNs.craft,
    // A root of the craft branch since the Smith went civilian: every
    // iron tool the village staffs itself with waits on this, so it
    // cannot sit behind boots the way it did when only the army cared.
    // Cheaper and quicker for the same reason.
    prereqs: [],
    cost: {[GoodId.stone]: 4, [GoodId.silver]: 5},
    durationTicks: 30 * S,
    // The Smith itself is ungated (the village's only tool source must be
    // reachable from a standing start) — this opens the ore and the iron
    // recipes on its menu.
    effects: [
      {
        kind: TechEffectKindNs.unlockBuilding,
        building: BuildingTypeId.ironMine,
      },
    ],
    desc: 'Unlocks the Iron Mine, and ironwork at the Smith: weapons and tools.',
  },
  [T.deepMining]: {
    id: T.deepMining,
    name: 'Deep Mining',
    branch: TechBranchNs.craft,
    prereqs: [T.ironworking],
    cost: {[GoodId.iron]: 4, [GoodId.silver]: 8},
    durationTicks: 35 * S,
    effects: [
      {
        kind: TechEffectKindNs.modifier,
        key: ModifierKeyNs.mineSpeed,
        multiplier: 1.3,
      },
      {
        kind: TechEffectKindNs.unlockBuilding,
        building: BuildingTypeId.goldMine,
      },
    ],
    desc: 'Mines work 30% faster; unlocks the Gold Mine.',
  },
  [T.bellows]: {
    id: T.bellows,
    name: 'Bellows',
    branch: TechBranchNs.craft,
    prereqs: [T.ironworking],
    cost: {[GoodId.iron]: 3, [GoodId.silver]: 6},
    durationTicks: 30 * S,
    // Deep Mining's rival for the post-ironworking slot: faster ore or
    // faster weapons out of the same forge. One roof, one bellows — the
    // buff covers every recipe the smith runs, bowstaves included.
    effects: [
      {
        kind: TechEffectKindNs.modifier,
        key: ModifierKeyNs.forgeSpeed,
        multiplier: 1.3,
      },
    ],
    desc: 'Forced draft at the forge: the Smith works 30% faster.',
  },
  [T.masonry]: {
    id: T.masonry,
    name: 'Masonry',
    branch: TechBranchNs.craft,
    prereqs: [T.cobbledBoots],
    cost: {[GoodId.stone]: 8, [GoodId.silver]: 4},
    durationTicks: 30 * S,
    effects: [{kind: TechEffectKindNs.unlockPaving}],
    desc: 'Heavily-trodden trails are paved into stone roads (+35% speed, permanent).',
  },

  // — Warfare —
  [T.soldiery]: {
    id: T.soldiery,
    name: 'Soldiery',
    branch: TechBranchNs.warfare,
    prereqs: [],
    cost: {[GoodId.wheat]: 6, [GoodId.silver]: 6},
    durationTicks: 30 * S,
    effects: [
      {
        kind: TechEffectKindNs.unlockBuilding,
        building: BuildingTypeId.barracks,
      },
      {kind: TechEffectKindNs.unlockUnit, unit: UnitTypeId.spearman},
    ],
    desc: 'Unlocks the Barracks and Spearmen.',
  },
  [T.archery]: {
    id: T.archery,
    name: 'Archery',
    branch: TechBranchNs.warfare,
    prereqs: [T.soldiery],
    cost: {[GoodId.wood]: 8, [GoodId.silver]: 6},
    durationTicks: 30 * S,
    effects: [{kind: TechEffectKindNs.unlockUnit, unit: UnitTypeId.archer}],
    desc: 'Unlocks bowmaking at the Smith, and Archers.',
  },
  [T.mailArmor]: {
    id: T.mailArmor,
    name: 'Mail Armor',
    branch: TechBranchNs.warfare,
    prereqs: [T.soldiery],
    cost: {[GoodId.iron]: 4, [GoodId.silver]: 8},
    durationTicks: 35 * S,
    effects: [
      {
        kind: TechEffectKindNs.modifier,
        key: ModifierKeyNs.militaryHp,
        multiplier: 1.25,
      },
    ],
    desc: 'Military units train with 25% more health.',
  },
  [T.gildedArms]: {
    id: T.gildedArms,
    name: 'Gilded Arms',
    branch: TechBranchNs.warfare,
    prereqs: [T.mailArmor],
    cost: {[GoodId.gold]: 4, [GoodId.silver]: 10},
    durationTicks: 40 * S,
    effects: [
      {
        kind: TechEffectKindNs.modifier,
        key: ModifierKeyNs.militaryHp,
        multiplier: 1.2,
      },
    ],
    desc: 'Gilded arms: military units train with a further 20% more health.',
  },
};

export const TECH_BRANCHES: TechBranch[] = [
  TechBranchNs.agriculture,
  TechBranchNs.craft,
  TechBranchNs.warfare,
];

/** Every research, in id order — TECH_DEFS' own enumeration order. */
export const TECH_IDS: readonly TechId[] = [
  T.irrigation,
  T.millstones,
  T.brewing,
  T.festivals,
  T.aleRations,
  T.cobbledBoots,
  T.ironworking,
  T.deepMining,
  T.bellows,
  T.masonry,
  T.soldiery,
  T.archery,
  T.mailArmor,
  T.gildedArms,
];

/** The spelling of each id, for docs anchors and the strategist's prompt. */
export const TECH_KEYS: Readonly<Record<TechId, string>> = {
  [T.irrigation]: 'irrigation',
  [T.millstones]: 'millstones',
  [T.brewing]: 'brewing',
  [T.festivals]: 'festivals',
  [T.aleRations]: 'aleRations',
  [T.cobbledBoots]: 'cobbledBoots',
  [T.ironworking]: 'ironworking',
  [T.deepMining]: 'deepMining',
  [T.bellows]: 'bellows',
  [T.masonry]: 'masonry',
  [T.soldiery]: 'soldiery',
  [T.archery]: 'archery',
  [T.mailArmor]: 'mailArmor',
  [T.gildedArms]: 'gildedArms',
};

const TECH_BY_KEY = new Map<string, TechId>(
  TECH_IDS.map(t => [TECH_KEYS[t], t]),
);

/** The id a spelling names, or undefined — the read side of TECH_KEYS. */
export function techFromKey(key: string): TechId | undefined {
  return TECH_BY_KEY.get(key);
}
