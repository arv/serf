import type { Enum } from '../../shared/enum.ts';
import * as GoodIdNs from './goodIdEnum.ts';

export type GoodId = Enum<typeof GoodIdNs>;

const G = GoodIdNs;

/**
 * Every good, in id order — the iteration order the sim reads shelves in,
 * and the order a GoodAmounts enumerates (integer keys enumerate ascending,
 * so the two cannot drift).
 */
export const GOODS: readonly GoodId[] = [
  G.water,
  G.wheat,
  G.wood,
  G.stone,
  G.iron,
  G.silver,
  G.gold,
  G.sword,
  G.spear,
  G.bow,
  G.ale,
  G.flour,
  G.food,
  G.axe,
  G.pickaxe,
  G.scythe,
  G.hammer,
  G.cauldron,
  G.rod,
];

/**
 * The spelling of each id, for the boundaries that still speak in words: a
 * save file, a docs anchor, the summary the strategist model is shown. The
 * sim itself never reads these — inside the tick a good is its number.
 */
export const GOOD_KEYS: Readonly<Record<GoodId, string>> = {
  [G.water]: 'water',
  [G.wheat]: 'wheat',
  [G.wood]: 'wood',
  [G.stone]: 'stone',
  [G.iron]: 'iron',
  [G.silver]: 'silver',
  [G.gold]: 'gold',
  [G.sword]: 'sword',
  [G.spear]: 'spear',
  [G.bow]: 'bow',
  [G.ale]: 'ale',
  [G.flour]: 'flour',
  [G.food]: 'food',
  [G.axe]: 'axe',
  [G.pickaxe]: 'pickaxe',
  [G.scythe]: 'scythe',
  [G.hammer]: 'hammer',
  [G.cauldron]: 'cauldron',
  [G.rod]: 'rod',
};

const GOOD_BY_KEY = new Map<string, GoodId>(GOODS.map((g) => [GOOD_KEYS[g], g]));

/** The id a spelling names, or undefined — the read side of GOOD_KEYS. */
export function goodFromKey(key: string): GoodId | undefined {
  return GOOD_BY_KEY.get(key);
}

export type GoodAmounts = Partial<Record<GoodId, number>>;

/**
 * The goods a shelf actually holds, in id order.
 *
 * `Object.keys` cannot be used directly any more and the difference is not
 * cosmetic: it hands back the ids spelled as strings ('3', not 3), which
 * still index the record and never again equal a member. Everything that
 * walks a GoodAmounts goes through here or through goodEntries.
 */
export function goodKeys(amounts: GoodAmounts): GoodId[] {
  const out: GoodId[] = [];
  for (const good of GOODS) if (amounts[good] !== undefined) out.push(good);
  return out;
}

/** The shelf as id/amount pairs, in id order. */
export function goodEntries(amounts: GoodAmounts): [GoodId, number][] {
  const out: [GoodId, number][] = [];
  for (const good of GOODS) {
    const n = amounts[good];
    if (n !== undefined) out.push([good, n]);
  }
  return out;
}
