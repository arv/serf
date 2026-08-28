import { describe, expect, it } from 'vitest';
import {
  BUILD_GROUPS,
  BUILD_KEYS,
  buildKey,
  buildTab,
  buildingForKey,
  playerBuildable,
} from './buildMenu';
import { BUILDING_DEFS } from '../sim/defs/buildings';
import { BuildingTypeId } from '../sim/defs/buildings';
import { BUILDING_TYPES } from '../sim/defs/buildings';

const TYPES = BUILDING_TYPES;
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

/**
 * The build chord (B, then a letter). Three ways for this table to rot,
 * each of them silent at runtime: a new building joins the ribbon with no
 * letter and simply cannot be reached from the keyboard; two buildings
 * claim one letter and the second is unreachable; or a letter drifts out of
 * the name it is meant to be bolded inside, which turns a taught shortcut
 * into a parenthesised footnote.
 */
describe('the build chord', () => {
  it('gives every building in the ribbon a letter', () => {
    expect(inMenu.filter((t) => buildKey(t) === '')).toEqual([]);
  });

  it('gives no letter to anything the ribbon does not offer', () => {
    const stray = TYPES.filter((t) => BUILD_KEYS[t] !== undefined && !inMenu.includes(t));
    expect(stray).toEqual([]);
  });

  it('never spends one letter twice', () => {
    const keys = inMenu.map((t) => buildKey(t));
    expect(keys.length).toBe(new Set(keys).size);
  });

  it('picks letters the building name can bold', () => {
    const unbolded = inMenu.filter(
      (t) => !BUILDING_DEFS[t].name.toUpperCase().includes(buildKey(t)),
    );
    expect(unbolded).toEqual([]);
  });

  it('points every menu building at the tab that holds it', () => {
    // What the HUD reads when the keyboard names a building: the chord can
    // reach a mine from the Food tab, and the ribbon has to follow.
    for (const type of inMenu) {
      const i = buildTab(type);
      expect(BUILD_GROUPS[i]?.types).toContain(type);
    }
    // Storage is never in the ribbon, so nothing to show and no tab to
    // show it on — the caller's own -1 branch.
    expect(buildTab(BuildingTypeId.storehouse)).toBe(-1);
  });

  it('resolves a letter back to its building, in either case', () => {
    for (const type of inMenu) {
      expect(buildingForKey(buildKey(type))).toBe(type);
      expect(buildingForKey(buildKey(type).toLowerCase())).toBe(type);
    }
    expect(buildingForKey('Z')).toBeNull();
  });
});
