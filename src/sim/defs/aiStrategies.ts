import type { BuildingTypeId } from './buildings.ts';
import type { TechId } from './techs.ts';
import type { UnitTypeId } from './units.ts';

/**
 * The playbooks the AI seats run.
 *
 * There used to be exactly one: the campaign bot's line, hard-coded into
 * systems/ai.ts. Every computer opponent in a skirmish therefore opened the
 * same way, researched the same three techs and marched at the same seven
 * soldiers — beat one and you had beaten all of them. A playbook is data
 * now, the brain reads it, and a seat picks one by its id.
 *
 * `steward` is that original line, kept number-for-number: it is the one
 * the winnable-campaign regression drives, so it stays the tested default
 * for seat 0 and the yardstick the other three are balanced against.
 *
 * Everything here must stay pure data — the brain runs beside the sim on
 * whichever host owns the world, and two hosts reading the same table have
 * to make the same decisions.
 */

export type AiStrategyId = 'steward' | 'warlord' | 'abbot' | 'fletcher';

/** Where a build step looks for ground: the home base, or a resource seam. */
export type BuildAnchor = 'base' | 'wood' | 'rock' | 'iron' | 'silver';

export interface BuildStep {
  type: BuildingTypeId;
  /** Standing count to maintain. Losses are rebuilt, so this is a floor. */
  count: number;
  anchor: BuildAnchor;
  /** Spiral-search radius around the anchor (the brain's default when unset). */
  radius?: number;
  /** Held back until this tech is researched. */
  after?: TechId;
  /** Held back until one of these already stands (any state). */
  needs?: BuildingTypeId;
  /** The count this step grows to once `after` of the pair is researched. */
  more?: { after: TechId; count: number };
}

export interface AiStrategy {
  id: AiStrategyId;
  /** Shown to the player when they pick their opponents. */
  name: string;
  /** One line on how this opponent plays. */
  blurb: string;

  // — Economy —
  /** Priority-ordered; the first affordable step under its count is placed. */
  build: BuildStep[];
  /** Researched in order, skipping anything whose prereqs are not in yet. */
  researchOrder: TechId[];
  /** Silver held back from hiring while research is still pending. */
  researchReserve: number;
  /** Serfs hired up to, once `growthAfter` is in. */
  serfTarget: number;
  /** Below this, hire regardless of research or gates — the panic floor. */
  survivalFloor: number;
  /** Growth waits on this tech (null hires from the first beat). */
  growthAfter: TechId | null;

  // — War —
  /** Forge assignment by smith age: recipeOptions index [spear, sword, bow].
   * Smiths past the end of the list all take the last entry. */
  weaponMix: number[];
  /** Trained in order of preference, whichever weapon is at hand first. */
  trainPreference: UnitTypeId[];
  /** Queued when no preferred weapon is around, to keep the queue warm. */
  trainFallback: UnitTypeId;
  barracksQueueDepth: number;
  /** Soldiers standing before the army marches. */
  armyAttackSize: number;
  attackCooldown: number;
  rallyCooldown: number;
  /** Go for a rival's castle even when a bandit camp is nearer. */
  prefersRivals: boolean;
  /** Recall the army home when a hostile fighter comes within this many
   * tiles of the castle. 0 leaves the army where it stands. */
  homeGuard: number;
}

/** The campaign line's build order, shared by the seats that vary from it
 * only in emphasis. Copied rather than referenced where a playbook wants
 * different counts — a build order reads better whole. */
const STEWARD_BUILD: BuildStep[] = [
  {
    type: 'woodcutter',
    count: 1,
    anchor: 'wood',
    radius: 6,
    more: { after: 'ironworking', count: 2 },
  },
  { type: 'quarry', count: 1, anchor: 'rock', radius: 6 },
  { type: 'abbey', count: 1, anchor: 'base' },
  // Silver before the barracks: the pool starts lean, so replacement hands
  // are bought — and research, weapons and hiring all drain the same purse.
  // Income first is what makes the rest of the plan affordable.
  { type: 'silverMine', count: 1, anchor: 'silver', radius: 4 },
  { type: 'barracks', count: 1, anchor: 'base', after: 'soldiery' },
  { type: 'well', count: 1, anchor: 'base' },
  { type: 'wheatFarm', count: 1, anchor: 'base' },
  { type: 'ironMine', count: 1, anchor: 'iron', radius: 4, after: 'ironworking' },
  // Weapons need somewhere to train their bearers: the smiths wait for the
  // barracks, or their wood hunger keeps it unaffordable forever (the
  // army-less death the winnable test caught).
  { type: 'weaponsmith', count: 2, anchor: 'base', after: 'ironworking', needs: 'barracks' },
];

export const AI_STRATEGIES: Record<AiStrategyId, AiStrategy> = {
  steward: {
    id: 'steward',
    name: 'The Steward',
    blurb: 'Silver first, then soldiery. Builds what it needs, marches at seven.',
    build: STEWARD_BUILD,
    researchOrder: ['soldiery', 'cobbledBoots', 'ironworking'],
    researchReserve: 10,
    serfTarget: 8,
    survivalFloor: 3,
    growthAfter: 'soldiery',
    weaponMix: [1, 0], // first smith on swords, the rest on spears
    trainPreference: ['knight'],
    trainFallback: 'spearman',
    barracksQueueDepth: 2,
    armyAttackSize: 7,
    attackCooldown: 900,
    rallyCooldown: 400,
    prefersRivals: false,
    homeGuard: 0,
  },

  warlord: {
    id: 'warlord',
    name: 'The Warlord',
    blurb: 'Forges nothing but swords, digs the iron to pay for them, and comes early.',
    build: [
      {
        type: 'woodcutter',
        count: 1,
        anchor: 'wood',
        radius: 6,
        more: { after: 'ironworking', count: 2 },
      },
      { type: 'quarry', count: 1, anchor: 'rock', radius: 6 },
      { type: 'abbey', count: 1, anchor: 'base' },
      { type: 'silverMine', count: 1, anchor: 'silver', radius: 4 },
      { type: 'barracks', count: 1, anchor: 'base', after: 'soldiery' },
      { type: 'well', count: 1, anchor: 'base' },
      { type: 'wheatFarm', count: 1, anchor: 'base' },
      // Two mines for two forges. A sword is two iron to a spear's one, so
      // an all-knight army on one seam starves the smiths and fields four
      // men instead of an army — a second mine is what makes the plan real.
      { type: 'ironMine', count: 2, anchor: 'iron', radius: 4, after: 'ironworking' },
      { type: 'weaponsmith', count: 2, anchor: 'base', after: 'ironworking', needs: 'barracks' },
    ],
    researchOrder: ['soldiery', 'cobbledBoots', 'ironworking', 'mailArmor'],
    researchReserve: 6,
    serfTarget: 9,
    survivalFloor: 3,
    growthAfter: null,
    weaponMix: [1], // every forge on swords: knights or nothing
    trainPreference: ['knight'],
    trainFallback: 'spearman',
    barracksQueueDepth: 3,
    armyAttackSize: 6,
    attackCooldown: 500,
    rallyCooldown: 300,
    prefersRivals: true,
    homeGuard: 0,
  },

  abbot: {
    id: 'abbot',
    name: 'The Abbot',
    blurb: 'Builds wide, hires deep, keeps its soldiers home — until ten of them stand.',
    build: [
      {
        type: 'woodcutter',
        count: 1,
        anchor: 'wood',
        radius: 6,
        more: { after: 'ironworking', count: 2 },
      },
      { type: 'quarry', count: 1, anchor: 'rock', radius: 6 },
      { type: 'abbey', count: 1, anchor: 'base' },
      { type: 'silverMine', count: 1, anchor: 'silver', radius: 4 },
      { type: 'barracks', count: 1, anchor: 'base', after: 'soldiery' },
      { type: 'well', count: 1, anchor: 'base' },
      { type: 'wheatFarm', count: 1, anchor: 'base' },
      { type: 'ironMine', count: 1, anchor: 'iron', radius: 4, after: 'ironworking' },
      { type: 'weaponsmith', count: 2, anchor: 'base', after: 'ironworking', needs: 'barracks' },
      // The wide half of the plan waits for the iron chain to stand: hired
      // hands eat, and a second field is only worth its worker once there
      // are hands to spare.
      { type: 'wheatFarm', count: 2, anchor: 'base', after: 'ironworking' },
      { type: 'well', count: 2, anchor: 'base', after: 'ironworking' },
    ],
    researchOrder: ['soldiery', 'cobbledBoots', 'ironworking', 'irrigation', 'masonry'],
    researchReserve: 10,
    serfTarget: 12,
    survivalFloor: 3,
    growthAfter: null,
    weaponMix: [1, 0],
    trainPreference: ['knight', 'spearman'],
    trainFallback: 'spearman',
    barracksQueueDepth: 2,
    armyAttackSize: 10,
    attackCooldown: 1200,
    rallyCooldown: 400,
    prefersRivals: false,
    homeGuard: 14,
  },

  fletcher: {
    id: 'fletcher',
    name: 'The Fletcher',
    blurb: 'Skips the iron chain: bows are wood, so the archers come cheap and early.',
    build: [
      {
        type: 'woodcutter',
        count: 1,
        anchor: 'wood',
        radius: 6,
        more: { after: 'archery', count: 2 },
      },
      { type: 'quarry', count: 1, anchor: 'rock', radius: 6 },
      { type: 'abbey', count: 1, anchor: 'base' },
      { type: 'silverMine', count: 1, anchor: 'silver', radius: 4 },
      { type: 'barracks', count: 1, anchor: 'base', after: 'soldiery' },
      { type: 'well', count: 1, anchor: 'base' },
      { type: 'wheatFarm', count: 1, anchor: 'base' },
      // Two forges and no mine to feed them: bowstaves are three wood
      // apiece, which is why the second woodcutter comes with the archery.
      { type: 'weaponsmith', count: 2, anchor: 'base', after: 'archery', needs: 'barracks' },
    ],
    researchOrder: ['soldiery', 'archery', 'cobbledBoots'],
    researchReserve: 8,
    serfTarget: 9,
    survivalFloor: 3,
    growthAfter: 'soldiery',
    weaponMix: [2], // every forge on bowstaves
    // The two spears in the armory arm the first pair of defenders; after
    // that the queue waits on bows, since no iron chain is coming.
    trainPreference: ['archer', 'spearman'],
    trainFallback: 'archer',
    barracksQueueDepth: 3,
    armyAttackSize: 8,
    attackCooldown: 700,
    rallyCooldown: 400,
    prefersRivals: false,
    homeGuard: 10,
  },
};

/**
 * Seat id to playbook. Seat 0 keeps the tested campaign line (it is the
 * solo player's seat, and the one the winnable regression drives); the rest
 * get a playbook each, so a three-opponent skirmish is three different
 * games. Deterministic on purpose — every host must seat the same brains.
 */
export const AI_STRATEGY_ORDER: AiStrategyId[] = ['steward', 'warlord', 'abbot', 'fletcher'];

export function strategyForSeat(playerId: number): AiStrategy {
  const id = AI_STRATEGY_ORDER[playerId % AI_STRATEGY_ORDER.length]!;
  return AI_STRATEGIES[id];
}
