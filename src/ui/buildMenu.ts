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
 * Three tabs, and three is the count the frame asks for. The grid is a
 * declared three columns by two rows (Hud.tsx), so six is the most a tab
 * can hold before a button hides below a scroll line — and sixteen
 * buildings across three tabs is 5/6/5, nothing hidden and no tab that is
 * half an empty card. Four could not have both: War stood at two buttons
 * in a six-slot frame while the player hunted for the Smith that armed it.
 *
 * What each tab holds is one sentence — what the village is built from and
 * paid for with, what it eats and drinks, what it fights with. The sort is by what the output buys, which is the question the
 * player is actually asking, and not by what a building looks like: that is
 * what once put the Brewery under Industry beside three mines, on the
 * strength of it being a stone shed with a worker in it.
 *
 * The three mines are the test of that rule, because they are the same
 * building three times over — same flag, same worker, same hillside — and
 * the rule splits them anyway. Iron is the only ore a workshop ever sees,
 * so it goes to the forge. Gold has exactly one sink in the whole sim,
 * Gilded Arms, and that is a warfare tech that armours soldiers, so it goes
 * where the soldiers are. Silver is the universal coin — all fourteen techs
 * cost it, across all three branches, and so does a hired serf
 * (HIRE_SERF_COST) — so it stands with the Abbey and the castle that spend
 * it. Three identical buildings, three different tabs, because the question
 * is what comes out and not what it looks like.
 *
 * The forge goes where its output is spent, which moves the Smith out of
 * Village, where it sat for being ungated and the source of every tool —
 * true, and still not a reason to look for a forge under housing. The chord
 * (B, then S) reaches it from any tab regardless.
 *
 * The Brewery is the one building placed by what goes in rather than what
 * comes out, and it earns the exception. Ale is brewed from the Food tab's
 * own wheat and water, and it bids for the very wheat the mill wants: bread
 * or beer is a single decision about a single field, and a player taking it
 * should have both halves under one hand. Sorting it by its sinks instead
 * sends it to the Abbey, and sends the only chain in the ribbon across a
 * tab boundary for the privilege.
 *
 * The tab is named Food and ale is not food — `food` is a good, and the
 * Brewery cannot make it. Read the label as the larder rather than the
 * good: what the village eats and drinks, which is what this tab has held
 * from the first cut. The alternative is renaming the tab to something no
 * good is called, and Larder was tried; a name nobody arrives knowing is a
 * worse tax than a name that is a shade broader than its cargo.
 *
 * Each tab is filled in chain order, and the rows are three wide, so a
 * chain reads left to right the way it runs: well, farm, mill along the
 * first row of Food and the bakery under them; ore, forge, barracks along
 * the top of Arms. Following a chain never costs a click, because no chain
 * crosses a tab.
 */
/**
 * The tab names, as a union rather than bare strings: the field guide owes
 * each group a sentence (GROUP_DESC in the docs' descriptions.ts, a total
 * Record over this type), so renaming a tab or adding one stops compiling
 * until the guide has been told what the new group is for.
 */
export type BuildGroupLabel = 'Village' | 'Food' | 'Arms';

export const BUILD_GROUPS: { label: BuildGroupLabel; types: BuildingTypeId[] }[] = [
  // Top row the three you raise without thinking; under them the Abbey and
  // the coin that pays for what it researches.
  { label: 'Village', types: ['house', 'woodcutter', 'quarry', 'abbey', 'silverMine'] },
  // The well leads: water is an input to the farm, the bakery and the
  // brewery and to nothing else, so the player building the chain finds it
  // at the head of the chain. Bread's four along the top and round the
  // corner, then the two that stand apart from it: the shore, which needs
  // no chain at all, and the brewery, which bids against the mill for the
  // same wheat. Fish or bake, bread or beer — both decisions sit inside
  // this one tab, which is the whole of why it is grouped this way.
  { label: 'Food', types: ['well', 'wheatFarm', 'mill', 'bakery', 'fishery', 'brewery'] },
  // Ore, forge, army along the top, in that order and in that direction.
  // Under them the two that come later: the wall raised when the raids
  // start, and the gilding affordable once the army already stands.
  { label: 'Arms', types: ['ironMine', 'weaponsmith', 'barracks', 'guardTower', 'goldMine'] },
];

/**
 * Which tab holds this building — the index into BUILD_GROUPS, or -1 for a
 * type the ribbon never offers.
 *
 * The HUD asks whenever the keyboard names a building, so that the tab
 * comes along with the chord; here rather than inline in Hud.tsx so the
 * answer can be checked against BUILD_GROUPS without standing up a DOM,
 * which is the same reason the groups themselves live in this file.
 */
export function buildTab(type: BuildingTypeId): number {
  return BUILD_GROUPS.findIndex((g) => g.types.includes(type));
}

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
 * whose G belongs to the Gold Mine — takes the letter of the thing it is.
 * The Smith's rename spent every letter of its short name; the Fish**e**ry
 * yielded S and fell back to its E. The test beside this file
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
  fishery: 'E',
  brewery: 'R',
  ironMine: 'I',
  silverMine: 'V',
  goldMine: 'G',
  weaponsmith: 'S',
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
