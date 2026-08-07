import { BUILDING_DEFS, type BuildingTypeId } from '../sim/defs/buildings.ts';

/**
 * The build ribbon's tabs, in the order they are shown.
 *
 * Its own module rather than a const inside Hud.tsx so the completeness
 * rule below can be tested without standing up a DOM: this list going stale
 * is silent — a building the sim will happily place that no button offers
 * is simply a building the player never discovers. The whole food chain
 * shipped that way and nobody noticed until someone went looking for the
 * mill.
 *
 * Food earns a tab of its own now that feeding an army is four buildings
 * and a well rather than one field. The well comes with them: water is an
 * input to the farm, the bakery and the brewery and to nothing else, so the
 * player building the chain finds it where the chain is.
 */
export const BUILD_GROUPS: { label: string; types: BuildingTypeId[] }[] = [
  { label: 'Village', types: ['house', 'woodcutter', 'quarry', 'abbey'] },
  { label: 'Food', types: ['well', 'wheatFarm', 'mill', 'bakery', 'fishery'] },
  {
    label: 'Industry',
    types: ['brewery', 'ironMine', 'silverMine', 'goldMine', 'weaponsmith'],
  },
  { label: 'War', types: ['barracks'] },
];

/**
 * Can a player place this at all? The same two refusals the sim applies in
 * tick.ts — storage is the elimination token and never buildable, and
 * system-only types are worldgen's or the road pass's to place. Kept beside
 * the menu because the menu is what has to agree with it.
 */
export function playerBuildable(type: BuildingTypeId): boolean {
  const def = BUILDING_DEFS[type];
  return !def.storage && !def.systemOnly;
}
