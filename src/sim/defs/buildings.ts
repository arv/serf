import type { GoodAmounts, GoodId } from './goods.ts';
import type { UnitTypeId } from './units.ts';
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
      /** Search radius (tiles from building center) for resource tiles. */
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
  /** Placement: requires a matching deposit tile within `radius` of the footprint. */
  nearDeposit?: { resource: TileResourceName; radius: number };
  /**
   * Placement: requires open water within `radius` tiles of the footprint,
   * and turns the building to face it (Building.facing). Like nearDeposit
   * it also frees the footprint from the flat-ground rule — a shoreline is
   * a bank by definition, and a fishery that can only stand on a dead-level
   * beach can stand almost nowhere.
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
  /** Must be researched before this building can be placed (an array
   * means any one of them suffices). */
  requiresTech?: TechId | TechId[];
  /** Military training (barracks): unit options with costs + duration. */
  trains?: { unit: UnitTypeId; cost: GoodAmounts; durationTicks: number }[];
}

export const OUTPUT_CAP = 4;
export const INPUT_CAP = 4;

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
  | 'henYard'
  | 'fishery'
  | 'brewery'
  | 'ironMine'
  | 'silverMine'
  | 'goldMine'
  | 'weaponsmith'
  | 'abbey'
  | 'barracks'
  | 'roadSite';

const S = 20; // ticks per second, inlined to keep defs readable

export const BUILDING_DEFS: Record<BuildingTypeId, BuildingDef> = {
  storehouse: {
    id: 'storehouse',
    name: 'Castle',
    w: 3,
    h: 3,
    cost: {},
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
    workerKind: 'worker',
    recipe: { kind: 'convert', inputs: {}, outputs: { water: 1 }, durationTicks: 6 * S },
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
    // The only food that costs no field. That is the whole point of it:
    // on a map where the wheat belt is somebody else's, a coastline is a
    // war economy. The price is that it can only stand on one, and most
    // ground on most maps is not one.
    recipe: { kind: 'convert', inputs: {}, outputs: { food: 1 }, durationTicks: 12 * S },
    // Touching, not merely near: the pier is part of the building, and a
    // pier that stops three tiles short of the water is worse than none.
    nearWater: { radius: 1 },
  },
  henYard: {
    id: 'henYard',
    name: 'Hen Yard',
    w: 3,
    h: 3,
    cost: { wood: 10, stone: 2 },
    buildTicks: 18 * S,
    hp: 140,
    sight: 5.5,
    workerKind: 'worker',
    // The short path to food, against the mill-and-bakery's long one: one
    // building and one hand instead of two of each, at half the food per
    // grain. It also wants ground — 3x3 for what the bakery does in 2x2 —
    // so the choice between them is bread in a tight village against birds
    // on land you have to spare.
    recipe: { kind: 'convert', inputs: { wheat: 1 }, outputs: { food: 1 }, durationTicks: 13 * S },
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
    recipe: {
      kind: 'convert',
      inputs: { wheat: 1, water: 1 },
      outputs: { ale: 1 },
      durationTicks: 15 * S,
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
    sight: 5.5,
    workerKind: 'worker',
    recipe: { kind: 'gather', resource: 'ironDep', output: 'iron', radius: 4, workTicks: 4 * S },
    nearDeposit: { resource: 'ironDep', radius: 4 },
  },
  silverMine: {
    id: 'silverMine',
    name: 'Silver Mine',
    w: 2,
    h: 2,
    cost: { wood: 8, stone: 4 },
    buildTicks: 20 * S,
    hp: 180,
    sight: 5.5,
    workerKind: 'worker',
    recipe: { kind: 'gather', resource: 'silverDep', output: 'silver', radius: 4, workTicks: 4 * S },
    nearDeposit: { resource: 'silverDep', radius: 4 },
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
    sight: 5.5,
    workerKind: 'worker',
    recipe: { kind: 'gather', resource: 'goldDep', output: 'gold', radius: 4, workTicks: 5 * S },
    nearDeposit: { resource: 'goldDep', radius: 4 },
  },
  weaponsmith: {
    id: 'weaponsmith',
    name: 'Weaponsmith',
    // Either war path opens the forge; what it can forge is gated per
    // recipe below. (Sword-, spear- and bowmaking shared one roof — and,
    // it turned out, one model — so they share one building.)
    requiresTech: ['ironworking', 'archery'] as const as ('ironworking' | 'archery')[],
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

/** The active convert recipe: the fixed one, or the option the building's
 * recipeIndex selects (weaponsmith). Undefined for gatherers and storage. */
export function convertRecipeOf(
  def: BuildingDef,
  b?: { recipeIndex?: number },
): (Recipe & { kind: 'convert' }) | undefined {
  if (def.recipe?.kind === 'convert') return def.recipe;
  return def.recipeOptions?.[b?.recipeIndex ?? 0]?.recipe;
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
