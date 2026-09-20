import {describe, expect, it} from 'vitest';
import type {Enum} from '../shared/enum.ts';
import {BUILDING_DEFS, BUILDING_TYPES} from '../sim/defs/buildings';
import * as BuildingTypeId from '../sim/defs/buildingTypeIdEnum.ts';
import {
  BUILD_GROUPS,
  BUILD_KEYS,
  buildKey,
  buildTab,
  buildingForKey,
  playerBuildable,
  tabForScroll,
} from './buildMenu';

type BuildingTypeId = Enum<typeof BuildingTypeId>;

const TYPES = BUILDING_TYPES;
const inMenu = BUILD_GROUPS.flatMap(g => g.types);

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
    const missing = TYPES.filter(
      t => playerBuildable(t) && !inMenu.includes(t),
    );
    expect(missing).toEqual([]);
  });

  it('offers nothing the sim would refuse', () => {
    const refused = inMenu.filter(t => !playerBuildable(t));
    expect(refused).toEqual([]);
  });

  it('lists each building once', () => {
    const seen = new Set<BuildingTypeId>();
    const dupes = inMenu.filter(t => {
      if (seen.has(t)) return true;
      seen.add(t);
      return false;
    });
    expect(dupes).toEqual([]);
  });

  /**
   * The frame is three columns and two rows deep (Hud.tsx), so six cells is
   * a tab's worth. A seventh hides nothing — the frame takes its height
   * from the tallest page and grows a row — but it grows for all three at
   * once, so the two tabs that did not need the row carry it empty. Arms
   * stood at seven and that is exactly what it cost.
   *
   * Nothing else here can catch that: every other assertion in this file
   * reads the groups back against themselves, so any arrangement of any
   * size is self-consistent and green.
   */
  it('gives no tab more than the frame holds', () => {
    const over = BUILD_GROUPS.filter(g => g.types.length > 6).map(g => ({
      tab: g.label,
      count: g.types.length,
    }));
    expect(over).toEqual([]);
  });

  /**
   * The one placement in the ribbon that is filed by who comes looking
   * rather than by what the building makes (the reasoning is in
   * buildMenu.ts). Sorting the Smith by its output puts it back on Arms
   * beside the spears, which reads perfectly sensible in a diff and takes
   * the village's only tool source off the tab a new player opens first.
   */
  it('keeps the Smith on the tab a new village opens', () => {
    expect(buildTab(BuildingTypeId.weaponsmith)).toBe(
      BUILD_GROUPS.findIndex(g => g.label === 'Village'),
    );
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
    expect(inMenu.filter(t => buildKey(t) === '')).toEqual([]);
  });

  it('gives no letter to anything the ribbon does not offer', () => {
    const stray = TYPES.filter(
      t => BUILD_KEYS[t] !== undefined && !inMenu.includes(t),
    );
    expect(stray).toEqual([]);
  });

  it('never spends one letter twice', () => {
    const keys = inMenu.map(t => buildKey(t));
    expect(keys.length).toBe(new Set(keys).size);
  });

  it('picks letters the building name can bold', () => {
    const unbolded = inMenu.filter(
      t => !BUILDING_DEFS[t].name.toUpperCase().includes(buildKey(t)),
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

/**
 * The swipe, as arithmetic. The gesture itself is the browser's — CSS
 * scroll snapping moves the pages and decides which one a fling lands on
 * — and all this has to get right is reading the answer back off the
 * scroll offset so the tab strip agrees with what the player is looking
 * at. Getting it wrong is silent in the worst way: the ribbon shows Arms
 * and the strip says Food, and every tap on the strip from then on is
 * aimed at the wrong tab.
 */
describe('the swiped ribbon', () => {
  const N = BUILD_GROUPS.length;
  const W = 300;

  it('names the tab each page is parked on', () => {
    for (let i = 0; i < N; i++) expect(tabForScroll(i * W, W, N)).toBe(i);
  });

  it('crosses to the next tab at the halfway mark', () => {
    // Where a released swipe snaps to, near enough, so this is where the
    // highlight should move — not at the first pixel and not at the last.
    expect(tabForScroll(0.49 * W, W, N)).toBe(0);
    expect(tabForScroll(0.51 * W, W, N)).toBe(1);
    expect(tabForScroll(1.51 * W, W, N)).toBe(2);
  });

  it('stays inside the ribbon when the scroller overshoots', () => {
    // Rubber-band on a touchscreen scrolls past both ends, and the index
    // it computes there is a tab that does not exist. BUILD_GROUPS[-1] is
    // undefined and the card renders empty.
    expect(tabForScroll(-80, W, N)).toBe(0);
    expect(tabForScroll((N - 1) * W + 80, W, N)).toBe(N - 1);
  });

  it('answers a ribbon nobody has measured yet with the first tab', () => {
    // A folded card has no layout, so clientWidth is 0 and the division
    // is NaN — which would clamp to NaN and index nothing at all.
    expect(tabForScroll(0, 0, N)).toBe(0);
    expect(tabForScroll(600, 0, N)).toBe(0);
    expect(tabForScroll(0, W, 0)).toBe(0);
  });
});
