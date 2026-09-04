import type {Enum} from '../../shared/enum.ts';
import type {GoodAmounts} from './goods.ts';
import * as MissionIdNs from './missionIdEnum.ts';

export type MissionId = Enum<typeof MissionIdNs>;
import * as PlayerKind from '../playerKindEnum.ts';
import * as AiStrategyId from './aiStrategyIdEnum.ts';
import * as BuildingTypeId from './buildingTypeIdEnum.ts';
import * as GoodId from './goodIdEnum.ts';
import * as ObjectiveKindNs from './objectiveKindEnum.ts';
import * as TechId from './techIdEnum.ts';

type AiStrategyId = Enum<typeof AiStrategyId>;
type BuildingTypeId = Enum<typeof BuildingTypeId>;
type GoodId = Enum<typeof GoodId>;
type PlayerKind = Enum<typeof PlayerKind>;
type TechId = Enum<typeof TechId>;

export type ObjectiveKind = Enum<typeof ObjectiveKindNs>;

/**
 * The campaign: seven commissions that double as the tutorial. Each mission is
 * an authored map plus a recipe of overrides — start-stock and raid-clock
 * overrides, a few pre-built buildings — and a checklist of objectives the
 * sim itself judges (systems/objectives.ts, victory.ts).
 *
 * The maps are checked-in serf-map files (defs/maps/<id>.json), and they
 * are COMPOSED rather than rolled: each one is a recipe in
 * tools/mapAuthor/missions/, a valley shaped around the lesson its
 * mission teaches — the woods on one side of the town and the stone on
 * the other, the river the bread chain is built along, the one gap the
 * raid walks through. Rebuild them with tools/authorMissionMaps.ts, read
 * them back with tools/mapPreview.ts, and see defs/maps/README.md. The
 * files are NOT imported here — they're a quarter of a megabyte each, and
 * this table rides in every bundle that touches the sim: missionMaps.ts
 * holds the code-split doorway, and createWorldAsync fetches a map only
 * when its mission boots.
 *
 * Pure data, like the AI playbooks next door: the sim resolves a mission by
 * id on whichever host owns the world, so two hosts reading the same table
 * must see the same mission. Hints are NOT here — they speak presentation
 * language (which panel is open, what the cursor holds) and live with the
 * UI in src/ui/hints.ts. The sim knows whether you have won; only the UI
 * knows how to help you.
 */

/**
 * One win requirement. Every spec is a stateless predicate over the world —
 * a count, a stock level, a tech in the list, a camp razed. No counters and
 * no accumulators, so the only mission state the save carries is the latch
 * bits (World.objectivesDone).
 */
export type ObjectiveSpec =
  | {kind: ObjectiveKindNs.building; type: BuildingTypeId; count: number}
  | {kind: ObjectiveKindNs.stock; good: GoodId; amount: number}
  | {kind: ObjectiveKindNs.research; tech: TechId}
  | {kind: ObjectiveKindNs.population; count: number}
  | {kind: ObjectiveKindNs.soldiers; count: number}
  | {kind: ObjectiveKindNs.razeCamp};

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
  /** Not the ground (that's the mission's map file, and these days not
   * even the ghost of it): the seed deals unnamed AI seats their
   * playbooks and starts the world's own rng — raid waves, and the corner
   * search a mission without a campSpot falls back on. The authored
   * ground lives at defs/maps/<id>.json, loaded on demand through
   * missionMaps.ts — the file owns the terrain, resources, heights, grid
   * size, and start positions. */
  seed: number;
  players: {kind: PlayerKind; strategy?: AiStrategyId}[];
  bandits: boolean;
  /** Bandit camp footprint origin (3×3), tried first — pinned so a map
   * tweak can't silently move the enemy the balance was proven against.
   * The classic seed-driven corner search stays behind it as the repair
   * for a tweak that blocked the spot. Bandit missions only. */
  campSpot?: {x: number; y: number};
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
  objectives: {spec: ObjectiveSpec; label: string}[];
}

export const MISSION_DEFS: Record<MissionId, MissionDef> = {
  [MissionIdNs.clearing]: {
    id: MissionIdNs.clearing,
    title: 'The Clearing',
    briefing:
      'The crown grants you a valley and six hands. Wood for the axe, ' +
      'stone for the hearth, beds for the hands you hire — put a roof ' +
      'over them, reeve, and lay in timber for what comes next.',
    tagline: 'Raise a camp: wood, stone, and beds.',
    // Nothing about the valley any more — see `seed` above. The ground is
    // authored (mapAuthor/missions/clearing.ts): a clearing with the
    // treeline west, the stone shoulder east, and the meadow south of the
    // keep left empty for the houses. The taught line wins it inside a
    // fifth of the 36k budget.
    seed: 106,
    players: [{kind: PlayerKind.human}],
    bandits: false,
    startSerfs: 6,
    // Below the default 36 wood / 8 serfs on purpose: the wood loop and the
    // hire button must be needed, not optional. With no raids the 8-serf
    // balance floor doesn't apply.
    // Tools for the two posts this mission teaches, and hammers for its
    // sites — the tool economy itself is mission 4's lesson, not this one's.
    startStock: {
      [GoodId.wood]: 20,
      [GoodId.stone]: 6,
      [GoodId.silver]: 24,
      [GoodId.axe]: 1,
      [GoodId.pickaxe]: 1,
      [GoodId.hammer]: 2,
    },
    objectives: [
      {
        spec: {
          kind: ObjectiveKindNs.building,
          type: BuildingTypeId.woodcutter,
          count: 1,
        },
        label: 'Raise a Woodcutter',
      },
      {
        spec: {
          kind: ObjectiveKindNs.building,
          type: BuildingTypeId.quarry,
          count: 1,
        },
        label: 'Raise a Quarry',
      },
      {
        spec: {
          kind: ObjectiveKindNs.building,
          type: BuildingTypeId.house,
          count: 1,
        },
        label: 'Raise a House',
      },
      // Eleven, one past the castle's ten beds: the house objective is
      // load-bearing (population is beds), not a checkbox. Five hires at
      // 4 silver each out of the 24 the mission opens with.
      {
        spec: {kind: ObjectiveKindNs.population, count: 11},
        label: 'Grow the village to 11',
      },
      {
        spec: {kind: ObjectiveKindNs.stock, good: GoodId.wood, amount: 30},
        label: 'Lay in 30 wood at the Castle',
      },
    ],
  },

  [MissionIdNs.breadAndWater]: {
    id: MissionIdNs.breadAndWater,
    title: 'Bread and Water',
    briefing:
      'An army marches on its stomach, and yours does not exist yet. The ' +
      'crown sends you upriver to learn the other half of husbandry: ' +
      'water and wheat, mill and oven. Learn to bake, reeve.',
    tagline: 'Stand up the food chain and fill the larder.',
    seed: 202,
    players: [{kind: PlayerKind.human}],
    bandits: false,
    startStock: {
      [GoodId.wood]: 40,
      [GoodId.stone]: 12,
      [GoodId.silver]: 12,
      [GoodId.axe]: 1,
      [GoodId.pickaxe]: 1,
      [GoodId.scythe]: 1,
      [GoodId.cauldron]: 1,
      [GoodId.hammer]: 2,
    },
    objectives: [
      {
        spec: {
          kind: ObjectiveKindNs.building,
          type: BuildingTypeId.well,
          count: 1,
        },
        label: 'Raise a Well',
      },
      {
        spec: {
          kind: ObjectiveKindNs.building,
          type: BuildingTypeId.wheatFarm,
          count: 1,
        },
        label: 'Raise a Wheat Farm',
      },
      {
        spec: {
          kind: ObjectiveKindNs.building,
          type: BuildingTypeId.mill,
          count: 1,
        },
        label: 'Raise a Mill',
      },
      {
        spec: {
          kind: ObjectiveKindNs.building,
          type: BuildingTypeId.bakery,
          count: 1,
        },
        label: 'Raise a Bakery',
      },
      {
        spec: {kind: ObjectiveKindNs.stock, good: GoodId.food, amount: 12},
        label: 'Lay in 12 food at the Castle',
      },
    ],
  },

  [MissionIdNs.ledger]: {
    id: MissionIdNs.ledger,
    title: "The Abbey's Ledger",
    briefing:
      'Learning costs silver, and silver comes out of a hill. The abbot ' +
      'will sell you his letters; the hill will sell you nothing — start ' +
      'digging. The crown expects spears it did not pay the smiths for.',
    tagline: 'Silver, scholarship, iron, and a working forge.',
    seed: 303,
    players: [{kind: PlayerKind.human}],
    bandits: false,
    startSerfs: 10,
    // Picks for both taught mines on top of the prebuilt camp's own kit —
    // and a larder to feed them. A mine eats (MINE_RATION_PER), and this
    // commission's prebuilt camp stops at the wheat farm mission 2 ended
    // on, so the crown sends the bread with the picks: enough to see both
    // shafts through the checklist. A reeve who dawdles past it already
    // knows what to do about it — the mill and the oven were the last
    // lesson, and the well and the field are already standing.
    startStock: {
      [GoodId.wood]: 50,
      [GoodId.stone]: 20,
      [GoodId.wheat]: 12,
      [GoodId.food]: 20,
      [GoodId.silver]: 10,
      [GoodId.axe]: 1,
      [GoodId.pickaxe]: 3,
      [GoodId.scythe]: 1,
      [GoodId.hammer]: 3,
    },
    // The player should not re-play missions 1-2: the camp they taught is
    // already standing.
    prebuilt: [
      {type: BuildingTypeId.woodcutter, dx: -6, dy: -2},
      {type: BuildingTypeId.quarry, dx: 6, dy: -3},
      {type: BuildingTypeId.house, dx: -5, dy: 4},
      {type: BuildingTypeId.well, dx: 5, dy: 4},
      {type: BuildingTypeId.wheatFarm, dx: 8, dy: 2},
    ],
    objectives: [
      {
        spec: {
          kind: ObjectiveKindNs.building,
          type: BuildingTypeId.abbey,
          count: 1,
        },
        label: 'Raise an Abbey',
      },
      {
        spec: {
          kind: ObjectiveKindNs.building,
          type: BuildingTypeId.silverMine,
          count: 1,
        },
        label: 'Dig a Silver Mine',
      },
      // Forces Cobbled Boots first — the tree's prereq line teaches itself.
      {
        spec: {kind: ObjectiveKindNs.research, tech: TechId.ironworking},
        label: 'Research Ironworking',
      },
      {
        spec: {
          kind: ObjectiveKindNs.building,
          type: BuildingTypeId.ironMine,
          count: 1,
        },
        label: 'Dig an Iron Mine',
      },
      {
        spec: {
          kind: ObjectiveKindNs.building,
          type: BuildingTypeId.weaponsmith,
          count: 1,
        },
        label: 'Raise a Smith',
      },
      {
        spec: {kind: ObjectiveKindNs.stock, good: GoodId.spear, amount: 4},
        label: 'Forge 4 spears',
      },
    ],
  },

  [MissionIdNs.hammerAndHaft]: {
    id: MissionIdNs.hammerAndHaft,
    title: 'Hammer and Haft',
    briefing:
      'The last reeve’s people left in the night and took every axe and ' +
      'pick with them. The huts still stand — woodcutter, quarry, field, ' +
      'oven, and a mine cut into the eastern hill — and not one of them ' +
      'will draw a soul until there is a tool on its peg. Raise a Smith and ' +
      'put the valley back to work. You have one hammer of your own; mind ' +
      'who you lend it to.',
    tagline: 'Bare racks: forge the tools the valley works with.',
    // The ground is authored (mapAuthor/missions/hammerAndHaft.ts): a
    // closed bowl with the whole abandoned village on its floor, timber
    // and rock inside the opening sight, and the ore a short walk east in
    // the hill the briefing names — the shape this mission needs, since
    // every post the player is tooling up already stands on it.
    seed: 350,
    players: [{kind: PlayerKind.human}],
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
    startStock: {
      [GoodId.wood]: 30,
      [GoodId.stone]: 15,
      [GoodId.iron]: 4,
      [GoodId.silver]: 6,
      [GoodId.hammer]: 1,
    },
    // Research was mission 3's lesson; the forge recipes it opened are
    // granted here so the tools themselves are the only puzzle.
    startTechs: [TechId.cobbledBoots, TechId.ironworking],
    // The predecessor's village, standing and idle. No Smith among them:
    // that is the one roof this mission is about.
    prebuilt: [
      {type: BuildingTypeId.woodcutter, dx: -6, dy: -2},
      {type: BuildingTypeId.quarry, dx: 5, dy: -6},
      {type: BuildingTypeId.house, dx: -5, dy: 4},
      {type: BuildingTypeId.well, dx: 4, dy: 4},
      {type: BuildingTypeId.wheatFarm, dx: 8, dy: 3},
      {type: BuildingTypeId.mill, dx: -3, dy: 7},
      {type: BuildingTypeId.bakery, dx: 2, dy: 7},
      {type: BuildingTypeId.ironMine, dx: 12, dy: -3},
    ],
    // Every line past the first is a post that cannot produce until its
    // tool hangs on the peg: the mine wants a pickaxe, the woodcutter an
    // axe, the field a scythe and the oven a cauldron. The checklist asks
    // for what those posts make rather than for the tools themselves,
    // because a forged tool is hauled to whichever post is calling for it
    // — it reaches the castle shelf only once nothing is waiting on it.
    objectives: [
      {
        spec: {
          kind: ObjectiveKindNs.building,
          type: BuildingTypeId.weaponsmith,
          count: 1,
        },
        label: 'Raise a Smith',
      },
      {
        spec: {kind: ObjectiveKindNs.stock, good: GoodId.iron, amount: 12},
        label: 'Lay in 12 iron at the Castle',
      },
      {
        spec: {kind: ObjectiveKindNs.stock, good: GoodId.wood, amount: 45},
        label: 'Lay in 45 wood at the Castle',
      },
      {
        spec: {kind: ObjectiveKindNs.stock, good: GoodId.food, amount: 12},
        label: 'Lay in 12 food at the Castle',
      },
      // The one the auto-forge will never do for you: a hammer is wanted
      // by a site, so a village with nothing rising wants none, and the
      // fire goes cold. Three is a batch queued by hand at the forge menu
      // — two of them, since the hammer the mission opens with comes back
      // off the Smith's own site when the roof goes on. Three on the shelf
      // is three sites that can rise at once.
      {
        spec: {kind: ObjectiveKindNs.stock, good: GoodId.hammer, amount: 3},
        label: 'Lay in 3 hammers at the Castle',
      },
    ],
  },

  [MissionIdNs.levy]: {
    id: MissionIdNs.levy,
    title: 'The Levy',
    briefing:
      'Word from the pass: bandits have made camp in the wilds, and they ' +
      'know the road to your gate better than your levy knows its drill. ' +
      'The crown expects them gone. Raise the barracks, feed your ' +
      'soldiers, and answer for the valley.',
    tagline: 'Face the first raid, then take the camp.',
    // The raid's road is the map's whole argument now
    // (mapAuthor/missions/levy.ts): a rock spur off the western wall and
    // another off the northern hills, and one gap between them on the
    // diagonal to the camp. Everything that comes for the town walks it.
    seed: 406,
    players: [{kind: PlayerKind.human}],
    bandits: true,
    campSpot: {x: 43, y: 43},
    // Five minutes — the point of this mission IS the raid, arriving before
    // the player feels ready. (Default is nine.)
    firstRaidTick: 6000,
    startSerfs: 12,
    startStock: {
      [GoodId.wood]: 30,
      [GoodId.stone]: 15,
      [GoodId.food]: 10,
      [GoodId.iron]: 6,
      [GoodId.silver]: 25,
      [GoodId.spear]: 2,
      [GoodId.sword]: 1,
      // The standing camp's kit: every prebuilt post staffs itself while
      // the player worries about the raid, not about racks.
      [GoodId.axe]: 1,
      [GoodId.pickaxe]: 2,
      [GoodId.scythe]: 1,
      [GoodId.cauldron]: 1,
      [GoodId.hammer]: 2,
    },
    // Research was mission 3's lesson; here it is already done.
    startTechs: [TechId.soldiery, TechId.cobbledBoots, TechId.ironworking],
    prebuilt: [
      {type: BuildingTypeId.woodcutter, dx: -6, dy: -2},
      {type: BuildingTypeId.quarry, dx: 6, dy: -3},
      {type: BuildingTypeId.house, dx: -5, dy: 4},
      {type: BuildingTypeId.house, dx: -8, dy: 0},
      {type: BuildingTypeId.well, dx: 5, dy: 4},
      {type: BuildingTypeId.wheatFarm, dx: 8, dy: 2},
      {type: BuildingTypeId.mill, dx: -3, dy: 7},
      {type: BuildingTypeId.bakery, dx: 2, dy: 7},
      {type: BuildingTypeId.silverMine, dx: 0, dy: -8},
      {type: BuildingTypeId.abbey, dx: 8, dy: -1},
    ],
    objectives: [
      {
        spec: {
          kind: ObjectiveKindNs.building,
          type: BuildingTypeId.barracks,
          count: 1,
        },
        label: 'Raise a Barracks',
      },
      {
        spec: {kind: ObjectiveKindNs.soldiers, count: 6},
        label: 'Field 6 soldiers at once',
      },
      {spec: {kind: ObjectiveKindNs.razeCamp}, label: 'Raze the bandit camp'},
    ],
  },

  [MissionIdNs.holdTheValley]: {
    id: MissionIdNs.holdTheValley,
    title: 'Hold the Valley',
    briefing:
      'No more letters from the crown, and no more lessons. The valley is ' +
      'yours to keep — or lose. The bandits will come in waves until their ' +
      'camp is ash; see that your castle outlives it.',
    tagline: 'The full game: no help, no headstart.',
    // The campaign's signature valley, and the only authored map that has
    // to hold a long game rather than teach one lesson: a firth west,
    // hill country east, and the beck with its two fords between the
    // valley and the bandits' heath (mapAuthor/missions/holdTheValley.ts).
    seed: 17,
    players: [{kind: PlayerKind.human}],
    bandits: true,
    campSpot: {x: 106, y: 106},
    objectives: [
      {spec: {kind: ObjectiveKindNs.razeCamp}, label: 'Raze the bandit camp'},
    ],
  },

  [MissionIdNs.rivalBanner]: {
    id: MissionIdNs.rivalBanner,
    title: 'The Rival Banner',
    briefing:
      'A rival reeve claims the far end of the valley — two banners, one ' +
      'charter, and the crown does not care which of you it honors. The ' +
      'bandits in the middle care even less. Last banner standing.',
    tagline: 'Bonus: your first rival. Last banner standing.',
    // The one map that has to be FAIR, so it is the one authored as a half
    // and mirrored: every landform, stand and seam is laid against the
    // north-western banner and repeated at its half-turn about the middle
    // of the grid, the valley's own grain included
    // (mapAuthor/missions/rivalBanner.ts — missionMaps.test.ts holds it to
    // exact symmetry). The camp sits on the line the two are equidistant
    // from, which is why its footprint is off-centre.
    seed: 12,
    players: [
      {kind: PlayerKind.human},
      {kind: PlayerKind.ai, strategy: AiStrategyId.steward},
    ],
    bandits: true,
    campSpot: {x: 76, y: 73},
    // No checklist: the ordinary last-faction-standing rules decide it.
    objectives: [],
  },
};

/** Campaign order; mission k unlocks when k-1 is complete (UI-enforced). */
export const MISSION_ORDER: MissionId[] = [
  MissionIdNs.clearing,
  MissionIdNs.breadAndWater,
  MissionIdNs.ledger,
  MissionIdNs.hammerAndHaft,
  MissionIdNs.levy,
  MissionIdNs.holdTheValley,
  MissionIdNs.rivalBanner,
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
  if (typeof raw === 'string') return MISSION_BY_KEY.get(raw);
  // ...or the id, for the same reason parseStrategyId takes one: a replay's
  // config head is the WorldConfig as it stood, while ?mission and a save's
  // metadata head are words a person reads.
  return typeof raw === 'number' && Object.hasOwn(MISSION_KEYS, raw)
    ? (raw as MissionId)
    : undefined;
}

/**
 * The spelling of each mission id. The id is a number inside the sim, but
 * it is a word everywhere a person meets it — the ?mission parameter, a
 * save file's metadata head — and those are formats, not internals.
 */
export const MISSION_KEYS: Readonly<Record<MissionId, string>> = {
  [MissionIdNs.clearing]: 'clearing',
  [MissionIdNs.breadAndWater]: 'breadAndWater',
  [MissionIdNs.ledger]: 'ledger',
  [MissionIdNs.hammerAndHaft]: 'hammerAndHaft',
  [MissionIdNs.levy]: 'levy',
  [MissionIdNs.holdTheValley]: 'holdTheValley',
  [MissionIdNs.rivalBanner]: 'rivalBanner',
};

const MISSION_BY_KEY = new Map<string, MissionId>(
  MISSION_ORDER.map(id => [MISSION_KEYS[id], id]),
);
