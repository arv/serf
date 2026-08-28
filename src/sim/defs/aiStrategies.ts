import { Rng } from '../../shared/rng.ts';
import type { Enum } from '../../shared/enum.ts';
import * as AiStrategyIdNs from './aiStrategyIdEnum.ts';

export type AiStrategyId = Enum<typeof AiStrategyIdNs>;
import * as BuildAnchorNs from './buildAnchorEnum.ts';
import * as UnitTypeId from './unitTypeIdEnum.ts';
import * as BuildingTypeId from './buildingTypeIdEnum.ts';
import * as TechId from './techIdEnum.ts';
import * as PlayerKind from '../playerKindEnum.ts';

type BuildingTypeId = Enum<typeof BuildingTypeId>;
type PlayerKind = Enum<typeof PlayerKind>;
type TechId = Enum<typeof TechId>;
type UnitTypeId = Enum<typeof UnitTypeId>;

export type BuildAnchor = Enum<typeof BuildAnchorNs>;

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

/** Where a build step looks for ground: the home base, a resource seam, or
 * the shore (the fishery is the only thing that wants the last one).
 *
 * `gold` is not a seam like the others, and a plan that anchors on it should
 * know why: worldgen puts the gold in the middle of the map with the bandit
 * camp (mapFairness.test.ts), so it is the one anchor that reliably sends a
 * builder out of his own valley. Measured from the castle it is about as
 * near as the silver on a solo campaign map — where the base sits at the
 * centre itself — and roughly twice as far in a four-seat game, which is
 * exactly the case the balance sweep cannot see. */

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
  /**
   * How much of his own army a captain must expect to survive the fight
   * before he will march, as a percentage (see sim/combatOdds.ts). 30 refuses
   * only routs, 60 wants a clear win, 80 wants a massacre.
   *
   * 0 is off, and every printed playbook holds it there: the seat marches on
   * headcount alone exactly as it always has, so an unadvised game is the
   * game it was before this knob existed. It earns a default by winning a
   * bake-off, not by being plausible.
   */
  marchConfidence: number;
}

/** The campaign line's build order, shared by the seats that vary from it
 * only in emphasis. Copied rather than referenced where a playbook wants
 * different counts — a build order reads better whole. */
const STEWARD_BUILD: BuildStep[] = [
  {
    type: BuildingTypeId.woodcutter,
    count: 1,
    anchor: BuildAnchorNs.wood,
    radius: 6,
    more: { after: TechId.ironworking, count: 2 },
  },
  { type: BuildingTypeId.quarry, count: 1, anchor: BuildAnchorNs.rock, radius: 6 },
  // Beds, third. The castle sleeps ten and the village starts with eight,
  // so the opening's hiring is throttled to two hands until a roof goes
  // up — but the axe and the pick have to come first or there is nothing
  // to build it with.
  {
    type: BuildingTypeId.house,
    count: 1,
    anchor: BuildAnchorNs.base,
    more: { after: TechId.ironworking, count: 2 },
  },
  { type: BuildingTypeId.abbey, count: 1, anchor: BuildAnchorNs.base },
  // Silver before the barracks: the pool starts lean, so replacement hands
  // are bought — and research, weapons and hiring all drain the same purse.
  // Income first is what makes the rest of the plan affordable.
  { type: BuildingTypeId.silverMine, count: 1, anchor: BuildAnchorNs.silver, radius: 4 },
  { type: BuildingTypeId.barracks, count: 1, anchor: BuildAnchorNs.base, after: TechId.soldiery },
  { type: BuildingTypeId.well, count: 1, anchor: BuildAnchorNs.base },
  { type: BuildingTypeId.wheatFarm, count: 1, anchor: BuildAnchorNs.base },
  // Grain is no longer a war material on its own: without the mill and the
  // bakery behind it the barracks trains nobody at all. Both wait on the
  // barracks itself, though — the castle's opening stock of bread covers
  // the first defenders, and a chain built before there is anywhere to send
  // its bread just eats the wood the barracks was waiting for. (Without the
  // gate the campaign is unwinnable: the plan reaches Soldiery with the
  // mill standing and nothing left to raise a barracks with.)
  {
    type: BuildingTypeId.mill,
    count: 1,
    anchor: BuildAnchorNs.base,
    needs: BuildingTypeId.barracks,
  },
  {
    type: BuildingTypeId.bakery,
    count: 1,
    anchor: BuildAnchorNs.base,
    needs: BuildingTypeId.barracks,
  },
  {
    type: BuildingTypeId.ironMine,
    count: 1,
    anchor: BuildAnchorNs.iron,
    radius: 4,
    after: TechId.ironworking,
  },
  // Weapons need somewhere to train their bearers: the smiths wait for the
  // barracks, or their wood hunger keeps it unaffordable forever (the
  // army-less death the winnable test caught).
  {
    type: BuildingTypeId.weaponsmith,
    count: 2,
    anchor: BuildAnchorNs.base,
    after: TechId.ironworking,
    needs: BuildingTypeId.barracks,
  },
  // Last in the plan, and on purpose. A shore is free food, but the brain
  // cannot tell whether it needs any: its list is unconditional, so a
  // fishery bought before the smiths is a hand and twelve wood spent on
  // food the bakery was already making. Behind everything, it is surplus.
  {
    type: BuildingTypeId.fishery,
    count: 1,
    anchor: BuildAnchorNs.water,
    radius: 8,
    after: TechId.ironworking,
    needs: BuildingTypeId.barracks,
  },
];

export const AI_STRATEGIES: Record<AiStrategyId, AiStrategy> = {
  [AiStrategyIdNs.steward]: {
    id: AiStrategyIdNs.steward,
    name: 'The Steward',
    blurb: 'Silver first, then soldiery. Builds what it needs, marches at seven.',
    build: STEWARD_BUILD,
    researchOrder: [TechId.soldiery, TechId.cobbledBoots, TechId.ironworking],
    researchReserve: 10,
    serfTarget: 10,
    survivalFloor: 3,
    growthAfter: TechId.soldiery,
    housingHeadroom: 3,
    houseLimit: 4,
    weaponMix: [1, 0], // first smith on swords, the rest on spears
    trainPreference: [UnitTypeId.knight],
    trainFallback: UnitTypeId.spearman,
    barracksQueueDepth: 2,
    armyAttackSize: 7,
    attackCooldown: 900,
    rallyCooldown: 400,
    prefersRivals: false,
    homeGuard: 0,
    marchConfidence: 0,
  },

  [AiStrategyIdNs.warlord]: {
    id: AiStrategyIdNs.warlord,
    name: 'The Warlord',
    blurb: 'Forges nothing but swords, comes early — and gilds them in gold if the war runs long.',
    build: [
      {
        type: BuildingTypeId.woodcutter,
        count: 1,
        anchor: BuildAnchorNs.wood,
        radius: 6,
        more: { after: TechId.ironworking, count: 2 },
      },
      { type: BuildingTypeId.quarry, count: 1, anchor: BuildAnchorNs.rock, radius: 6 },
      // Beds third, as the campaign line has them: the axe and the pick
      // first, then the roof that lets the village grow past ten.
      {
        type: BuildingTypeId.house,
        count: 1,
        anchor: BuildAnchorNs.base,
        more: { after: TechId.ironworking, count: 2 },
      },
      { type: BuildingTypeId.abbey, count: 1, anchor: BuildAnchorNs.base },
      { type: BuildingTypeId.silverMine, count: 1, anchor: BuildAnchorNs.silver, radius: 4 },
      {
        type: BuildingTypeId.barracks,
        count: 1,
        anchor: BuildAnchorNs.base,
        after: TechId.soldiery,
      },
      { type: BuildingTypeId.well, count: 1, anchor: BuildAnchorNs.base },
      { type: BuildingTypeId.wheatFarm, count: 1, anchor: BuildAnchorNs.base },
      {
        type: BuildingTypeId.mill,
        count: 1,
        anchor: BuildAnchorNs.base,
        needs: BuildingTypeId.barracks,
      },
      {
        type: BuildingTypeId.bakery,
        count: 1,
        anchor: BuildAnchorNs.base,
        needs: BuildingTypeId.barracks,
      },
      // Two mines for two forges. A sword is two iron to a spear's one, so
      // an all-knight army on one seam starves the smiths and fields four
      // men instead of an army — a second mine is what makes the plan real.
      {
        type: BuildingTypeId.ironMine,
        count: 2,
        anchor: BuildAnchorNs.iron,
        radius: 4,
        after: TechId.ironworking,
      },
      {
        type: BuildingTypeId.weaponsmith,
        count: 2,
        anchor: BuildAnchorNs.base,
        after: TechId.ironworking,
        needs: BuildingTypeId.barracks,
      },
      // The gold, and only on this seat. Gold has exactly one sink in the
      // whole game — Gilded Arms, 4 of it for another 20% on every soldier's
      // health — and Gilded Arms sits behind Mail Armor, which no other
      // playbook researches. A gold mine anywhere else in the deck would be
      // a hand and fourteen materials digging a good nobody can spend.
      //
      // Behind the forges on purpose: the seam is out in the middle of the
      // map (see BuildAnchor), so this is the plan's outpost, and an outpost
      // laid before the swords are being made is a rush that stopped to mine.
      {
        type: BuildingTypeId.goldMine,
        count: 1,
        anchor: BuildAnchorNs.gold,
        radius: 4,
        after: TechId.deepMining,
      },
      // Last, and only once the forges stand — see the campaign line's note.
      {
        type: BuildingTypeId.fishery,
        count: 1,
        anchor: BuildAnchorNs.water,
        radius: 8,
        after: TechId.ironworking,
        needs: BuildingTypeId.barracks,
      },
    ],
    // Deep Mining before the armor, which is not where the war techs would
    // put it: it is the seat's economy tech first and the gold's gate second.
    // Three seams stand by then — two iron and the silver — and 30% off every
    // one of them is what keeps two sword forges fed. Gilded Arms then closes
    // the line, last, because it cannot be paid for until the gold is dug.
    //
    // The tail is free, and that is the whole claim being made for it. This
    // seat takes the campaign map at a median 15_000 ticks having researched
    // three techs, so on the sweep the gold line is never reached and never
    // costs anything either: 25 campaigns in 32 on one range and 31 in 32 on
    // the other, both unchanged to the win. Where it does land is the long
    // game the sweep cannot stage — a four-seat match on seed 42 has this
    // seat through Deep Mining by tick 21_000, and left alone in a peaceful
    // world it lays the mine itself around tick 25_000. That is the case the
    // line is written for. (tools/aiLab/balance.ts)
    researchOrder: [
      TechId.soldiery,
      TechId.cobbledBoots,
      TechId.ironworking,
      TechId.deepMining,
      TechId.mailArmor,
      TechId.gildedArms,
    ],
    researchReserve: 6,
    serfTarget: 11,
    survivalFloor: 3,
    growthAfter: null,
    housingHeadroom: 3,
    houseLimit: 4,
    weaponMix: [1], // every forge on swords: knights or nothing
    trainPreference: [UnitTypeId.knight],
    trainFallback: UnitTypeId.spearman,
    barracksQueueDepth: 3,
    armyAttackSize: 6,
    attackCooldown: 500,
    rallyCooldown: 300,
    prefersRivals: true,
    homeGuard: 0,
    marchConfidence: 0,
  },

  [AiStrategyIdNs.abbot]: {
    id: AiStrategyIdNs.abbot,
    name: 'The Abbot',
    blurb: 'Builds wide, hires deep, mans two towers — and still marches at ten.',
    build: [
      {
        type: BuildingTypeId.woodcutter,
        count: 1,
        anchor: BuildAnchorNs.wood,
        radius: 6,
        more: { after: TechId.ironworking, count: 2 },
      },
      { type: BuildingTypeId.quarry, count: 1, anchor: BuildAnchorNs.rock, radius: 6 },
      // Beds third, as the campaign line has them: the axe and the pick
      // first, then the roof that lets the village grow past ten.
      {
        type: BuildingTypeId.house,
        count: 1,
        anchor: BuildAnchorNs.base,
        more: { after: TechId.ironworking, count: 2 },
      },
      { type: BuildingTypeId.abbey, count: 1, anchor: BuildAnchorNs.base },
      { type: BuildingTypeId.silverMine, count: 1, anchor: BuildAnchorNs.silver, radius: 4 },
      {
        type: BuildingTypeId.barracks,
        count: 1,
        anchor: BuildAnchorNs.base,
        after: TechId.soldiery,
      },
      { type: BuildingTypeId.well, count: 1, anchor: BuildAnchorNs.base },
      { type: BuildingTypeId.wheatFarm, count: 1, anchor: BuildAnchorNs.base },
      {
        type: BuildingTypeId.mill,
        count: 1,
        anchor: BuildAnchorNs.base,
        needs: BuildingTypeId.barracks,
      },
      {
        type: BuildingTypeId.bakery,
        count: 1,
        anchor: BuildAnchorNs.base,
        needs: BuildingTypeId.barracks,
      },
      {
        type: BuildingTypeId.ironMine,
        count: 1,
        anchor: BuildAnchorNs.iron,
        radius: 4,
        after: TechId.ironworking,
      },
      {
        type: BuildingTypeId.weaponsmith,
        count: 2,
        anchor: BuildAnchorNs.base,
        after: TechId.ironworking,
        needs: BuildingTypeId.barracks,
      },
      // The towers this plan is now built around, and the reason it learns
      // archery at all. Two of them, still gated on the bow now that the
      // levy means a tower is never merely wasted stone — because moving
      // the gate back to soldiery measures worse, not better, and does so
      // on both seed ranges independently: this seat takes 56 campaigns in
      // 64 with the early gate against 59 with this one, and the deck as a
      // whole 209 in 256 against 212. An early tower stands empty through
      // the quiet opening either way: the seat mans it once there is an
      // archer standing loose to climb it, and gating on the bow is what
      // decides when that is. (Those campaign counts were measured before
      // the halt lever took the soldiers with it; the gate they picked is
      // unchanged, the margins want re-measuring.)
      // (tools/aiLab/balance.ts)
      {
        type: BuildingTypeId.guardTower,
        count: 2,
        anchor: BuildAnchorNs.base,
        after: TechId.archery,
        needs: BuildingTypeId.barracks,
      },
      // The wide half of the plan waits for the iron chain to stand: hired
      // hands eat, and a second field is only worth its worker once there
      // are hands to spare.
      {
        type: BuildingTypeId.wheatFarm,
        count: 2,
        anchor: BuildAnchorNs.base,
        after: TechId.ironworking,
      },
      {
        type: BuildingTypeId.well,
        count: 2,
        anchor: BuildAnchorNs.base,
        after: TechId.ironworking,
      },
      // The second field is where this plan's spare hand goes, which is why
      // no fishery follows it — see the Fletcher's note.
      //
      // The ale economy, and only on this seat: the Abbot is the one plan
      // wide enough to spare the wheat, the water and the hand — its second
      // farm and well stand before Brewing lands, so the brewery drinks
      // surplus rather than the bread chain's inputs. Festivals then turns
      // that surplus into +25% work speed across the whole village.
      { type: BuildingTypeId.brewery, count: 1, anchor: BuildAnchorNs.base, after: TechId.brewing },
    ],
    researchOrder: [
      TechId.soldiery,
      TechId.cobbledBoots,
      TechId.ironworking,
      // The bow, for the towers — after the iron chain, which still arms
      // this plan's knights, and before the wide half it can take its time
      // over. Nothing else in the deck researches both lines.
      TechId.archery,
      TechId.irrigation,
      // Brewing and Festivals ahead of Masonry, where they used to sit
      // behind it. The old order was a safety rule — put the ale last so a
      // dry brewery (Festivals costs 2 ale) can never hold up a tech the war
      // effort wants — but the queue takes the FIRST unresearched tech whose
      // prereqs are in and then simply waits until it can afford that one,
      // so everything behind a slot is hostage to it either way. The choice
      // is only which tech gets the seventh slot in a campaign that ends
      // around the sixth, and paving is the right thing to lose: it is a
      // comfort, and the ale is what this seat is built around.
      //
      // Worth the demotion but not by much, and the honest numbers say so:
      // over the 64 campaigns of both sweep ranges this raises the brewery 7
      // times against the old order's 4, and takes 44 of those campaigns
      // against 46. Both movements sit inside the sweep's noise (see
      // aiLab/README.md), so what is claimed here is small: a step this plan
      // has always carried gets built about twice as often, for nothing
      // measurable off the win rate.
      //
      // What caps it is wood, not tech order, and no reordering here will
      // fix that. This seat's second forge turns every log into bowstaves
      // and does not stop for a shelf already holding eleven unclaimed bows,
      // so from about tick 12_000 the storehouse reads nought wood for the
      // rest of the match and the brewery's ten wood is simply never on it —
      // left alone in a peaceful world out to 60_000 ticks, Brewing long
      // since in, this seat still laid no brewery on any of four seeds. The
      // forge is where that wants fixing. (tools/aiLab/balance.ts)
      TechId.brewing,
      TechId.festivals,
      TechId.masonry,
    ],
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
    // Swords at the first forge, bowstaves at the second: this is the one
    // plan running two weapon lines, because it wants knights in the field
    // and archers on the walls.
    weaponMix: [1, 2],
    trainPreference: [UnitTypeId.knight, UnitTypeId.archer],
    trainFallback: UnitTypeId.archer,
    barracksQueueDepth: 2,
    // Ten, unchanged by the towers, and that is the measured answer rather
    // than the obvious one. Two towers swallow four archers outright — a
    // garrisoned man is consumed into the building and leaves the army
    // count — so the bar was raised to fourteen to buy them back. Over ten
    // seeds that cost eight thousand ticks a win (29k against 21k) and
    // bought no extra wins at all: the four are not missing from the army,
    // they are the part of it that holds the base, and a seat that waits
    // for fourteen in the field is just late. Towers at ten also beat no
    // towers at ten (21k against 23k), which is the whole case for them.
    armyAttackSize: 10,
    attackCooldown: 1200,
    rallyCooldown: 400,
    prefersRivals: false,
    homeGuard: 14,
    marchConfidence: 0,
  },

  [AiStrategyIdNs.fletcher]: {
    id: AiStrategyIdNs.fletcher,
    name: 'The Fletcher',
    blurb: 'Skips the iron chain: bows are wood, so the archers come cheap and early.',
    build: [
      {
        type: BuildingTypeId.woodcutter,
        count: 1,
        anchor: BuildAnchorNs.wood,
        radius: 6,
        more: { after: TechId.archery, count: 2 },
      },
      { type: BuildingTypeId.quarry, count: 1, anchor: BuildAnchorNs.rock, radius: 6 },
      // Beds third, as the campaign line has them: the axe and the pick
      // first, then the roof that lets the village grow past ten.
      // Two roofs, and a third is not the answer however much it looks
      // like one. It is worth six wins in 32 to this seat's solo campaign
      // under the tools economy (12 to 18) — and it makes four-seat games
      // stick: seed 42 goes from ending at 43k to not ending at 400k, and
      // two other seeds triple. A bigger village here is one nobody can
      // finish off, and the muster's impatience rule cannot break the
      // standoff that follows. Whatever fixes this seat has to leave that
      // alone. (tools/aiLab/balance.ts, and aiStrategies.test.ts's
      // four-playbook ending.)
      {
        type: BuildingTypeId.house,
        count: 1,
        anchor: BuildAnchorNs.base,
        more: { after: TechId.archery, count: 2 },
      },
      { type: BuildingTypeId.abbey, count: 1, anchor: BuildAnchorNs.base },
      { type: BuildingTypeId.silverMine, count: 1, anchor: BuildAnchorNs.silver, radius: 4 },
      {
        type: BuildingTypeId.barracks,
        count: 1,
        anchor: BuildAnchorNs.base,
        after: TechId.soldiery,
      },
      { type: BuildingTypeId.well, count: 1, anchor: BuildAnchorNs.base },
      { type: BuildingTypeId.wheatFarm, count: 1, anchor: BuildAnchorNs.base },
      {
        type: BuildingTypeId.mill,
        count: 1,
        anchor: BuildAnchorNs.base,
        needs: BuildingTypeId.barracks,
      },
      {
        type: BuildingTypeId.bakery,
        count: 1,
        anchor: BuildAnchorNs.base,
        needs: BuildingTypeId.barracks,
      },
      // Two forges and no mine to feed them: bowstaves are three wood
      // apiece, which is why the second woodcutter comes with the archery.
      {
        type: BuildingTypeId.weaponsmith,
        count: 2,
        anchor: BuildAnchorNs.base,
        after: TechId.archery,
        needs: BuildingTypeId.barracks,
      },
      // One seam, late, and not for weapons: the bows stay pure wood, but
      // axes, picks and scythes are ironwork, and a seat that cannot forge
      // them stops staffing the moment the starter kit runs dry.
      {
        type: BuildingTypeId.ironMine,
        count: 1,
        anchor: BuildAnchorNs.iron,
        radius: 4,
        after: TechId.ironworking,
      },
      // A tower, once there are bowmen to put in it. Gated on archery
      // rather than on soldiery, which for this seat is nearly the same
      // instant anyway: the bow is second in its research order, so the two
      // gates measure identically here (22/32 either way).
      //
      // The levy barely fires on this map for any seat, which is worth
      // knowing before anyone tunes for it: raids land around tick 16k and
      // a tower stands by 6-8k, so the archers all but always reach the
      // wall first — tens of ticks of villagers across a whole campaign,
      // and none at all on this seat. They are a human's answer to being
      // rushed, not the AI's.
      {
        type: BuildingTypeId.guardTower,
        count: 1,
        anchor: BuildAnchorNs.base,
        after: TechId.archery,
        needs: BuildingTypeId.barracks,
      },
      // No fishery here, and none in the Abbot's plan either. Both run their
      // last step on a purse the iron seats never touch — the Fletcher pays
      // for bowstaves out of the same wood the shore hut wants, and the Abbot
      // is already the longest plan in the deck with no spare hand. Tried in
      // both and both stopped winning the campaign map; a seat that cannot
      // afford surplus food should not be buying any.
    ],
    // Ironworking on a bow plan: not for the weapons — for the axes. Every
    // tool but the fishing rod is ironwork now, and a seat that never
    // researches it can staff nothing past the starter kit. Last, because
    // the opening kit carries the first posts and the bows cannot wait.
    researchOrder: [TechId.soldiery, TechId.archery, TechId.cobbledBoots, TechId.ironworking],
    researchReserve: 8,
    serfTarget: 11,
    survivalFloor: 3,
    growthAfter: TechId.soldiery,
    housingHeadroom: 3,
    houseLimit: 4,
    weaponMix: [2], // every forge on bowstaves
    // The spear in the armory arms the first defender; after that the queue
    // waits on bows, since no iron chain is coming.
    trainPreference: [UnitTypeId.archer, UnitTypeId.spearman],
    trainFallback: UnitTypeId.archer,
    barracksQueueDepth: 3,
    // Ten, up from eight: bows trickle out of the forges three staves at a
    // time, and a muster of eight on the campaign map marched between the
    // raid waves with too little behind it — wiped at the camp, and the
    // second wave took a castle nobody was left to hold. At ten the army
    // stays home through the first wave and razes the camp in one march,
    // before the second one spawns.
    //
    // Ten still. This is the deck's weak seat and the tools economy (#103)
    // has made it much weaker: 12 campaigns in 32 where the other three
    // take 27 apiece, dying in half its games and running out the clock in
    // five more. It is the one playbook that never touches iron, and the
    // Smith who makes every post's tools sits on the far side of that
    // chain. That is the shape of the problem; the fix is not housing (see
    // above), and it is not a third woodcutter, which is a rout at 34 wins
    // in 64 against 49 — a hand on wood is a hand off the hauling.
    //
    // The tower does not move this. Raising it to twelve to buy back the
    // two archers the garrison swallows measured as a wash over ten seeds
    // (16k either way), and on the Abbot the same instinct cost real time —
    // see the note on its muster.
    armyAttackSize: 10,
    attackCooldown: 700,
    rallyCooldown: 400,
    prefersRivals: false,
    homeGuard: 10,
    marchConfidence: 0,
  },
};

/** The deck, in the order it is written down. Shuffled before it is dealt. */
export const AI_STRATEGY_ORDER: AiStrategyId[] = [
  AiStrategyIdNs.steward,
  AiStrategyIdNs.warlord,
  AiStrategyIdNs.abbot,
  AiStrategyIdNs.fletcher,
];

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
  seats: { kind: PlayerKind; strategy?: AiStrategyId }[],
): (AiStrategyId | undefined)[] {
  const named = new Set(
    seats.filter((s) => s.kind === PlayerKind.ai && s.strategy).map((s) => s.strategy),
  );
  const left = shuffledStrategies(seed).filter((id) => !named.has(id));
  const deck = left.length > 0 ? left : shuffledStrategies(seed);
  let dealt = 0;
  return seats.map((s) =>
    s.kind !== PlayerKind.ai ? undefined : (s.strategy ?? deck[dealt++ % deck.length]!),
  );
}

/** The playbook a seat was dealt. A save from before the deal existed has
 * none recorded: those seats run the campaign line. */
export function strategyOf(id: AiStrategyId | undefined): AiStrategy {
  return AI_STRATEGIES[id ?? AiStrategyIdNs.steward];
}

/**
 * One playbook id, or undefined for 'deal me one'. The single gate for
 * anything a player can write — a URL is hand-editable and a lobby patch
 * arrives off a socket, and neither may name a playbook that does not
 * exist. `Object.hasOwn`, because AI_STRATEGIES['constructor'] is truthy
 * through the prototype.
 */
export function parseStrategyId(raw: unknown): AiStrategyId | undefined {
  if (typeof raw === 'string') return STRATEGY_BY_KEY.get(raw);
  // The id itself, for the documents this build writes out of a
  // WorldConfig (a replay's config head); ?bots and a lobby patch say the
  // word. Object.hasOwn on the key table, so no prototype row answers.
  return typeof raw === 'number' && Object.hasOwn(AI_STRATEGY_KEYS, raw)
    ? (raw as AiStrategyId)
    : undefined;
}

/**
 * The spelling of each playbook id, for the two places a person names one:
 * the ?bots parameter and the lobby's seat patches.
 */
export const AI_STRATEGY_KEYS: Readonly<Record<AiStrategyId, string>> = {
  [AiStrategyIdNs.steward]: 'steward',
  [AiStrategyIdNs.warlord]: 'warlord',
  [AiStrategyIdNs.abbot]: 'abbot',
  [AiStrategyIdNs.fletcher]: 'fletcher',
};

const STRATEGY_BY_KEY = new Map<string, AiStrategyId>(
  AI_STRATEGY_ORDER.map((id) => [AI_STRATEGY_KEYS[id], id]),
);
