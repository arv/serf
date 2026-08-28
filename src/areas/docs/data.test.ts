import { describe, expect, it } from 'vitest';
import { BUILDING_DEFS } from '../../sim/defs/buildings';
import { TICKS_PER_SECOND } from '../../sim/defs/balance';
import { GOODS, GoodId } from '../../sim/defs/goods';
import { TECH_DEFS } from '../../sim/defs/techs';
import { BUILD_GROUPS } from '../../ui/buildMenu';
import {
  ALL_BUILDINGS,
  ALL_TECHS,
  BUILDING_UNLOCKED_BY,
  CONSUMED_BY,
  PRODUCED_BY,
  TRAINED_AT,
  buildingTechGates,
  startStockOf,
  worldBuildings,
} from './data';
import { parseDocsPath } from './routes';
import { fmtSecs } from './data';
import { goodKeys } from '../../sim/defs/goods';

/**
 * The wiki derives its whole cross-reference graph from the defs, so what
 * these hold is the derivation, not the balance: every good must come from
 * somewhere and go somewhere the wiki can name, and every page the graph
 * links to must exist. A def change that breaks one of these would ship a
 * wiki page with a hole in it.
 */
describe('the docs cross-reference graph', () => {
  it('names a producer or a starting stock for every good', () => {
    const orphans = GOODS.filter(
      (g) => (PRODUCED_BY.get(g) ?? []).length === 0 && startStockOf(g) === 0,
    );
    expect(orphans).toEqual([]);
  });

  it('names a consumer for every good', () => {
    const hoarded = GOODS.filter((g) => (CONSUMED_BY.get(g) ?? []).length === 0);
    expect(hoarded).toEqual([]);
  });

  it('covers every building with the ribbon groups plus the world section', () => {
    // Against worldBuildings() itself, not a copy of its arithmetic: the
    // road was once filtered out of the catalogue and left with a page
    // nothing linked to, and a test that recomputed the same complement
    // would have stayed green through it.
    const inMenu = BUILD_GROUPS.flatMap((g) => g.types);
    expect([...inMenu, ...worldBuildings()].sort()).toEqual([...ALL_BUILDINGS].sort());
  });

  it('counts a repair bill as a use of the good', () => {
    // The castle is raised for free and mended for real timber and stone;
    // without repairCost in the graph neither page reports that use.
    for (const good of goodKeys(BUILDING_DEFS.storehouse.repairCost ?? {})) {
      const mends = (CONSUMED_BY.get(good) ?? []).filter(
        (c) => c.kind === 'repair' && c.building === 'storehouse',
      );
      expect(mends).toHaveLength(1);
    }
  });

  it('resolves every tech gate to a real tech', () => {
    for (const id of ALL_BUILDINGS) {
      for (const tech of buildingTechGates(id)) {
        expect(TECH_DEFS[tech]).toBeDefined();
      }
    }
  });

  it('agrees with the techs about who unlocks what', () => {
    // An unlockBuilding effect and the building's own requiresTech are two
    // spellings of one fact; the wiki quotes requiresTech, so the two
    // drifting apart would put a lie on a page.
    for (const [building, tech] of BUILDING_UNLOCKED_BY) {
      expect(buildingTechGates(building)).toContain(tech);
    }
  });

  it('knows where every trainable soldier is trained', () => {
    for (const id of ALL_TECHS) {
      for (const effect of TECH_DEFS[id].effects) {
        if (effect.kind === 'unlockUnit') expect(TRAINED_AT.get(effect.unit)).toBeDefined();
      }
    }
  });
});

describe('duration formatting', () => {
  it('keeps the fraction a rate is computed from', () => {
    // The woodcutter works a tile in 2.5 s; rounding that to "3 s" made the
    // card contradict the "24/min" printed beside it.
    expect(fmtSecs(2.5 * TICKS_PER_SECOND)).toBe('2.5 s');
    expect(fmtSecs(20 * TICKS_PER_SECOND)).toBe('20 s');
    expect(fmtSecs(90 * TICKS_PER_SECOND)).toBe('1 min 30 s');
  });
});

describe('the docs router', () => {
  it('parses every page kind', () => {
    expect(parseDocsPath('/docs')).toEqual({ page: 'index' });
    expect(parseDocsPath('/docs/buildings')).toEqual({ page: 'buildings' });
    expect(parseDocsPath('/docs/buildings/bakery')).toEqual({ page: 'building', id: 'bakery' });
    expect(parseDocsPath('/docs/units/knight')).toEqual({ page: 'unit', id: 'knight' });
    expect(parseDocsPath('/docs/goods/wood')).toEqual({ page: 'good', id: GoodId.wood });
    expect(parseDocsPath('/docs/techs')).toEqual({ page: 'techs' });
    expect(parseDocsPath('/docs/commands')).toEqual({ page: 'commands' });
    expect(parseDocsPath('/docs/basics')).toEqual({ page: 'basics' });
  });

  it('turns typos into the missing page, not a throw', () => {
    expect(parseDocsPath('/docs/buildings/palace').page).toBe('missing');
    expect(parseDocsPath('/docs/buildings/constructor').page).toBe('missing');
    expect(parseDocsPath('/docs/nothing').page).toBe('missing');
    expect(parseDocsPath('/docs/buildings/bakery/extra').page).toBe('missing');
  });
});
