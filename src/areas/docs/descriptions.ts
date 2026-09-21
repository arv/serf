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
    'Homes, housing, the Smith, the Abbey and the silver mine. These buildings support the village and its research.',
  Food: 'The bread chain starts at the well and ends at the bakery. The fishery and brewery provide two other ways to use the shore and the wheat supply.',
  Arms: 'Iron mines and military buildings. The Smith makes the weapons, while the barracks and Archery Range train soldiers.',
};

export const BUILDING_DESC: Record<BuildingTypeId, string> = {
  [BuildingTypeId.storehouse]: `Your castle stores every good and provides ${BUILDING_DEFS[BuildingTypeId.storehouse].housing} beds. Lose it and you lose the game. It costs nothing to build, but stone is needed to repair it.`,
  [BuildingTypeId.banditCamp]:
    'The bandits’ base. It is placed by the map and cannot be built by a player. Destroy it to stop the raids.',
  [BuildingTypeId.woodcutter]:
    'A worker cuts nearby trees and carries the wood home. Place it beside a forest.',
  [BuildingTypeId.quarry]:
    'A worker cuts nearby rock into building stone. Place it where the worker can reach an outcrop.',
  [BuildingTypeId.house]: `Provides ${BUILDING_DEFS[BuildingTypeId.house].housing} beds. Build houses when the village needs room for more serfs.`,
  [BuildingTypeId.well]:
    'Serfs draw water here when a farm, bakery or brewery needs it. The well has no worker.',
  [BuildingTypeId.wheatFarm]:
    'Uses water to grow wheat. Wheat goes to the mill and the brewery.',
  [BuildingTypeId.mill]:
    'Grinds wheat into flour without a worker. One mill can serve two farms.',
  [BuildingTypeId.bakery]: `Uses flour and water to make ${BAKED} food. It completes the bread chain.`,
  [BuildingTypeId.fishery]:
    'A worker catches food directly from the shore. The pier must touch water, and the fishery needs no input.',
  [BuildingTypeId.brewery]:
    'Uses wheat and water to make ale for Abbey festivals and military training. Brewing is required, and the building costs stone instead of wood.',
  [BuildingTypeId.ironMine]:
    'A worker digs iron from a nearby seam. Ironworking is required to build it.',
  [BuildingTypeId.silverMine]:
    'A worker digs silver from a nearby seam. Silver pays for recruits and research, and the mine is available from the start.',
  [BuildingTypeId.goldMine]:
    'A worker digs gold from a deep seam. Deep Mining is required. Gold pays for the Monument and Gilded Arms.',
  [BuildingTypeId.weaponsmith]:
    'The village’s source of tools and weapons. The Smith is available from the start, but research unlocks its recipes.',
  [BuildingTypeId.abbey]:
    'Research happens here, and ale delivered here starts a festival. Serfs carry research goods to the Abbey before the study begins. It has no resident.',
  [BuildingTypeId.barracks]:
    'Trains knights and spearmen from food, weapons and serfs. Soldiers finishing training march to the rally flag.',
  [BuildingTypeId.archeryRange]:
    'Trains archers from food, bows and serfs. It has its own queue, so archers and melee soldiers can train at the same time.',
  [BuildingTypeId.guardTower]: `Holds ${BUILDING_DEFS[BuildingTypeId.guardTower].garrison?.capacity ?? 0} archers. Archers on the wall shoot harder and farther. Villagers can man it with stones until archers are available.`,
  [BuildingTypeId.roadSite]:
    'A single paved tile placed with the Masonry road tool. When it finishes, the trail beneath it becomes a permanent stone road.',
  [BuildingTypeId.monument]:
    'Finish the Monument to win without destroying the bandit camp. It must stand near a gold seam. Everyone learns about it when the first stone arrives, and the unfinished building is easy to destroy.',
  [BuildingTypeId.salvage]:
    'A demolished building leaves half its materials and everything it held on the ground. Serfs can carry the goods to the castle or to a nearby site.',
};

export const UNIT_DESC: Record<UnitTypeId, string> = {
  [UnitTypeId.serf]:
    'Hauls goods, builds structures and takes the next job the village needs. A serf can attack on the A command, but is much weaker than a soldier and blocks movement while attacking.',
  [UnitTypeId.worker]:
    'A serf assigned to a building. Workers stay at their post and stop working if the building is lost.',
  [UnitTypeId.knight]:
    'A slow, heavily armored soldier. Knights are strong against spearmen.',
  [UnitTypeId.spearman]:
    'A fast, cheap soldier. Spearmen are strong against archers and weak against knights.',
  [UnitTypeId.archer]: `Has a range of ${UNIT_DEFS[UnitTypeId.archer].combat?.range ?? 0} and can serve in a tower garrison. Strong against knights, but fragile up close.`,
  [UnitTypeId.bandit]:
    'Light raider infantry. Bandits move quickly and attack buildings.',
  [UnitTypeId.banditArcher]:
    'A raider archer. A group of them can outrange an unprepared village.',
  [UnitTypeId.marauder]:
    'A heavily armored raider, close to a knight in strength. Use archers and walls against it.',
};

export const GOOD_DESC: Record<GoodId, string> = {
  [GoodId.water]:
    'Drawn at the well. Farms, the bakery and the brewery use it.',
  [GoodId.wheat]:
    'Grown on wheat farms. The mill uses it for flour, and the brewery uses it for ale.',
  [GoodId.wood]:
    'Cut by woodcutters. Most buildings and several Smith recipes need it.',
  [GoodId.stone]:
    'Quarried rock used for buildings, towers, millstones and roads.',
  [GoodId.iron]:
    'Dug at the iron mine. The Smith uses it for weapons and tools.',
  [GoodId.silver]: 'Dug at the silver mine. Pays for serfs and research.',
  [GoodId.gold]: 'Dug at the gold mine. Pays for the Monument and Gilded Arms.',
  [GoodId.sword]: `The knight’s weapon, forged from ${forgeCost(GoodId.sword, GoodId.iron)} iron.`,
  [GoodId.spear]: 'The spearman’s weapon, forged from iron and wood.',
  [GoodId.bow]: `${forgeCost(GoodId.bow, GoodId.wood)} wood and no iron. The Smith makes it after Archery is researched.`,
  [GoodId.ale]:
    'Brewed from wheat and water. The Abbey uses it for festivals, and military buildings use it for faster training after Ale Rations.',
  [GoodId.flour]: 'Milled wheat used by the bakery.',
  [GoodId.food]:
    'Made at the bakery or fishery. Soldiers train on it, and miners eat it.',
  [GoodId.axe]: 'The woodcutter’s tool. A woodcutter needs one to work.',
  [GoodId.pickaxe]:
    'The quarry and miner’s tool. Forged from wood and stone, so mines can always be restarted.',
  [GoodId.scythe]: 'The wheat farmer’s tool. One farm needs one scythe.',
  [GoodId.hammer]:
    'A construction tool. Each building site borrows one until construction is complete.',
  [GoodId.cauldron]: 'The bakery and brewery use this tool.',
  [GoodId.rod]:
    'The fishery’s tool. Forged from wood alone, so fishing remains available without iron.',
};
