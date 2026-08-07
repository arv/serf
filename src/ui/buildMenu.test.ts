import { describe, expect, it } from 'vitest';
import { BUILD_GROUPS, playerBuildable } from './buildMenu';
import { BUILDING_DEFS, type BuildingTypeId } from '../sim/defs/buildings';

const TYPES = Object.keys(BUILDING_DEFS) as BuildingTypeId[];
const inMenu = BUILD_GROUPS.flatMap((g) => g.types);

/**
 * The menu and the sim have to agree on what a player may build. Nothing
 * enforced that, and the gap is silent in both directions: a building the
 * sim places but no tab offers is one the player never finds (the whole
 * food chain, for three commits), and a type the sim accepts but never
 * meant to (the bandit camp, which had no systemOnly flag) is a hole no
 * button reveals.
 *
 * A fourth assertion lived here — that every entry names a type that
 * exists — and was deleted rather than kept: `inMenu` is typed
 * `BuildingTypeId[]` and `TYPES` comes from a `Record` keyed by that same
 * union, so the compiler refuses both halves before the test can run. An
 * assertion that cannot fail is worse than no assertion, because it looks
 * like coverage.
 */
describe('the build ribbon', () => {
  it('offers every building a player is allowed to place', () => {
    const missing = TYPES.filter((t) => playerBuildable(t) && !inMenu.includes(t));
    expect(missing).toEqual([]);
  });

  it('offers nothing the sim would refuse', () => {
    const refused = inMenu.filter((t) => !playerBuildable(t));
    expect(refused).toEqual([]);
  });

  it('lists each building once', () => {
    const seen = new Set<BuildingTypeId>();
    const dupes = inMenu.filter((t) => {
      if (seen.has(t)) return true;
      seen.add(t);
      return false;
    });
    expect(dupes).toEqual([]);
  });
});
