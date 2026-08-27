import type { BuildingTypeId } from './buildings.ts';
import type { GoodAmounts, GoodId } from './goods.ts';
import type { TechId } from './techs.ts';
import type { AiStrategyId } from './aiStrategies.ts';

/**
 * The campaign: seven commissions that double as the tutorial. Each mission is
 * an authored map plus a recipe of overrides — start-stock and raid-clock
 * overrides, a few pre-built buildings — and a checklist of objectives the
 * sim itself judges (systems/objectives.ts, victory.ts).
 *
 * The maps are checked-in serf-map files (defs/maps/<id>.json) — hard
 * ground, not a worldgen roll: tweak a mission by editing its JSON or by
 * round-tripping it through the map editor, and roll a fresh one from a
 * seed with tools/exportMissionMap.ts. Each was born as the exact world
 * its old pinned seed generated, so the per-mission seed comments below
 * are provenance — the story of the roll the file froze. The files are NOT
 * imported here — they're half a megabyte each, and this table rides in
 * every bundle that touches the sim: missionMaps.ts holds the code-split
 * doorway, and createWorldAsync fetches a map only when its mission boots.
 *
 * Pure data, like the AI playbooks next door: the sim resolves a mission by
 * id on whichever host owns the world, so two hosts reading the same table
 * must see the same mission. Hints are NOT here — they speak presentation
 * language (which panel is open, what the cursor holds) and live with the
 * UI in src/ui/hints.ts. The sim knows whether you have won; only the UI
 * knows how to help you.
 */

export type MissionId =
  | 'clearing'
  | 'breadAndWater'
  | 'ledger'
  | 'hammerAndHaft'
  | 'levy'
  | 'holdTheValley'
  | 'rivalBanner';

/**
 * One win requirement. Every spec is a stateless predicate over the world —
 * a count, a stock level, a tech in the list, a camp razed. No counters and
 * no accumulators, so the only mission state the save carries is the latch
 * bits (World.objectivesDone).
 */
export type ObjectiveSpec =
  | { kind: 'building'; type: BuildingTypeId; count: number }
  | { kind: 'stock'; good: GoodId; amount: number }
  | { kind: 'research'; tech: TechId }
  | { kind: 'population'; count: number }
  | { kind: 'soldiers'; count: number }
  | { kind: 'razeCamp' };

/** A building already standing when the mission opens, looked for at
 * castle-origin + offset and spiralled outward from there until the ordinary
 * placement rules accept it (see placePrebuilt in world.ts). */
export interface PrebuiltSpec {
  type: BuildingTypeId;
  dx: number;
  dy: number;
}

export interface MissionDef {
  id: MissionId;
  title: string;
  /** The commission, read from the briefing card. */
  briefing: string;
  /** One line for the mission-select list. */
  tagline: string;
  /** No longer the ground (that's the mission's map file): the seed deals
   * unnamed AI seats their playbooks and starts the world's own rng —
   * raid waves, and the corner search a mission without a campSpot falls
   * back on. The authored ground itself lives at defs/maps/<id>.json,
   * loaded on demand through missionMaps.ts — the file owns the terrain,
   * resources, heights, grid size, and start positions. */
  seed: number;
  players: { kind: 'human' | 'ai'; strategy?: AiStrategyId }[];
  bandits: boolean;
  /** Bandit camp footprint origin (3×3), tried first — pinned so a map
   * tweak can't silently move the enemy the balance was proven against.
   * The classic seed-driven corner search stays behind it as the repair
   * for a tweak that blocked the spot. Bandit missions only. */
  campSpot?: { x: number; y: number };
  /** Overrides FIRST_RAID_TICK (bandit missions only). */
  firstRaidTick?: number;
  /** Overrides START_SERFS for the human seat. */
  startSerfs?: number;
  /** Overrides START_STOCK for the human seat. */
  startStock?: GoodAmounts;
  /** Granted to the human seat as already-researched. */
  startTechs?: TechId[];
  prebuilt?: PrebuiltSpec[];
  /** All must hold at once been-met (they latch) for the win. Empty list =
   * no checklist; the ordinary elimination rules decide the match. */
  objectives: { spec: ObjectiveSpec; label: string }[];
}

export const MISSION_DEFS: Record<MissionId, MissionDef> = {
  clearing: {
    id: 'clearing',
    title: 'The Clearing',
    briefing:
      'The crown grants you a valley and six hands. Wood for the axe, ' +
      'stone for the hearth, beds for the hands you hire — put a roof ' +
      'over them, reeve, and lay in timber for what comes next.',
    tagline: 'Raise a camp: wood, stone, and beds.',
    // Re-pinned (101 -> 104 -> 110 -> 106) as border and grid passes
    // re-rolled the worlds: the taught line must finish comfortably, and
    // this roll wins it by tick ~4.3k of the 36k budget.
    seed: 106,
    players: [{ kind: 'human' }],
    bandits: false,
    startSerfs: 6,
    // Below the default 36 wood / 8 serfs on purpose: the wood loop and the
    // hire button must be needed, not optional. With no raids the 8-serf
    // balance floor doesn't apply.
    // Tools for the two posts this mission teaches, and hammers for its
    // sites — the tool economy itself is mission 4's lesson, not this one's.
    startStock: { wood: 20, stone: 6, silver: 24, axe: 1, pickaxe: 1, hammer: 2 },
    objectives: [
      { spec: { kind: 'building', type: 'woodcutter', count: 1 }, label: 'Raise a Woodcutter' },
      { spec: { kind: 'building', type: 'quarry', count: 1 }, label: 'Raise a Quarry' },
      { spec: { kind: 'building', type: 'house', count: 1 }, label: 'Raise a House' },
      // Eleven, one past the castle's ten beds: the house objective is
      // load-bearing (population is beds), not a checkbox. Five hires at
      // 4 silver each out of the 24 the mission opens with.
      { spec: { kind: 'population', count: 11 }, label: 'Grow the village to 11' },
      { spec: { kind: 'stock', good: 'wood', amount: 30 }, label: 'Lay in 30 wood at the Castle' },
    ],
  },

  breadAndWater: {
    id: 'breadAndWater',
    title: 'Bread and Water',
    briefing:
      'An army marches on its stomach, and yours does not exist yet. The ' +
      'crown sends you upriver to learn the other half of husbandry: ' +
      'water and wheat, mill and oven. Learn to bake, reeve.',
    tagline: 'Stand up the food chain and fill the larder.',
    seed: 202,
    players: [{ kind: 'human' }],
    bandits: false,
    startStock: {
      wood: 40,
      stone: 12,
      silver: 12,
      axe: 1,
      pickaxe: 1,
      scythe: 1,
      cauldron: 1,
      hammer: 2,
    },
    objectives: [
      { spec: { kind: 'building', type: 'well', count: 1 }, label: 'Raise a Well' },
      { spec: { kind: 'building', type: 'wheatFarm', count: 1 }, label: 'Raise a Wheat Farm' },
      { spec: { kind: 'building', type: 'mill', count: 1 }, label: 'Raise a Mill' },
      { spec: { kind: 'building', type: 'bakery', count: 1 }, label: 'Raise a Bakery' },
      { spec: { kind: 'stock', good: 'food', amount: 12 }, label: 'Lay in 12 food at the Castle' },
    ],
  },

  ledger: {
    id: 'ledger',
    title: "The Abbey's Ledger",
    briefing:
      'Learning costs silver, and silver comes out of a hill. The abbot ' +
      'will sell you his letters; the hill will sell you nothing — start ' +
      'digging. The crown expects spears it did not pay the smiths for.',
    tagline: 'Silver, scholarship, iron, and a working forge.',
    seed: 303,
    players: [{ kind: 'human' }],
    bandits: false,
    startSerfs: 10,
    // Picks for both taught mines on top of the prebuilt camp's own kit.
    startStock: {
      wood: 50,
      stone: 20,
      wheat: 12,
      silver: 10,
      axe: 1,
      pickaxe: 3,
      scythe: 1,
      hammer: 3,
    },
    // The player should not re-play missions 1-2: the camp they taught is
    // already standing.
    prebuilt: [
      { type: 'woodcutter', dx: -6, dy: -2 },
      { type: 'quarry', dx: 6, dy: -3 },
      { type: 'house', dx: -5, dy: 4 },
      { type: 'well', dx: 5, dy: 4 },
      { type: 'wheatFarm', dx: 8, dy: 2 },
    ],
    objectives: [
      { spec: { kind: 'building', type: 'abbey', count: 1 }, label: 'Raise an Abbey' },
      { spec: { kind: 'building', type: 'silverMine', count: 1 }, label: 'Dig a Silver Mine' },
      // Forces Cobbled Boots first — the tree's prereq line teaches itself.
      { spec: { kind: 'research', tech: 'ironworking' }, label: 'Research Ironworking' },
      { spec: { kind: 'building', type: 'ironMine', count: 1 }, label: 'Dig an Iron Mine' },
      { spec: { kind: 'building', type: 'weaponsmith', count: 1 }, label: 'Raise a Weaponsmith' },
      { spec: { kind: 'stock', good: 'spear', amount: 4 }, label: 'Forge 4 spears' },
    ],
  },

  hammerAndHaft: {
    id: 'hammerAndHaft',
    title: 'Hammer and Haft',
    briefing:
      'The last reeve’s people left in the night and took every axe and ' +
      'pick with them. The huts still stand — woodcutter, quarry, field, ' +
      'oven, and a mine cut into the eastern hill — and not one of them ' +
      'will draw a soul until there is a tool on its peg. Raise a Smith and ' +
      'put the valley back to work. You have one hammer of your own; mind ' +
      'who you lend it to.',
    tagline: 'Bare racks: forge the tools the valley works with.',
    // A quiet valley with its ore a short walk east (nearest seam ~14
    // tiles off the keep) and both timber and rock inside the opening
    // sight — the shape this mission needs, since every post the player
    // is tooling up is already standing on that ground.
    seed: 350,
    players: [{ kind: 'human' }],
    bandits: false,
    // A village this size is six posts and the haulage between them.
    startSerfs: 12,
    // The bare rack, and the whole puzzle: no axe, no pickaxe, no scythe,
    // no cauldron, and exactly one hammer — the reeve's own. That hammer
    // is what raises the Smith (a site borrows one and gives it back at
    // topping-out), and the four iron is what the Smith has to work with
    // until the mine is manned. The pickaxe costs no iron on purpose
    // (buildings.ts says why), so the way out of a bare rack is always to
    // forge the pick first and let the hill pay for the rest.
    startStock: { wood: 30, stone: 15, iron: 4, silver: 6, hammer: 1 },
    // Research was mission 3's lesson; the forge recipes it opened are
    // granted here so the tools themselves are the only puzzle.
    startTechs: ['cobbledBoots', 'ironworking'],
    // The predecessor's village, standing and idle. No Smith among them:
    // that is the one roof this mission is about.
    prebuilt: [
      { type: 'woodcutter', dx: -6, dy: -2 },
      { type: 'quarry', dx: 5, dy: -6 },
      { type: 'house', dx: -5, dy: 4 },
      { type: 'well', dx: 4, dy: 4 },
      { type: 'wheatFarm', dx: 8, dy: 3 },
      { type: 'mill', dx: -3, dy: 7 },
      { type: 'bakery', dx: 2, dy: 7 },
      { type: 'ironMine', dx: 12, dy: -3 },
    ],
    // Every line past the first is a post that cannot produce until its
    // tool hangs on the peg: the mine wants a pickaxe, the woodcutter an
    // axe, the field a scythe and the oven a cauldron. The checklist asks
    // for what those posts make rather than for the tools themselves,
    // because a forged tool is hauled to whichever post is calling for it
    // — it reaches the castle shelf only once nothing is waiting on it.
    objectives: [
      { spec: { kind: 'building', type: 'weaponsmith', count: 1 }, label: 'Raise a Smith' },
      { spec: { kind: 'stock', good: 'iron', amount: 12 }, label: 'Lay in 12 iron at the Castle' },
      { spec: { kind: 'stock', good: 'wood', amount: 45 }, label: 'Lay in 45 wood at the Castle' },
      { spec: { kind: 'stock', good: 'food', amount: 12 }, label: 'Lay in 12 food at the Castle' },
      // The one the auto-forge will never do for you: a hammer is wanted
      // by a site, so a village with nothing rising wants none, and the
      // fire goes cold. Three is a batch queued by hand at the forge menu
      // — two of them, since the hammer the mission opens with comes back
      // off the Smith's own site when the roof goes on. Three on the shelf
      // is three sites that can rise at once.
      { spec: { kind: 'stock', good: 'hammer', amount: 3 }, label: 'Lay in 3 hammers at the Castle' },
    ],
  },

  levy: {
    id: 'levy',
    title: 'The Levy',
    briefing:
      'Word from the pass: bandits have made camp in the wilds, and they ' +
      'know the road to your gate better than your levy knows its drill. ' +
      'The crown expects them gone. Raise the barracks, feed your ' +
      'soldiers, and answer for the valley.',
    tagline: 'Face the first raid, then take the camp.',
    // Re-pinned (404 -> 405 -> 406) with the buffer-cap pass: the early
    // raid must be survivable, and 405 stopped being. It was a knife-edge
    // roll, not a broken mission — of seeds 400-430 under the new caps
    // exactly two (403 and 405) lose, and this one is won by tick ~12k.
    seed: 406,
    players: [{ kind: 'human' }],
    bandits: true,
    campSpot: { x: 43, y: 43 },
    // Five minutes — the point of this mission IS the raid, arriving before
    // the player feels ready. (Default is nine.)
    firstRaidTick: 6000,
    startSerfs: 12,
    startStock: {
      wood: 30,
      stone: 15,
      food: 10,
      iron: 6,
      silver: 25,
      spear: 2,
      sword: 1,
      // The standing camp's kit: every prebuilt post staffs itself while
      // the player worries about the raid, not about racks.
      axe: 1,
      pickaxe: 2,
      scythe: 1,
      cauldron: 1,
      hammer: 2,
    },
    // Research was mission 3's lesson; here it is already done.
    startTechs: ['soldiery', 'cobbledBoots', 'ironworking'],
    prebuilt: [
      { type: 'woodcutter', dx: -6, dy: -2 },
      { type: 'quarry', dx: 6, dy: -3 },
      { type: 'house', dx: -5, dy: 4 },
      { type: 'house', dx: -8, dy: 0 },
      { type: 'well', dx: 5, dy: 4 },
      { type: 'wheatFarm', dx: 8, dy: 2 },
      { type: 'mill', dx: -3, dy: 7 },
      { type: 'bakery', dx: 2, dy: 7 },
      { type: 'silverMine', dx: 0, dy: -8 },
      { type: 'abbey', dx: 8, dy: -1 },
    ],
    objectives: [
      { spec: { kind: 'building', type: 'barracks', count: 1 }, label: 'Raise a Barracks' },
      { spec: { kind: 'soldiers', count: 6 }, label: 'Field 6 soldiers at once' },
      { spec: { kind: 'razeCamp' }, label: 'Raze the bandit camp' },
    ],
  },

  holdTheValley: {
    id: 'holdTheValley',
    title: 'Hold the Valley',
    briefing:
      'No more letters from the crown, and no more lessons. The valley is ' +
      'yours to keep — or lose. The bandits will come in waves until their ' +
      'camp is ash; see that your castle outlives it.',
    tagline: 'The full game: no help, no headstart.',
    // The seed winnable.test.ts proves takeable — the one map with a
    // standing guarantee that it can be held.
    seed: 17,
    players: [{ kind: 'human' }],
    bandits: true,
    campSpot: { x: 106, y: 106 },
    objectives: [
      { spec: { kind: 'razeCamp' }, label: 'Raze the bandit camp' },
    ],
  },

  rivalBanner: {
    id: 'rivalBanner',
    title: 'The Rival Banner',
    briefing:
      'A rival reeve claims the far end of the valley — two banners, one ' +
      'charter, and the crown does not care which of you it honors. The ' +
      'bandits in the middle care even less. Last banner standing.',
    tagline: 'Bonus: your first rival. Last banner standing.',
    // Re-pinned (606 -> 609 -> ... -> 11 -> 12) after the buffer-cap pass.
    // The rule each time is the same: the war has to end inside what the
    // elimination test can afford under a loaded suite. 11's stopped
    // ending at all — still playing at 120k — while 12 settles at ~10.7k,
    // which is where most of this neighbourhood lands.
    seed: 12,
    players: [{ kind: 'human' }, { kind: 'ai', strategy: 'steward' }],
    bandits: true,
    campSpot: { x: 76, y: 73 },
    // No checklist: the ordinary last-faction-standing rules decide it.
    objectives: [],
  },
};

/** Campaign order; mission k unlocks when k-1 is complete (UI-enforced). */
export const MISSION_ORDER: MissionId[] = [
  'clearing',
  'breadAndWater',
  'ledger',
  'hammerAndHaft',
  'levy',
  'holdTheValley',
  'rivalBanner',
];

/** The mission after this one, for the end card's Continue button. */
export function nextMissionId(id: MissionId): MissionId | undefined {
  return MISSION_ORDER[MISSION_ORDER.indexOf(id) + 1];
}

/**
 * One mission id, or undefined. The gate for anything a player can write —
 * a URL is hand-editable and must not name a mission that does not exist.
 * `Object.hasOwn`, because MISSION_DEFS['constructor'] is truthy through
 * the prototype (same rule as parseStrategyId).
 */
export function parseMissionId(raw: unknown): MissionId | undefined {
  if (typeof raw !== 'string' || !Object.hasOwn(MISSION_DEFS, raw)) return undefined;
  return raw as MissionId;
}
