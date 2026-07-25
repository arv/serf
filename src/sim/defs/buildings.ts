import type { GoodAmounts, GoodId } from './goods';
import type { UnitTypeId } from './units';
import type { TechId } from './techs';

/**
 * Two recipe kinds cover every producer in the game:
 * - gather: a resident worker commutes to nearby resource tiles, works them,
 *   and carries the yield home into the building's output stock.
 * - convert: inputs from the building's input buffer become outputs over time
 *   (no worker commute; empty inputs = a pure timer, e.g. the well).
 */
export type TileResourceName = 'bamboo' | 'rock' | 'ironDep' | 'silverDep' | 'goldDep';

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
  storage?: boolean;
  recipe?: Recipe;
  /** Resident worker spawned when construction completes (gather recipes). */
  workerKind?: UnitTypeId;
  /** Placement: requires a matching deposit tile within `radius` of the footprint. */
  nearDeposit?: { resource: TileResourceName; radius: number };
  /** Site demand priority (construction defaults to 1; road paving uses 3). */
  sitePriority?: 1 | 2 | 3;
  /** Footprint does not block movement (road sites). */
  noBlock?: boolean;
  /** On completion: pave the tile to a stone road and remove the building. */
  isRoad?: boolean;
  /** Hidden from the build menu (system-placed). */
  systemOnly?: boolean;
  /** Must be researched before this building can be placed. */
  requiresTech?: TechId;
  /** Military training (dojo): unit options with costs + duration. */
  trains?: { unit: UnitTypeId; cost: GoodAmounts; durationTicks: number }[];
}

export const OUTPUT_CAP = 4;
export const INPUT_CAP = 4;

export type BuildingTypeId =
  | 'storehouse'
  | 'banditCamp'
  | 'bambooHut'
  | 'quarry'
  | 'well'
  | 'ricePaddy'
  | 'sakeBrewery'
  | 'ironMine'
  | 'silverMine'
  | 'goldMine'
  | 'swordsmith'
  | 'spearmaker'
  | 'bowyer'
  | 'terakoya'
  | 'dojo'
  | 'roadSite';

const S = 20; // ticks per second, inlined to keep defs readable

export const BUILDING_DEFS: Record<BuildingTypeId, BuildingDef> = {
  storehouse: {
    id: 'storehouse',
    name: 'Storehouse',
    w: 3,
    h: 3,
    cost: {},
    buildTicks: 0,
    hp: 500,
    storage: true,
  },
  banditCamp: {
    id: 'banditCamp',
    name: 'Bandit Camp',
    w: 3,
    h: 3,
    cost: {},
    buildTicks: 0,
    hp: 600,
  },
  bambooHut: {
    id: 'bambooHut',
    name: 'Bamboo Hut',
    w: 2,
    h: 2,
    cost: { bamboo: 6 },
    buildTicks: 15 * S,
    hp: 150,
    workerKind: 'worker',
    recipe: { kind: 'gather', resource: 'bamboo', output: 'bamboo', radius: 8, workTicks: 2.5 * S },
  },
  quarry: {
    id: 'quarry',
    name: 'Quarry',
    w: 2,
    h: 2,
    cost: { bamboo: 6 },
    buildTicks: 15 * S,
    hp: 150,
    workerKind: 'worker',
    recipe: { kind: 'gather', resource: 'rock', output: 'stone', radius: 8, workTicks: 3 * S },
  },
  well: {
    id: 'well',
    name: 'Well',
    w: 1,
    h: 1,
    cost: { bamboo: 4 },
    buildTicks: 8 * S,
    hp: 80,
    workerKind: 'worker',
    recipe: { kind: 'convert', inputs: {}, outputs: { water: 1 }, durationTicks: 6 * S },
  },
  ricePaddy: {
    id: 'ricePaddy',
    name: 'Rice Paddy',
    w: 3,
    h: 3,
    cost: { bamboo: 8 },
    buildTicks: 15 * S,
    hp: 100,
    workerKind: 'worker',
    recipe: { kind: 'convert', inputs: { water: 1 }, outputs: { rice: 1 }, durationTicks: 10 * S },
  },
  sakeBrewery: {
    id: 'sakeBrewery',
    name: 'Sake Brewery',
    requiresTech: 'sakeBrewing' as const,
    w: 2,
    h: 2,
    cost: { bamboo: 10, stone: 4 },
    buildTicks: 20 * S,
    hp: 160,
    workerKind: 'worker',
    recipe: {
      kind: 'convert',
      inputs: { rice: 1, water: 1 },
      outputs: { sake: 1 },
      durationTicks: 15 * S,
    },
  },
  ironMine: {
    id: 'ironMine',
    name: 'Iron Mine',
    requiresTech: 'ironworking' as const,
    w: 2,
    h: 2,
    cost: { bamboo: 8, stone: 4 },
    buildTicks: 20 * S,
    hp: 180,
    workerKind: 'worker',
    recipe: { kind: 'gather', resource: 'ironDep', output: 'iron', radius: 4, workTicks: 4 * S },
    nearDeposit: { resource: 'ironDep', radius: 4 },
  },
  silverMine: {
    id: 'silverMine',
    name: 'Silver Mine',
    w: 2,
    h: 2,
    cost: { bamboo: 8, stone: 4 },
    buildTicks: 20 * S,
    hp: 180,
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
    cost: { bamboo: 10, stone: 6 },
    buildTicks: 25 * S,
    hp: 180,
    workerKind: 'worker',
    recipe: { kind: 'gather', resource: 'goldDep', output: 'gold', radius: 4, workTicks: 5 * S },
    nearDeposit: { resource: 'goldDep', radius: 4 },
  },
  swordsmith: {
    id: 'swordsmith',
    name: 'Swordsmith',
    requiresTech: 'ironworking' as const,
    w: 2,
    h: 2,
    cost: { bamboo: 10, stone: 6 },
    buildTicks: 20 * S,
    hp: 180,
    workerKind: 'worker',
    recipe: {
      kind: 'convert',
      inputs: { iron: 2, bamboo: 1 },
      outputs: { katana: 1 },
      durationTicks: 14 * S,
    },
  },
  spearmaker: {
    id: 'spearmaker',
    name: 'Spearmaker',
    requiresTech: 'ironworking' as const,
    w: 2,
    h: 2,
    cost: { bamboo: 8, stone: 4 },
    buildTicks: 18 * S,
    hp: 160,
    workerKind: 'worker',
    recipe: {
      kind: 'convert',
      inputs: { iron: 1, bamboo: 2 },
      outputs: { yari: 1 },
      durationTicks: 10 * S,
    },
  },
  bowyer: {
    id: 'bowyer',
    name: 'Bowyer',
    requiresTech: 'archery' as const,
    w: 2,
    h: 2,
    cost: { bamboo: 8 },
    buildTicks: 18 * S,
    hp: 140,
    workerKind: 'worker',
    recipe: {
      kind: 'convert',
      inputs: { bamboo: 3 },
      outputs: { yumi: 1 },
      durationTicks: 8 * S,
    },
  },
  terakoya: {
    id: 'terakoya',
    name: 'Terakoya',
    w: 2,
    h: 2,
    cost: { bamboo: 10, stone: 4 },
    buildTicks: 20 * S,
    hp: 160,
  },
  dojo: {
    id: 'dojo',
    name: 'Dojo',
    w: 3,
    h: 3,
    cost: { bamboo: 12, stone: 8 },
    buildTicks: 25 * S,
    hp: 220,
    requiresTech: 'bushido',
    trains: [
      { unit: 'samurai', cost: { rice: 3, katana: 1 }, durationTicks: 15 * S },
      { unit: 'ashigaru', cost: { rice: 2, yari: 1 }, durationTicks: 10 * S },
      { unit: 'archer', cost: { rice: 2, yumi: 1 }, durationTicks: 12 * S },
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
    sitePriority: 3,
    noBlock: true,
    isRoad: true,
    systemOnly: true,
  },
};

export function buildingDef(id: BuildingTypeId): BuildingDef {
  return BUILDING_DEFS[id];
}
