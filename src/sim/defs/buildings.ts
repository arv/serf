import { REPAIR_COST_SHARE } from './balance.ts';
import type { GoodAmounts, GoodId } from './goods.ts';
import type { UnitClass, UnitTypeId } from './units.ts';
import type { TechId } from './techs.ts';

/**
 * Two recipe kinds cover every producer in the game:
 * - gather: a resident worker commutes to nearby resource tiles, works them,
 *   and carries the yield home into the building's output stock.
 * - convert: inputs from the building's input buffer become outputs over time
 *   (no worker commute; empty inputs = a pure timer, e.g. the well).
 */
export type TileResourceName = 'wood' | 'rock' | 'ironDep' | 'silverDep' | 'goldDep';

export type Recipe =
  | {
      kind: 'gather';
      resource: TileResourceName;
      output: GoodId;
      /** Search radius (tiles from building center) for resource tiles. This
       * is also the placement rule: a gatherer may only be sited where the
       * worker it will house can already see something to work. */
      radius: number;
      /** Ticks spent working a tile before yielding 1 good. */
      workTicks: number;
    }
  | {
      kind: 'convert';
      inputs: GoodAmounts;
      outputs: GoodAmounts;
      durationTicks: number;
    };

export interface BuildingDef {
  id: BuildingTypeId;
  name: string;
  w: number;
  h: number;
  /** Construction materials (delivered to the site before building starts). */
  cost: GoodAmounts;
  /**
   * What a repair is billed against, when `cost` cannot speak for the
   * building — the castle, which nobody paid to raise and which would
   * otherwise mend itself out of thin air. Everything else bills against
   * its own build cost (see REPAIR_COST_SHARE).
   */
  repairCost?: GoodAmounts;
  buildTicks: number;
  hp: number;
  /** How far this building reveals the map from its footprint edge, in
   * tiles. Read by both the server's visibility filter and the renderer's
   * fog, so the two cannot drift. */
  sight: number;
  storage?: boolean;
  /** Beds this building adds to its owner's population cap while it stands
   * (built only — a roof under construction houses nobody). */
  housing?: number;
  recipe?: Recipe;
  /** Player-selectable convert recipes (the weaponsmith's forge menu).
   * The building's recipeIndex picks the active one; options may be
   * individually tech-gated on top of the building's own unlock. */
  recipeOptions?: { recipe: Recipe & { kind: 'convert' }; requiresTech?: TechId }[];
  /** Resident worker spawned when construction completes (gather recipes). */
  workerKind?: UnitTypeId;
  /**
   * Ticks a hauler spends at this building collecting one good, before it
   * has anything in its hands. Undefined — every building but the well —
   * means a pickup is instant.
   *
   * The well's alternative to a resident: a bucket on a rope is not a job,
   * it is a thing you do when you want water. The cost does not vanish, it
   * moves — off the population cap and onto the haulage pool, and onto the
   * beat it is actually wanted rather than all day. A keeper cranking into
   * a full bucket was paying rent on nothing.
   */
  drawTicks?: number;
  /** Digs into the hillside rather than standing on it: exempt from the
   * flat-ground placement rule, and sped up by mining research. */
  mine?: boolean;
  /**
   * Placement: requires open water within `radius` tiles of the footprint,
   * and turns the building to face it (Building.facing). Like `mine` it also
   * frees the footprint from the flat-ground rule — a bank is a slope by
   * definition, and a fishery that can only stand on a dead-level beach can
   * stand almost nowhere. Unlike `mine` it is a rule the sim enforces rather
   * than a fact about the building: the fishery converts, so the gather-radius
   * check that sites every other resource building cannot speak for it.
   */
  nearWater?: { radius: number };
  /** Site demand priority (construction defaults to 1; road paving uses 3). */
  sitePriority?: 1 | 2 | 3;
  /** Footprint does not block movement (road sites). */
  noBlock?: boolean;
  /** On completion: pave the tile to a stone road and remove the building. */
  isRoad?: boolean;
  /** Hidden from the build menu (system-placed). */
  systemOnly?: boolean;
  /**
   * Multiplier on the model's rendered size, on top of the footprint-derived
   * scale (makeGlbBuilding). Render-only — the sim's footprint, placement
   * and blocking all still read w/h, so this changes what a building looks
   * like and nothing about what it does.
   *
   * For the handful the pack authors too squat to read at village zoom.
   * Costs overhang, since the scale is uniform and the base grows with the
   * roof: at 1.2 a 2x2 model spills about a fifth of a tile past each
   * side. Fine for the mines, which are cut into a hillside and sit alone
   * out at the rock; it would be wrong for anything that stands shoulder to
   * shoulder in the village.
   */
  modelScale?: number;
  /** Must be researched before this building can be placed (an array
   * means any one of them suffices). */
  requiresTech?: TechId | TechId[];
  /** Military training (barracks): unit options with costs + duration. */
  trains?: { unit: UnitTypeId; cost: GoodAmounts; durationTicks: number }[];
  /**
   * Manned defence (the guard tower). The building pulls idle soldiers of
   * `unit` off the field — up to `capacity` of them — and shoots with their
   * own stats, sharpened by what the wall gives them: `rangeBonus` tiles of
   * extra reach for the height, and `damageMult` on the damage for shooting
   * down from cover at a man who cannot shoot back.
   *
   * The men are consumed into the building the way the barracks consumes a
   * recruit, rather than bound the way a hut binds its worker: there is no
   * unit left on the map to acquire, chase or kite, which is what makes a
   * garrison untouchable except by knocking the tower down. The cost of
   * that is that population has to count them explicitly (population.ts).
   */
  garrison?: {
    unit: UnitTypeId;
    capacity: number;
    damageMult: number;
    /** Tiles of reach the height adds, on top of the unit's own range. */
    rangeBonus: number;
    /**
     * The villagers who hold the wall until there are soldiers to hold it.
     *
     * A tower's archers sit at the far end of the longest chain in the game
     * — a research, a forge, a weapon, a course at the barracks — which is
     * well past when a rush arrives. The levy is the answer to that: stones
     * from the parapet, called for by hand and worth a fraction of a bow,
     * but standing on the day the masons come off the scaffold.
     *
     * Its own stats rather than the serf's, because a serf has no combat
     * block at all — a man with a rock is not a unit type, he is a job. Not
     * multiplied by `damageMult` and not lengthened by `rangeBonus` either:
     * the height is an archer's advantage to press, and leaning out to drop
     * a stone is not aiming.
     *
     * A tower holds one kind or the other, never both (see garrisonKind):
     * the first soldier to climb up sends the whole levy back down.
     */
    levy: {
      unit: UnitTypeId;
      class: UnitClass;
      damage: number;
      cooldownTicks: number;
      range: number;
    };
  };
}

/**
 * The Settlers rule, both ends of it: a producer stalls once its output
 * buffer is full, and a converter's standing demand tops its inputs up to
 * here and no further. Five rather than four gives every building one more
 * beat of slack before it stops — enough that a gatherer whose hauler is
 * a moment late keeps working, without turning a hut into a warehouse.
 */
export const OUTPUT_CAP = 5;
export const INPUT_CAP = 5;

export type BuildingTypeId =
  | 'storehouse'
  | 'banditCamp'
  | 'woodcutter'
  | 'quarry'
  | 'house'
  | 'well'
  | 'wheatFarm'
  | 'mill'
  | 'bakery'
  | 'fishery'
  | 'brewery'
  | 'ironMine'
  | 'silverMine'
  | 'goldMine'
  | 'weaponsmith'
  | 'abbey'
  | 'barracks'
  | 'guardTower'
  | 'roadSite';

const S = 20; // ticks per second, inlined to keep defs readable

export const BUILDING_DEFS: Record<BuildingTypeId, BuildingDef> = {
  storehouse: {
    id: 'storehouse',
    name: 'Castle',
    w: 3,
    h: 3,
    cost: {},
    // The keep costs nothing to raise (it is where you start) but masons
    // still want paying to patch it: a notional price, dearer than a
    // barracks, so mending 500 hp of wall is a real decision after a raid.
    repairCost: { wood: 20, stone: 12 },
    buildTicks: 0,
    hp: 500,
    sight: 9,
    storage: true,
    // The keep's own quarters. Ten beds is two spare on the eight serfs the
    // village starts with: enough to replace a loss or two, not enough to
    // grow on. Everything past that is a house you chose to build.
    housing: 10,
  },
  banditCamp: {
    id: 'banditCamp',
    name: 'Bandit Camp',
    w: 3,
    h: 3,
    cost: {},
    buildTicks: 0,
    hp: 600,
    sight: 5.5,
    // Worldgen's to place, nobody else's. The flag was missing, and the
    // sim's placement guard is `!systemOnly && !storage` — so a client that
    // sent `placeBuilding: 'banditCamp'` got six hundred hit points for
    // nothing. No UI ever offered it, which is why it went unnoticed; a
    // hand-edited command in a networked match is not bound by the UI.
    systemOnly: true,
  },
  woodcutter: {
    id: 'woodcutter',
    name: 'Woodcutter',
    w: 2,
    h: 2,
    cost: { wood: 6 },
    buildTicks: 15 * S,
    hp: 150,
    sight: 5.5,
    workerKind: 'worker',
    recipe: { kind: 'gather', resource: 'wood', output: 'wood', radius: 8, workTicks: 2.5 * S },
  },
  quarry: {
    id: 'quarry',
    name: 'Quarry',
    w: 2,
    h: 2,
    cost: { wood: 6 },
    buildTicks: 15 * S,
    hp: 150,
    modelScale: 1.2,
    sight: 5.5,
    workerKind: 'worker',
    recipe: { kind: 'gather', resource: 'rock', output: 'stone', radius: 8, workTicks: 3 * S },
  },
  house: {
    id: 'house',
    name: 'House',
    w: 2,
    h: 2,
    // Timber and a stone hearth — deliberately cheap. Housing is what the
    // whole plan grows through, so the choice a house asks for should be
    // "these six wood, now, instead of the mine" and not "this house or an
    // army". Priced above the well and below the woodcutter.
    cost: { wood: 6, stone: 2 },
    buildTicks: 12 * S,
    hp: 120,
    sight: 5.5,
    housing: 10,
    // No resident and no recipe: like the abbey, the serf who raises it
    // walks away a serf again when the roof goes on.
  },
  well: {
    id: 'well',
    name: 'Well',
    w: 1,
    h: 1,
    cost: { wood: 4 },
    buildTicks: 8 * S,
    hp: 80,
    sight: 5.5,
    // No keeper. The two clocks are different things: durationTicks is the
    // shaft refilling — the well's own rate, and still what caps one well at
    // ten water a minute — and drawTicks is the hauler on the windlass. Only
    // the second costs anybody anything, and only when someone came for
    // water.
    //
    // Six seconds each, which is not a coincidence: a resident made ten
    // water a minute for one permanent hand, so a six-second draw at ten
    // water a minute costs the same hand's worth of haulage. The bill is
    // identical and the population slot is free. Below demand it costs
    // nothing at all, which the keeper never managed.
    recipe: { kind: 'convert', inputs: {}, outputs: { water: 1 }, durationTicks: 6 * S },
    drawTicks: 6 * S,
  },
  wheatFarm: {
    id: 'wheatFarm',
    name: 'Wheat Farm',
    w: 3,
    h: 3,
    cost: { wood: 8 },
    buildTicks: 15 * S,
    hp: 100,
    sight: 5.5,
    workerKind: 'worker',
    recipe: { kind: 'convert', inputs: { water: 1 }, outputs: { wheat: 1 }, durationTicks: 10 * S },
  },
  mill: {
    id: 'mill',
    name: 'Mill',
    w: 2,
    h: 2,
    cost: { wood: 8, stone: 4 },
    buildTicks: 18 * S,
    hp: 150,
    sight: 5.5,
    // No resident: the wind does the grinding, the way it does in the
    // model. That is not only flavor — the chain adds two posts to a serf
    // pool the balance keeps deliberately lean, and paying two hands for
    // what used to be one farm's output is what made the campaign
    // unwinnable in testing. The bakery keeps its baker.
    // Grain in, flour out. Slower than the farm that feeds it on purpose:
    // one mill should serve two farms, so the chain is a shape rather than
    // a stack of one-to-ones.
    recipe: { kind: 'convert', inputs: { wheat: 1 }, outputs: { flour: 1 }, durationTicks: 8 * S },
  },
  bakery: {
    id: 'bakery',
    name: 'Bakery',
    w: 2,
    h: 2,
    cost: { wood: 10, stone: 6 },
    buildTicks: 20 * S,
    hp: 160,
    sight: 5.5,
    workerKind: 'worker',
    // The well is already on every build order; making bread want water
    // ties the food chain to it rather than adding a parallel one.
    recipe: {
      kind: 'convert',
      inputs: { flour: 1, water: 1 },
      outputs: { food: 2 },
      durationTicks: 12 * S,
    },
  },
  fishery: {
    id: 'fishery',
    name: 'Fishery',
    w: 3,
    h: 3,
    cost: { wood: 12, stone: 4 },
    buildTicks: 20 * S,
    hp: 150,
    sight: 6.5,
    workerKind: 'worker',
    // The early food, and the slow one. Nothing goes in: no field, no well,
    // no flour — one hut and one hand, feeding the barracks the beat it is
    // finished, where the bread chain is a well, a farm, a mill and a bakery
    // before its first loaf. That is what the rate pays for. Three a minute
    // against the bakery's ten, and counting the hands the chain's upstream
    // needs it is still 3.0 food per minute per hand against bread's 3.5 —
    // so a village that has grown out of its opening wants ovens, and one
    // that has not wants a shore. Fish while you are poor, bake once you
    // are not.
    //
    // Twenty seconds and not twelve, which is where this started: at twelve
    // a fishery made 5.0 per hand and beat the whole chain outright, and
    // there is no scarcity to hold it back — a map carries four hundred-odd
    // legal shore sites against a thousand-odd field sites. Two huts would
    // have retired the bakery.
    //
    // (A hen yard stood beside these two for a while, wheat straight to
    // food. Cut: two food sources are a choice, three were a menu, and the
    // hens lost to the bakery on every number that mattered.)
    recipe: { kind: 'convert', inputs: {}, outputs: { food: 1 }, durationTicks: 20 * S },
    // Touching, not merely near: the pier is part of the building, and a
    // pier that stops three tiles short of the water is worse than none.
    nearWater: { radius: 1 },
  },
  brewery: {
    id: 'brewery',
    name: 'Brewery',
    requiresTech: 'brewing' as const,
    w: 2,
    h: 2,
    cost: { wood: 10, stone: 4 },
    buildTicks: 20 * S,
    hp: 160,
    sight: 5.5,
    workerKind: 'worker',
    // Twenty seconds, up from fifteen: sized to its market rather than its
    // model. Ale's sinks are the abbey's festival sip (1/min at full buff
    // uptime) and, with Ale Rations, the barracks cask (2-3/min at war
    // tempo) — at 3/min one brewery runs near full duty against both,
    // where the old 4/min filled its buffer and idled at a quarter duty
    // on a market the festival alone capped at 1/min. Wheat stays sane
    // too: 3/min is half a farm, alongside the mill's draw.
    recipe: {
      kind: 'convert',
      inputs: { wheat: 1, water: 1 },
      outputs: { ale: 1 },
      durationTicks: 20 * S,
    },
  },
  ironMine: {
    id: 'ironMine',
    name: 'Iron Mine',
    requiresTech: 'ironworking' as const,
    w: 2,
    h: 2,
    cost: { wood: 8, stone: 4 },
    buildTicks: 20 * S,
    hp: 180,
    modelScale: 1.2,
    sight: 5.5,
    workerKind: 'worker',
    recipe: { kind: 'gather', resource: 'ironDep', output: 'iron', radius: 4, workTicks: 4 * S },
    mine: true,
  },
  silverMine: {
    id: 'silverMine',
    name: 'Silver Mine',
    w: 2,
    h: 2,
    cost: { wood: 8, stone: 4 },
    buildTicks: 20 * S,
    hp: 180,
    modelScale: 1.2,
    sight: 5.5,
    workerKind: 'worker',
    recipe: { kind: 'gather', resource: 'silverDep', output: 'silver', radius: 4, workTicks: 4 * S },
    mine: true,
  },
  goldMine: {
    id: 'goldMine',
    name: 'Gold Mine',
    requiresTech: 'deepMining' as const,
    w: 2,
    h: 2,
    cost: { wood: 10, stone: 6 },
    buildTicks: 25 * S,
    hp: 180,
    modelScale: 1.2,
    sight: 5.5,
    workerKind: 'worker',
    recipe: { kind: 'gather', resource: 'goldDep', output: 'gold', radius: 4, workTicks: 5 * S },
    mine: true,
  },
  weaponsmith: {
    // The type id keeps its old name on purpose: renaming it would churn
    // saves, every AI playbook, economyRules and the model table for the
    // sake of a display string. The building the player sees is the Smith.
    id: 'weaponsmith',
    name: 'Smith',
    // No tech gate on the roof itself — the Smith is the village's only
    // source of tools, and nine of the ten posts need one (TOOL_OF), so
    // the building must be reachable from a standing start. What it can
    // forge is gated per recipe below; at t=0 that is fishing rods only.
    w: 2,
    h: 2,
    cost: { wood: 10, stone: 6 },
    buildTicks: 20 * S,
    hp: 180,
    sight: 5.5,
    workerKind: 'worker',
    recipeOptions: [
      {
        recipe: {
          kind: 'convert',
          inputs: { iron: 1, wood: 2 },
          outputs: { spear: 1 },
          durationTicks: 10 * S,
        },
        requiresTech: 'ironworking' as const,
      },
      {
        recipe: {
          kind: 'convert',
          inputs: { iron: 2, wood: 1 },
          outputs: { sword: 1 },
          durationTicks: 14 * S,
        },
        requiresTech: 'ironworking' as const,
      },
      {
        recipe: {
          kind: 'convert',
          inputs: { wood: 3 },
          outputs: { bow: 1 },
          durationTicks: 8 * S,
        },
        requiresTech: 'archery' as const,
      },
      // The tools, appended after the weapons: indices 0/1/2 are quoted by
      // weaponMix, WEAPON_NAMES, COUNTER_PICK and forgeTheCounter, so the
      // arms must keep their seats. Iron-and-wood like the arms above; the
      // rod is the wood-only exception that keeps the shore reachable for
      // a village with no ore, the way the bow is the wood-only weapon.
      {
        recipe: {
          kind: 'convert',
          inputs: { iron: 1, wood: 2 },
          outputs: { axe: 1 },
          durationTicks: 8 * S,
        },
        requiresTech: 'ironworking' as const,
      },
      {
        // The one tool that must not cost iron: every mine is staffed by a
        // pickaxe, so an iron pickaxe is a circle — lose your picks and no
        // ore ever flows again to forge the next one (measured: the AI
        // deadlocked exactly there). Wood and stone, like the buildings
        // the mines themselves are raised from.
        recipe: {
          kind: 'convert',
          inputs: { wood: 2, stone: 1 },
          outputs: { pickaxe: 1 },
          durationTicks: 8 * S,
        },
        requiresTech: 'ironworking' as const,
      },
      {
        recipe: {
          kind: 'convert',
          inputs: { iron: 1, wood: 2 },
          outputs: { scythe: 1 },
          durationTicks: 8 * S,
        },
        requiresTech: 'ironworking' as const,
      },
      {
        recipe: {
          kind: 'convert',
          inputs: { iron: 1, wood: 1 },
          outputs: { hammer: 1 },
          durationTicks: 6 * S,
        },
        requiresTech: 'ironworking' as const,
      },
      {
        recipe: {
          kind: 'convert',
          inputs: { iron: 1, wood: 1 },
          outputs: { cauldron: 1 },
          durationTicks: 8 * S,
        },
        requiresTech: 'ironworking' as const,
      },
      {
        recipe: {
          kind: 'convert',
          inputs: { wood: 3 },
          outputs: { rod: 1 },
          durationTicks: 6 * S,
        },
      },
    ],
  },
  abbey: {
    id: 'abbey',
    name: 'Abbey',
    w: 2,
    h: 2,
    cost: { wood: 10, stone: 4 },
    buildTicks: 20 * S,
    hp: 160,
    sight: 5.5,
  },
  barracks: {
    id: 'barracks',
    name: 'Barracks',
    w: 3,
    h: 3,
    cost: { wood: 12, stone: 8 },
    buildTicks: 25 * S,
    hp: 220,
    sight: 5.5,
    requiresTech: 'soldiery',
    trains: [
      // Soldiers march on bread, not on raw grain: the barracks is the far
      // end of mill -> bakery, and wheat is a crop again.
      { unit: 'knight', cost: { food: 3, sword: 1 }, durationTicks: 15 * S },
      { unit: 'spearman', cost: { food: 2, spear: 1 }, durationTicks: 10 * S },
      { unit: 'archer', cost: { food: 2, bow: 1 }, durationTicks: 12 * S },
    ],
  },
  guardTower: {
    id: 'guardTower',
    name: 'Guard Tower',
    // Stone where the barracks is timber, and dearer in it: a tower is the
    // one building whose whole substance is the wall itself.
    w: 2,
    h: 2,
    cost: { wood: 6, stone: 12 },
    buildTicks: 20 * S,
    hp: 260,
    // A tower is built to be looked out of. Short of the castle's nine,
    // well past the five and a half every workshop sees.
    sight: 8,
    // Gated with the barracks rather than with the bow: raising the tower
    // is the decision to defend a line, and it can stand empty and waiting
    // while the archers who will man it are still a research away.
    requiresTech: 'soldiery',
    // Half again the damage and two tiles further than the same archer
    // standing in the field. Deliberately short of doubling either: two men
    // in a tower already beat two men on the grass by being unkillable
    // while it stands, and a tower that also hit like four of them made
    // fielding an army the wrong move.
    garrison: {
      unit: 'archer',
      capacity: 2,
      damageMult: 1.5,
      rangeBonus: 2,
      // Four on a slow clock and a short reach — about a quarter of what
      // the same two men do with bows. Enough that a raider arrives at the
      // castle already hurt, never enough to be worth calling instead of
      // training the archers.
      //
      // `light` rather than `ranged`: it is a rock and not a bow, and the
      // light column is the one that does not flinch at the bandits every
      // early wave is made of.
      levy: { unit: 'serf', class: 'light', damage: 4, cooldownTicks: 30, range: 4 },
    },
  },
  roadSite: {
    id: 'roadSite',
    name: 'Road',
    w: 1,
    h: 1,
    cost: { stone: 1 },
    buildTicks: 2 * S,
    hp: 1,
    sight: 5.5,
    sitePriority: 3,
    noBlock: true,
    isRoad: true,
    systemOnly: true,
  },
};

export function buildingDef(id: BuildingTypeId): BuildingDef {
  return BUILDING_DEFS[id];
}

/**
 * The tool a serf must be handed before he will take up this post — held in
 * the building's input buffer like a barracks weapon, consumed when the
 * worker binds, handed back when he is dismissed (never when he dies).
 * Buildings absent here need none: the mill, well and abbey keep no resident,
 * and the Smith is deliberately toolless because it is the only source of
 * tools — gating it is the one thing that could hard-lock a village.
 *
 * The hammer is missing on purpose too: it is a loan, not a hire — every
 * construction site borrows one (siteNeeds) and returns it at completion,
 * so hammers cap how many buildings rise at once. See placeSite/deliver.
 */
export const TOOL_OF: Partial<Record<BuildingTypeId, GoodId>> = {
  woodcutter: 'axe',
  quarry: 'pickaxe',
  ironMine: 'pickaxe',
  silverMine: 'pickaxe',
  goldMine: 'pickaxe',
  wheatFarm: 'scythe',
  bakery: 'cauldron',
  brewery: 'cauldron',
  fishery: 'rod',
};

/** Every good that is a tool — the strip of GOODS the Smith serves the
 * village with. Order follows GOODS so iteration stays deterministic. */
export const TOOL_GOODS = ['axe', 'pickaxe', 'scythe', 'hammer', 'cauldron', 'rod'] as const satisfies readonly GoodId[];

/** setBuildingRecipe sentinel: no standing order — the Smith forges
 * whatever tool the village most lacks (see resolveForgeIndex). This is
 * also what a fresh Smith does: recipeIndex undefined means auto. */
export const AUTO_RECIPE = -1;

/** Room left in this building's garrison, counting the man already walking
 * in. Zero for everything that holds no garrison at all. */
export function garrisonRoom(def: BuildingDef, b: { garrison?: number; recruitId?: number }): number {
  if (!def.garrison) return 0;
  return def.garrison.capacity - (b.garrison ?? 0) - (b.recruitId !== undefined ? 1 : 0);
}

/** The gather recipe, if this building works the land. Undefined for
 * converters and for buildings with no recipe at all. */
export function gatherRecipeOf(def: BuildingDef): (Recipe & { kind: 'gather' }) | undefined {
  return def.recipe?.kind === 'gather' ? def.recipe : undefined;
}

/** The tile a gatherer searches outward from: its footprint center, floored.
 * Takes the origin rather than the building so a ghost under the cursor
 * measures its reach from exactly where the built hut would. */
export function gatherOrigin(
  def: BuildingDef,
  x: number,
  y: number,
): { x: number; y: number } {
  return { x: Math.floor(x + def.w / 2), y: Math.floor(y + def.h / 2) };
}

/** The active convert recipe: the fixed one, or the standing order the
 * building's recipeIndex names. Undefined for gatherers, storage — and for
 * a Smith on auto (recipeIndex unset), whose next recipe is not knowable
 * from the def alone; production and logistics resolve auto themselves. */
export function convertRecipeOf(
  def: BuildingDef,
  b?: { recipeIndex?: number },
): (Recipe & { kind: 'convert' }) | undefined {
  if (def.recipe?.kind === 'convert') return def.recipe;
  if (b?.recipeIndex === undefined) return undefined;
  return def.recipeOptions?.[b.recipeIndex]?.recipe;
}

/**
 * What mending `missingHp` of this building costs: its build price (or the
 * notional `repairCost` for the ones nobody paid for), scaled by the share
 * of the building that is broken and by REPAIR_COST_SHARE, and rounded up
 * so no repair is ever free.
 *
 * Priced from the def alone, so the panel can quote the bill under the
 * cursor with exactly the arithmetic the sim will charge.
 */
export function repairBill(id: BuildingTypeId, missingHp: number): GoodAmounts {
  const def = buildingDef(id);
  const price = def.repairCost ?? def.cost;
  const share = Math.max(0, Math.min(1, missingHp / Math.max(def.hp, 1))) * REPAIR_COST_SHARE;
  const bill: GoodAmounts = {};
  for (const [good, n] of Object.entries(price) as [GoodId, number][]) {
    const owed = Math.ceil(n * share);
    if (owed > 0) bill[good] = owed;
  }
  return bill;
}

/** Every good this building can ever emit — evacuation must keep hauling
 * a weapon the smith no longer forges. */
export function outputGoodsOf(def: BuildingDef): GoodId[] {
  if (def.recipe) {
    return def.recipe.kind === 'gather'
      ? [def.recipe.output]
      : (Object.keys(def.recipe.outputs) as GoodId[]);
  }
  const out = new Set<GoodId>();
  for (const opt of def.recipeOptions ?? []) {
    for (const g of Object.keys(opt.recipe.outputs) as GoodId[]) out.add(g);
  }
  return [...out];
}
