import type {Recipe} from './defs/buildings.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as ModifierKey from './defs/modifierKeyEnum.ts';
import type * as RecipeKind from './defs/recipeKindEnum.ts';
import type {Building} from './entities.ts';
import {getModifier} from './techHelpers.ts';
import type {World} from './world.ts';

/**
 * How long one batch of this recipe takes at this building, in ticks —
 * the recipe's own length against every speed the owner has researched.
 * At least one tick: a batch that took none would emit its outputs on the
 * tick it consumed its inputs, which is not what a workshop is.
 *
 * Its own module, small on purpose. The sim stamps a batch's length at
 * the start of it (systems/production.ts) and the wire snapshot needs the
 * same arithmetic for a batch that predates the stamp, and snapshot.ts is
 * loaded from source by the menu backdrop as well as by the two things
 * that run the sim — so reaching for it must not drag the production
 * system, its pathfinding and the rest of the tick in behind it.
 */
export function batchTicks(
  world: World,
  b: Building,
  recipe: Recipe & {kind: RecipeKind.convert},
): number {
  const speedup =
    getModifier(world, b.owner, ModifierKey.workSpeed) *
    (b.type === BuildingTypeId.wheatFarm
      ? getModifier(world, b.owner, ModifierKey.farmSpeed)
      : 1) *
    (b.type === BuildingTypeId.mill || b.type === BuildingTypeId.bakery
      ? getModifier(world, b.owner, ModifierKey.foodSpeed)
      : 1) *
    (b.type === BuildingTypeId.weaponsmith
      ? getModifier(world, b.owner, ModifierKey.forgeSpeed)
      : 1);
  return Math.max(1, Math.round(recipe.durationTicks / speedup));
}
