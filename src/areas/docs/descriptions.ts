import type {Enum} from '../../shared/enum.ts';
import {BUILDING_DEFS} from '../../sim/defs/buildings';
import * as BuildingTypeId from '../../sim/defs/buildingTypeIdEnum.ts';
import * as GoodId from '../../sim/defs/goodIdEnum.ts';
import * as RecipeKind from '../../sim/defs/recipeKindEnum.ts';
import {UNIT_DEFS} from '../../sim/defs/units';
import * as UnitTypeId from '../../sim/defs/unitTypeIdEnum.ts';
import type {BuildGroupLabel} from '../../ui/buildMenu';

type BuildingTypeId = Enum<typeof BuildingTypeId>;
type GoodId = Enum<typeof GoodId>;
type UnitTypeId = Enum<typeof UnitTypeId>;

/**
 * The one authored layer of the wiki: a sentence or two of flavor and
 * strategy per thing. These carry only what a table cannot.
 *
 * Where a sentence does want a number it reads it off the def rather than
 * spelling it out, because prose is exactly where a balance change goes
 * unnoticed: a description saying "ten beds" stays type-correct forever
 * after housing moves to twelve, and the guide would contradict the stats
 * card directly above it.
 *
 * Total Records on purpose: add a building, unit or good to the game and
 * this file refuses to compile until the wiki can say what it is. That is
 * the same completeness discipline BUILD_GROUPS keeps with its test, done
 * here by the type checker.
 */

/** What one turn of a building's fixed recipe yields. */
function yieldOf(building: BuildingTypeId, good: GoodId): number {
  const recipe = BUILDING_DEFS[building].recipe;
  return (
    (recipe?.kind === RecipeKind.convert ? recipe.outputs[good] : undefined) ??
    0
  );
}

/** What the Smith's recipe for `good` takes in `input`. */
function forgeCost(good: GoodId, input: GoodId): number {
  for (const option of BUILDING_DEFS[BuildingTypeId.weaponsmith]
    .recipeOptions ?? []) {
    if (option.recipe.outputs[good] !== undefined)
      return option.recipe.inputs[input] ?? 0;
  }
  return 0;
}

const BAKED = yieldOf(BuildingTypeId.bakery, GoodId.food);

/**
 * What each tab of the build ribbon is for, one sentence apiece.
 *
 * The guide groups the buildings exactly the way the ribbon does, and a
 * heading alone does not explain why a Silver Mine sits under Village or a
 * Gold Mine under Arms — the grouping is by what a building's output buys,
 * which is a rule a reader has to be told once. Keyed by BuildGroupLabel and
 * total, so a renamed or added tab cannot reach the guide unexplained.
 */
export const GROUP_DESC: Record<BuildGroupLabel, string> = {
  Village:
    'Homes, the two trades that raise them, and the Abbey — with the silver mine that pays for its research and for every hand you hire.',
  Food: 'The bread chain end to end, starting at the well that waters it, and the two that stand apart from it: the shore, which needs no chain at all, and the brewery, which bids against the mill for the same wheat.',
  Arms: 'Iron out of the hillside, into the Smith, onto a soldier. The tower and the deep gold seam come after — when there is something worth defending, and something worth gilding.',
};

export const BUILDING_DESC: Record<BuildingTypeId, string> = {
  [BuildingTypeId.storehouse]: `The keep you start with: your store of every good, ${BUILDING_DEFS[BuildingTypeId.storehouse].housing} beds, and the building you lose the game by losing. It costs nothing to raise and real stone to mend.`,
  [BuildingTypeId.banditCamp]:
    'Where the raids muster. Worldgen places it, never a player — burn it down and the raids stop coming from it.',
  [BuildingTypeId.woodcutter]:
    'The first roof in almost every opening. Its resident walks to nearby trees and carries the timber home, so site it against a forest, not a view.',
  [BuildingTypeId.quarry]:
    'Works exposed rock into building stone. Like every gatherer it must be placed where its worker can already see something to cut.',
  [BuildingTypeId.house]: `${BUILDING_DEFS[BuildingTypeId.house].housing} beds of timber and a hearth. Housing is what the whole plan grows through: cheap on purpose, so the choice is when, not whether.`,
  [BuildingTypeId.well]:
    'A shaft and a windlass, no keeper. Water is drawn by whoever comes for it, which makes the well free to run and slow to rush.',
  [BuildingTypeId.wheatFarm]:
    'Turns water into standing wheat. The head of the bread chain and the brewery both drink from it, so one farm rarely stays enough.',
  [BuildingTypeId.mill]:
    'Grinds wheat to flour on the wind — no resident. Deliberately slower than the farm that feeds it: one mill is meant to serve two.',
  [BuildingTypeId.bakery]: `Flour and water in, ${BAKED} loaves out. The far end of the bread chain and the best food rate in the game once the chain stands.`,
  [BuildingTypeId.fishery]:
    'One hut, one hand, and a pier that must touch water. Nothing goes in and food comes out slowly: the poor village’s food, ready long before the first loaf.',
  [BuildingTypeId.brewery]:
    'Wheat and water into ale, for the Abbey’s festivals and the barracks’ cask. Wants Brewing researched before the roof goes up.',
  [BuildingTypeId.ironMine]:
    'Cut into the hillside over an iron seam. Every weapon and most tools start here, which is why Ironworking gates it.',
  [BuildingTypeId.silverMine]:
    'The treasury’s mine: silver pays for recruits and for every research. Ungated — a village can dig for coin from the start.',
  [BuildingTypeId.goldMine]:
    'The deep seam, opened by Deep Mining. Gold buys nothing at market; it feeds the last and largest arms research.',
  [BuildingTypeId.weaponsmith]:
    'The Smith: the village’s only source of tools, and of every weapon. The roof is ungated so no village can lock itself out of tools — what it may forge is gated recipe by recipe.',
  [BuildingTypeId.abbey]:
    'Where research happens and where festival ale is drunk. No resident: the serf who raises it walks away a serf.',
  [BuildingTypeId.barracks]:
    'Turns bread, a forged weapon and a walking serf into a soldier. The rally flag on its door is where fresh recruits march.',
  [BuildingTypeId.guardTower]: `Stone that shoots back. ${BUILDING_DEFS[BuildingTypeId.guardTower].garrison?.capacity ?? 0} archers on the wall hit harder and further than the same number on the grass — and until archers exist, the levy drops stones.`,
  [BuildingTypeId.roadSite]:
    'A single tile of paving, placed by the Masonry road pass rather than by hand. When it finishes, the trail beneath it is stone for good.',
};

export const UNIT_DESC: Record<UnitTypeId, string> = {
  [UnitTypeId.serf]:
    'The village’s hands: hauls every good, raises every building, and becomes whatever the village needs next. No weapon, no fight.',
  [UnitTypeId.worker]:
    'A serf who took a post. Workers live at their building and work its trade; lose the building and the trade stops.',
  [UnitTypeId.knight]:
    'The heavy line. Slow to make — bread, a sword, the longest course at the barracks — and the unit that walks through spearmen.',
  [UnitTypeId.spearman]:
    'The fast, cheap soldier: first to any fight and the counter to archers. Melts against knights.',
  [UnitTypeId.archer]: `Range ${UNIT_DEFS[UnitTypeId.archer].combat?.range ?? 0} and the pick of the tower garrison. Kites knights, dies to anything light that reaches it.`,
  [UnitTypeId.bandit]:
    'The raiders’ line infantry: light, quick, and fond of buildings that cannot fight back.',
  [UnitTypeId.banditArcher]:
    'The raiders’ bow. Softer than yours, but a wave of them outranges a village with no answer.',
  [UnitTypeId.marauder]:
    'The raiders’ heavy: nearly a knight, and the sign a late wave means it. Bring bows and walls — spears are the wrong answer to armour.',
};

export const GOOD_DESC: Record<GoodId, string> = {
  [GoodId.water]:
    'Drawn at the well by whoever needs it. Bread, ale and the farm all start here.',
  [GoodId.wheat]:
    'The crop. Grinds into flour, brews into ale, and pays for the early researches.',
  [GoodId.wood]:
    'Timber from the woodcutter: the first cost of nearly every roof and the whole of a bow.',
  [GoodId.stone]: 'Quarried rock: walls, towers, millstones and roads.',
  [GoodId.iron]:
    'Ore from the iron mine. The Smith turns it into every serious weapon and tool.',
  [GoodId.silver]:
    'The coin: hires serfs and funds every research. The one good every plan runs short of.',
  [GoodId.gold]:
    'The deep metal. Exists to gild arms — the final warfare research is paid in it.',
  [GoodId.sword]: `The knight’s weapon, forged from ${forgeCost(GoodId.sword, GoodId.iron)} iron. No sword, no knight.`,
  [GoodId.spear]:
    'The spearman’s arm: iron and wood, the cheapest way to put a soldier in the field.',
  [GoodId.bow]: `${forgeCost(GoodId.bow, GoodId.wood)} wood and no iron — the weapon a poor village can still field, once Archery is read.`,
  [GoodId.ale]:
    'Brewed from wheat and water. The Abbey drinks it as festivals; the barracks as faster training.',
  [GoodId.flour]: 'Milled wheat, halfway to bread.',
  [GoodId.food]:
    'What soldiers train on and the village fights for: baked at the oven, or pulled from the shore.',
  [GoodId.axe]:
    'The woodcutter’s tool: no axe in store, no new woodcutter staffed.',
  [GoodId.pickaxe]:
    'The miner’s tool — and deliberately forged without iron, so losing every pick can never lock the mines shut for good.',
  [GoodId.scythe]:
    'The farmer’s tool. One per farm, handed back if the post is ever dismissed.',
  [GoodId.hammer]:
    'The builder’s tool, loaned rather than owned: every construction site borrows one and returns it at the topping-out. Hammers cap how many roofs rise at once.',
  [GoodId.cauldron]: 'The tool of the bakery and the brewery both.',
  [GoodId.rod]:
    'The fisher’s rod: wood only, so the shore stays reachable for a village with no ore.',
};
