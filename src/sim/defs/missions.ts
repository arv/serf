import type { BuildingTypeId } from './buildings.ts';
import type { GoodAmounts, GoodId } from './goods.ts';
import type { TechId } from './techs.ts';
import type { AiStrategyId } from './aiStrategies.ts';

/**
 * The campaign: six commissions that double as the tutorial. Each mission is
 * a recipe over the ordinary worldgen — a pinned seed, start-stock and
 * raid-clock overrides, a few pre-built buildings — plus a checklist of
 * objectives the sim itself judges (systems/objectives.ts, victory.ts).
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
  seed: number;
  players: { kind: 'human' | 'ai'; strategy?: AiStrategyId }[];
  bandits: boolean;
  /** Pin a grid size for this mission's world; absent = the game default.
   * A mission whose tuning depends on its exact world can hold it here
   * while the default marches on. */
  mapSize?: number;
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
    // Re-pinned (101 -> 104 -> 110) as border passes re-rolled the
    // worlds: the taught line must finish comfortably, and this roll wins
    // it by tick ~3.6k of the 36k budget.
    seed: 110,
    players: [{ kind: 'human' }],
    bandits: false,
    startSerfs: 6,
    // Below the default 36 wood / 8 serfs on purpose: the wood loop and the
    // hire button must be needed, not optional. With no raids the 8-serf
    // balance floor doesn't apply.
    startStock: { wood: 20, stone: 6, silver: 24 },
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
    startStock: { wood: 40, stone: 12, silver: 12 },
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
    startStock: { wood: 50, stone: 20, wheat: 12, silver: 10 },
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

  levy: {
    id: 'levy',
    title: 'The Levy',
    briefing:
      'Word from the pass: bandits have made camp in the wilds, and they ' +
      'know the road to your gate better than your levy knows its drill. ' +
      'The crown expects them gone. Raise the barracks, feed your ' +
      'soldiers, and answer for the valley.',
    tagline: 'Face the first raid, then take the camp.',
    // Re-pinned (404 -> 405) with the border waterline: the early raid
    // must be survivable, and this roll is won by tick ~6.6k.
    seed: 405,
    players: [{ kind: 'human' }],
    bandits: true,
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
    seed: 23,
    players: [{ kind: 'human' }],
    bandits: true,
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
    // Re-pinned (606 -> 609) after the A*-cap rebalance: 606's war still
    // ended, but only at ~30k ticks — three times this roll's ~9.6k, and
    // past what the elimination test can afford under a loaded suite.
    seed: 609,
    players: [{ kind: 'human' }, { kind: 'ai', strategy: 'steward' }],
    bandits: true,
    // No checklist: the ordinary last-faction-standing rules decide it.
    objectives: [],
  },
};

/** Campaign order; mission k unlocks when k-1 is complete (UI-enforced). */
export const MISSION_ORDER: MissionId[] = [
  'clearing',
  'breadAndWater',
  'ledger',
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
