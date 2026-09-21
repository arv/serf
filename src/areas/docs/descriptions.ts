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
    'Homes, the two trades that raise them, and the Smith that tools every other. With them go the Abbey and the silver mine that pays for its research and for every hand you hire.',
  Food: 'The bread chain end to end, from the well that waters it to the oven. Two stand outside it: the fishery, which needs no chain at all, and the brewery, which bids against the mill for the same wheat.',
  Arms: 'Iron out of the hillside, and the two yards that make soldiers of what the Smith forges. The tower and the deep gold seam come later, when there is something worth defending and something worth gilding.',
};

export const BUILDING_DESC: Record<BuildingTypeId, string> = {
  [BuildingTypeId.storehouse]: `Your castle. It holds every good, sleeps ${BUILDING_DEFS[BuildingTypeId.storehouse].housing}, and losing it loses the game. Nothing to raise, and real stone to mend.`,
  [BuildingTypeId.banditCamp]:
    'Where the raids muster. The map places it and no player can. Burn it down and the raids stop coming from it.',
  [BuildingTypeId.woodcutter]:
    'Its resident walks to nearby trees and carries the timber home, so site it against a forest rather than a view.',
  [BuildingTypeId.quarry]:
    'Works exposed rock into building stone. Like every gatherer, it needs something already in reach before it will go up.',
  [BuildingTypeId.house]: `${BUILDING_DEFS[BuildingTypeId.house].housing} more beds. Cheap on purpose, so the question is when rather than whether.`,
  [BuildingTypeId.well]:
    'A shaft and a windlass, with nobody posted to it. Whoever needs water comes and draws it.',
  [BuildingTypeId.wheatFarm]:
    'Water in, standing wheat out. The mill and the brewery both draw on it, so one farm rarely stays enough.',
  [BuildingTypeId.mill]:
    'Grinds wheat into flour, and keeps no resident. It is slower than the farm feeding it by design, so one mill serves two.',
  [BuildingTypeId.bakery]: `Flour and water in, ${BAKED} food out. The far end of the bread chain, and the best food rate in the game once the chain stands.`,
  [BuildingTypeId.fishery]:
    'One hut, one hand, and a pier that has to touch water. Nothing goes in, and food comes out slowly.',
  [BuildingTypeId.brewery]:
    'Wheat and water into ale, for the Abbey’s festivals and for the casks at the barracks and the range. It wants Brewing studied first, and it is priced in stone rather than wood.',
  [BuildingTypeId.ironMine]:
    'Cut into the hillside over an iron seam. Ironworking gates it, because every weapon and most tools start here.',
  [BuildingTypeId.silverMine]:
    'The treasury. Silver pays for recruits and for every study, and nothing gates the mine, so a village can dig for coin from the first minute.',
  [BuildingTypeId.goldMine]:
    'The deep seam, opened by Deep Mining. Its gold has two buyers and no others: the Monument, and Gilded Arms.',
  [BuildingTypeId.weaponsmith]:
    'The only place tools and weapons come from. The roof is ungated so no village can lock itself out of tools, and the recipes are gated one at a time instead.',
  [BuildingTypeId.abbey]:
    'Where research happens, and where delivered ale becomes a festival. A study’s goods are carried here before the books open, so keep it within reach of your serfs. No resident.',
  [BuildingTypeId.barracks]:
    'Bread, a forged weapon and a walking serf make a knight or a spearman. The rally flag on its door is where the finished ones march.',
  [BuildingTypeId.archeryRange]:
    'Bread, a bow and a serf make an archer, on a queue of its own. Bows and steel muster side by side rather than one behind the other.',
  [BuildingTypeId.guardTower]: `${BUILDING_DEFS[BuildingTypeId.guardTower].garrison?.capacity ?? 0} archers on the roof, hitting harder and farther than the same number on the grass. Until one is free, the levy holds it with stones.`,
  [BuildingTypeId.roadSite]:
    'A single tile of paving, placed by the Masonry road pass rather than by hand. When it finishes, the trail beneath it is stone for good.',
  [BuildingTypeId.monument]:
    'The other way to win: finish it and the valley is yours without razing a thing. It stands by the gold seam, every rival is told the moment the first load lands, and a half-built one has a fifth of its finished hit points.',
  [BuildingTypeId.salvage]:
    'What a demolition leaves behind: half the materials and everything the building held, piled where it stood. Serfs cart it to the stores, or a nearby site draws on it directly.',
};

export const UNIT_DESC: Record<UnitTypeId, string> = {
  [UnitTypeId.serf]:
    'Hauls every good, raises every building, and takes whatever post the village needs next. Order him to attack (A) and he fights far worse than any soldier, and takes up room on the field for as long as that order stands.',
  [UnitTypeId.worker]:
    'A serf who took a post. He lives at his building and works its trade, and the trade stops with the building.',
  [UnitTypeId.knight]:
    'The heavy line. Slow, armored, and the unit that walks through spearmen.',
  [UnitTypeId.spearman]:
    'Fast and cheap, first to any fight, and the counter to archers. Melts against knights.',
  [UnitTypeId.archer]: `Range ${UNIT_DEFS[UnitTypeId.archer].combat?.range ?? 0}, and the pick of a tower garrison. Kites knights, and dies to anything light that reaches it.`,
  [UnitTypeId.bandit]:
    'The raiders’ line infantry. Light, quick, and fond of buildings that cannot fight back.',
  [UnitTypeId.banditArcher]:
    'The raiders’ bow. Softer than yours, but a wave of them still outranges a village with no answer.',
  [UnitTypeId.marauder]:
    'The raiders’ heavy, near enough a knight, and the sign a late wave means it. Bring bows and walls, because spears are the wrong answer to armor.',
};

export const GOOD_DESC: Record<GoodId, string> = {
  [GoodId.water]: 'Drawn at the well. Bread, ale and the farm all start here.',
  [GoodId.wheat]: 'The crop. It grinds into flour and it brews into ale.',
  [GoodId.wood]:
    'Timber from the woodcutter. The first cost of nearly every roof, and the whole of a bow.',
  [GoodId.stone]: 'Quarried rock. Walls, towers, millstones and roads.',
  [GoodId.iron]:
    'Ore out of the iron mine. The Smith turns it into every serious weapon and most tools.',
  [GoodId.silver]:
    'The coin. It hires serfs and funds every study, and it is the one good every plan runs short of.',
  [GoodId.gold]:
    'The deep metal. It pays for the Monument and for Gilded Arms, and for nothing else.',
  [GoodId.sword]: `The knight’s weapon, ${forgeCost(GoodId.sword, GoodId.iron)} iron to a haft. No sword, no knight.`,
  [GoodId.spear]:
    'The spearman’s arm. Iron and wood, and the cheapest way to put a soldier in the field.',
  [GoodId.bow]: `${forgeCost(GoodId.bow, GoodId.wood)} wood and no iron, once Archery is read. The weapon a poor village can still field.`,
  [GoodId.ale]:
    'Brewed from wheat and water. The Abbey drinks it as festivals, and with Ale Rations the barracks and the range drink it as faster training.',
  [GoodId.flour]: 'Milled wheat, halfway to bread. Only the bakery wants it.',
  [GoodId.food]:
    'What soldiers train on and the village fights for. Baked at the oven, or pulled off the shore.',
  [GoodId.axe]:
    'The woodcutter’s tool. No axe in store, no new woodcutter staffed.',
  [GoodId.pickaxe]:
    'The digging tool, for the quarry and every mine. Wood and stone, never iron, so losing every pick can never lock the mines shut for good.',
  [GoodId.scythe]:
    'The farmer’s tool. One per farm, handed back if the post is ever dismissed.',
  [GoodId.hammer]:
    'The builder’s tool, loaned rather than owned. Every site borrows one and returns it at the topping-out, so hammers cap how many roofs rise at once.',
  [GoodId.cauldron]: 'The tool of the bakery and the brewery both.',
  [GoodId.rod]:
    'The fisher’s rod. Wood only, so the shore stays reachable for a village with no ore.',
};
