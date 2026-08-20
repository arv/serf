import { BUILDING_DEFS, type BuildingTypeId } from '../sim/defs/buildings';
import type { GoodAmounts, GoodId } from '../sim/defs/goods';
import type { TechId } from '../sim/defs/techs';

/**
 * The build ribbon's tabs, in the order they are shown.
 *
 * Its own module rather than a const inside Hud.tsx so the completeness
 * rule below can be tested without standing up a DOM: this list going stale
 * is silent — a building the sim will happily place that no button offers
 * is simply a building the player never discovers. The whole food chain
 * shipped that way and nobody noticed until someone went looking for the
 * mill.
 *
 * Food earns a tab of its own now that feeding an army is four buildings
 * and a well rather than one field. The well comes with them: water is an
 * input to the farm, the bakery and the brewery and to nothing else, so the
 * player building the chain finds it where the chain is.
 */
export const BUILD_GROUPS: { label: string; types: BuildingTypeId[] }[] = [
  { label: 'Village', types: ['house', 'woodcutter', 'quarry', 'abbey'] },
  { label: 'Food', types: ['well', 'wheatFarm', 'mill', 'bakery', 'fishery'] },
  {
    label: 'Industry',
    types: ['brewery', 'ironMine', 'silverMine', 'goldMine', 'weaponsmith'],
  },
  { label: 'War', types: ['barracks', 'guardTower'] },
];

/**
 * Can a player place this at all? The same two refusals the sim applies in
 * tick.ts — storage is the elimination token and never buildable, and
 * system-only types are worldgen's or the road pass's to place. Kept beside
 * the menu because the menu is what has to agree with it.
 */
export function playerBuildable(type: BuildingTypeId): boolean {
  const def = BUILDING_DEFS[type];
  return !def.storage && !def.systemOnly;
}

/**
 * The letter that picks each building out of the build chord (B, then this).
 *
 * Every one of them appears in the building's own name, because the HUD
 * teaches them by bolding that very letter in the button — We**l**l,
 * Sil**v**er Mine. So these are not free to reassign: a letter that isn't in
 * the name has nothing to bold and the button quietly falls back to a
 * parenthesised hint, which reads like an afterthought next to fourteen
 * that don't need one.
 *
 * First letters win where they can (H for House, W for Woodcutter) and the
 * collisions go to the next letter that says the thing: Bakery keeps B, so
 * B**r**ewery takes R and Barrac**k**s takes K, and the Guard **T**ower —
 * whose G belongs to the Gold Mine — takes the letter of the thing it is. The test beside this file
 * holds the two rules that matter — one key per building, no key used twice.
 */
export const BUILD_KEYS: Partial<Record<BuildingTypeId, string>> = {
  house: 'H',
  woodcutter: 'W',
  quarry: 'Q',
  abbey: 'A',
  well: 'L',
  wheatFarm: 'F',
  mill: 'M',
  bakery: 'B',
  fishery: 'S',
  brewery: 'R',
  ironMine: 'I',
  silverMine: 'V',
  goldMine: 'G',
  weaponsmith: 'P',
  barracks: 'K',
  guardTower: 'T',
};

/** The letter that arms this building, or '' for one the ribbon never offers. */
export function buildKey(type: BuildingTypeId): string {
  return BUILD_KEYS[type] ?? '';
}

/** The building a letter arms during a build chord, or null for a stray key. */
export function buildingForKey(letter: string): BuildingTypeId | null {
  const want = letter.toUpperCase();
  for (const [type, key] of Object.entries(BUILD_KEYS) as [BuildingTypeId, string][]) {
    if (key === want) return type;
  }
  return null;
}

/**
 * The two gates the ribbon puts on a building, as plain functions of the
 * state they read rather than closures over the store.
 *
 * They live here because the keyboard has to apply exactly what the buttons
 * apply. A chord that armed a building the button next to it shows locked
 * and greyed is not a shortcut, it is a second, more permissive build menu —
 * and the sim would refuse the placement anyway, several clicks later.
 */
export function buildUnlocked(type: BuildingTypeId, researched: readonly TechId[]): boolean {
  const req = BUILDING_DEFS[type].requiresTech;
  if (req === undefined) return true;
  return Array.isArray(req) ? req.some((t) => researched.includes(t)) : researched.includes(req);
}

export function buildAffordable(type: BuildingTypeId, stock: GoodAmounts): boolean {
  const cost = Object.entries(BUILDING_DEFS[type].cost) as [GoodId, number][];
  return cost.every(([good, n]) => (stock[good] ?? 0) >= n);
}
