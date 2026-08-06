import { Rng } from '../../shared/rng.ts';
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
 * now, the brain reads it, and the map seed deals one to every AI seat.
 *
 * `steward` is that original line, kept number-for-number: the yardstick
 * the other three are balanced against, and what a seat runs when a save
 * predates the deal.
 *
 * Everything here must stay pure data — the brain runs beside the sim on
 * whichever host owns the world, and two hosts reading the same table have
 * to make the same decisions.
 */

export type AiStrategyId = 'steward' | 'warlord' | 'abbot' | 'fletcher';

/** Where a build step looks for ground: the home base, a resource seam, or
 * the shore (the fishery is the only thing that wants the last one). */
export type BuildAnchor = 'base' | 'wood' | 'rock' | 'iron' | 'silver' | 'water';

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
  /**
   * Serfs hired up to, once `growthAfter` is in. Every playbook's target
   * went up by two when the food chain landed: the mill and the bakery each
   * keep a resident, so a plan that fielded an army on the old target now
   * fields one two hands short of it.
   */
  serfTarget: number;
  /** Below this, hire regardless of research or gates — the panic floor. */
  survivalFloor: number;
  /** Growth waits on this tech (null hires from the first beat). */
  growthAfter: TechId | null;
  /**
   * Housing top-up. The plan's own `house` steps carry the opening; this is
   * the standing rule for a match that outruns them, since every soldier
   * trained is another head under the cap. On a beat the build order had
   * nothing to place, a seat with fewer than this many beds standing empty
   * lays another house — counting sites, so it orders one at a time.
   */
  housingHeadroom: number;
  /** Ceiling on houses, the plan's own included. Past this the seat grows
   * by winning rather than by building. */
  houseLimit: number;

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
  // Beds, third. The castle sleeps ten and the village starts with eight,
  // so the opening's hiring is throttled to two hands until a roof goes
  // up — but the axe and the pick have to come first or there is nothing
  // to build it with.
  { type: 'house', count: 1, anchor: 'base', more: { after: 'ironworking', count: 2 } },
  { type: 'abbey', count: 1, anchor: 'base' },
  // Silver before the barracks: the pool starts lean, so replacement hands
  // are bought — and research, weapons and hiring all drain the same purse.
  // Income first is what makes the rest of the plan affordable.
  { type: 'silverMine', count: 1, anchor: 'silver', radius: 4 },
  { type: 'barracks', count: 1, anchor: 'base', after: 'soldiery' },
  { type: 'well', count: 1, anchor: 'base' },
  { type: 'wheatFarm', count: 1, anchor: 'base' },
  // Grain is no longer a war material on its own: without the mill and the
  // bakery behind it the barracks trains nobody at all. Both wait on the
  // barracks itself, though — the castle's opening stock of bread covers
  // the first defenders, and a chain built before there is anywhere to send
  // its bread just eats the wood the barracks was waiting for. (Without the
  // gate the campaign is unwinnable: the plan reaches Soldiery with the
  // mill standing and nothing left to raise a barracks with.)
  { type: 'mill', count: 1, anchor: 'base', needs: 'barracks' },
  { type: 'bakery', count: 1, anchor: 'base', needs: 'barracks' },
  { type: 'ironMine', count: 1, anchor: 'iron', radius: 4, after: 'ironworking' },
  // Weapons need somewhere to train their bearers: the smiths wait for the
  // barracks, or their wood hunger keeps it unaffordable forever (the
  // army-less death the winnable test caught).
  { type: 'weaponsmith', count: 2, anchor: 'base', after: 'ironworking', needs: 'barracks' },
  // Last in the plan, and on purpose. A shore is free food, but the brain
  // cannot tell whether it needs any: its list is unconditional, so a
  // fishery bought before the smiths is a hand and twelve wood spent on
  // food the bakery was already making. Behind everything, it is surplus.
  { type: 'fishery', count: 1, anchor: 'water', radius: 8, after: 'ironworking', needs: 'barracks' },
];

export const AI_STRATEGIES: Record<AiStrategyId, AiStrategy> = {
  steward: {
    id: 'steward',
    name: 'The Steward',
    blurb: 'Silver first, then soldiery. Builds what it needs, marches at seven.',
    build: STEWARD_BUILD,
    researchOrder: ['soldiery', 'cobbledBoots', 'ironworking'],
    researchReserve: 10,
    serfTarget: 10,
    survivalFloor: 3,
    growthAfter: 'soldiery',
    housingHeadroom: 3,
    houseLimit: 4,
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
      // Beds third, as the campaign line has them: the axe and the pick
      // first, then the roof that lets the village grow past ten.
      { type: 'house', count: 1, anchor: 'base', more: { after: 'ironworking', count: 2 } },
      { type: 'abbey', count: 1, anchor: 'base' },
      { type: 'silverMine', count: 1, anchor: 'silver', radius: 4 },
      { type: 'barracks', count: 1, anchor: 'base', after: 'soldiery' },
      { type: 'well', count: 1, anchor: 'base' },
      { type: 'wheatFarm', count: 1, anchor: 'base' },
      { type: 'mill', count: 1, anchor: 'base', needs: 'barracks' },
      { type: 'bakery', count: 1, anchor: 'base', needs: 'barracks' },
      // Two mines for two forges. A sword is two iron to a spear's one, so
      // an all-knight army on one seam starves the smiths and fields four
      // men instead of an army — a second mine is what makes the plan real.
      { type: 'ironMine', count: 2, anchor: 'iron', radius: 4, after: 'ironworking' },
      { type: 'weaponsmith', count: 2, anchor: 'base', after: 'ironworking', needs: 'barracks' },
      // Last, and only once the forges stand — see the campaign line's note.
      { type: 'fishery', count: 1, anchor: 'water', radius: 8, after: 'ironworking', needs: 'barracks' },
    ],
    researchOrder: ['soldiery', 'cobbledBoots', 'ironworking', 'mailArmor'],
    researchReserve: 6,
    serfTarget: 11,
    survivalFloor: 3,
    growthAfter: null,
    housingHeadroom: 3,
    houseLimit: 4,
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
      // Beds third, as the campaign line has them: the axe and the pick
      // first, then the roof that lets the village grow past ten.
      { type: 'house', count: 1, anchor: 'base', more: { after: 'ironworking', count: 2 } },
      { type: 'abbey', count: 1, anchor: 'base' },
      { type: 'silverMine', count: 1, anchor: 'silver', radius: 4 },
      { type: 'barracks', count: 1, anchor: 'base', after: 'soldiery' },
      { type: 'well', count: 1, anchor: 'base' },
      { type: 'wheatFarm', count: 1, anchor: 'base' },
      { type: 'mill', count: 1, anchor: 'base', needs: 'barracks' },
      { type: 'bakery', count: 1, anchor: 'base', needs: 'barracks' },
      { type: 'ironMine', count: 1, anchor: 'iron', radius: 4, after: 'ironworking' },
      { type: 'weaponsmith', count: 2, anchor: 'base', after: 'ironworking', needs: 'barracks' },
      // The wide half of the plan waits for the iron chain to stand: hired
      // hands eat, and a second field is only worth its worker once there
      // are hands to spare.
      { type: 'wheatFarm', count: 2, anchor: 'base', after: 'ironworking' },
      { type: 'well', count: 2, anchor: 'base', after: 'ironworking' },
      // The second field is where this plan's spare hand goes, which is why
      // no fishery follows it — see the Fletcher's note.
    ],
    researchOrder: ['soldiery', 'cobbledBoots', 'ironworking', 'irrigation', 'masonry'],
    // The smallest purse in the deck, on the longest research order. This is
    // the widest plan and the one that runs closest to the edge: it staffs
    // more posts than anyone, and every post is a hand that stops hauling.
    // Holding ten silver back for the next tech is how it ends up with one
    // loose serf, forty open jobs and nothing moving.
    researchReserve: 6,
    serfTarget: 14,
    survivalFloor: 3,
    growthAfter: null,
    housingHeadroom: 4,
    houseLimit: 5,
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
      // Beds third, as the campaign line has them: the axe and the pick
      // first, then the roof that lets the village grow past ten.
      { type: 'house', count: 1, anchor: 'base', more: { after: 'archery', count: 2 } },
      { type: 'abbey', count: 1, anchor: 'base' },
      { type: 'silverMine', count: 1, anchor: 'silver', radius: 4 },
      { type: 'barracks', count: 1, anchor: 'base', after: 'soldiery' },
      { type: 'well', count: 1, anchor: 'base' },
      { type: 'wheatFarm', count: 1, anchor: 'base' },
      { type: 'mill', count: 1, anchor: 'base', needs: 'barracks' },
      { type: 'bakery', count: 1, anchor: 'base', needs: 'barracks' },
      // Two forges and no mine to feed them: bowstaves are three wood
      // apiece, which is why the second woodcutter comes with the archery.
      { type: 'weaponsmith', count: 2, anchor: 'base', after: 'archery', needs: 'barracks' },
      // No fishery here, and none in the Abbot's plan either. Both run their
      // last step on a purse the iron seats never touch — the Fletcher pays
      // for bowstaves out of the same wood the shore hut wants, and the Abbot
      // is already the longest plan in the deck with no spare hand. Tried in
      // both and both stopped winning the campaign map; a seat that cannot
      // afford surplus food should not be buying any.
    ],
    researchOrder: ['soldiery', 'archery', 'cobbledBoots'],
    researchReserve: 8,
    serfTarget: 11,
    survivalFloor: 3,
    growthAfter: 'soldiery',
    housingHeadroom: 3,
    houseLimit: 4,
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

/** The deck, in the order it is written down. Shuffled before it is dealt. */
export const AI_STRATEGY_ORDER: AiStrategyId[] = ['steward', 'warlord', 'abbot', 'fletcher'];

/**
 * The playbooks in the order this seed deals them: a Fisher-Yates shuffle
 * on the map seed, so which opponents you meet is part of the valley you
 * rolled. Same seed, same valley, same three faces.
 *
 * Random, but never *unrepeatable* — the deal has to survive a save being
 * reloaded and a match resuming on a restarted server, or an opponent
 * would change its mind about how it plays halfway through. Hence a seed
 * and not a coin: the world writes the result down (PlayerState.strategy)
 * and it rides the save file from there.
 *
 * Its own Rng stream on purpose: drawing from worldgen's would shift every
 * tree and seam on the map, and the seed is a promise about the valley.
 */
export function shuffledStrategies(seed: number): AiStrategyId[] {
  const deck = [...AI_STRATEGY_ORDER];
  // A seed of 0 is a fixed point of mulberry32's first step, and 0 is what
  // an old save's missing seed looks like; the odd offset keeps that from
  // being a special case anyone has to remember.
  const rng = new Rng(((seed | 0) ^ 0x5e1f) | 0);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return deck;
}

/**
 * Resolve every seat's playbook: a seat that named one keeps it, the rest
 * are dealt from the shuffled deck in seat order. Human seats draw nothing.
 *
 * A named playbook comes out of the deck first, because three opponents
 * should be three different opponents whether they were picked or rolled.
 * (If all four are named the deck comes back whole — a fifth AI seat has
 * to repeat someone.)
 */
export function dealStrategies(
  seed: number,
  seats: { kind: 'human' | 'ai'; strategy?: AiStrategyId }[],
): (AiStrategyId | undefined)[] {
  const named = new Set(seats.filter((s) => s.kind === 'ai' && s.strategy).map((s) => s.strategy));
  const left = shuffledStrategies(seed).filter((id) => !named.has(id));
  const deck = left.length > 0 ? left : shuffledStrategies(seed);
  let dealt = 0;
  return seats.map((s) =>
    s.kind !== 'ai' ? undefined : (s.strategy ?? deck[dealt++ % deck.length]!),
  );
}

/** The playbook a seat was dealt. A save from before the deal existed has
 * none recorded: those seats run the campaign line. */
export function strategyOf(id: AiStrategyId | undefined): AiStrategy {
  return AI_STRATEGIES[id ?? 'steward'];
}

/**
 * One playbook id, or undefined for 'deal me one'. The single gate for
 * anything a player can write — a URL is hand-editable and a lobby patch
 * arrives off a socket, and neither may name a playbook that does not
 * exist. `Object.hasOwn`, because AI_STRATEGIES['constructor'] is truthy
 * through the prototype.
 */
export function parseStrategyId(raw: unknown): AiStrategyId | undefined {
  if (typeof raw !== 'string' || !Object.hasOwn(AI_STRATEGIES, raw)) return undefined;
  return raw as AiStrategyId;
}
