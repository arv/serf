import { describe, expect, it } from 'vitest';
import { BUILDING_DEFS } from '../../sim/defs/buildings';
import { GOODS } from '../../sim/defs/goods';
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
} from './data';
import { parseDocsPath } from './routes';

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
    // BuildingsPage renders BUILD_GROUPS and derives the rest. Every
    // building has a page, so every building needs a tile pointing at it —
    // a page nothing links to is a page nobody reads.
    const inMenu = new Set(BUILD_GROUPS.flatMap((g) => g.types));
    const world = ALL_BUILDINGS.filter((id) => !inMenu.has(id));
    expect([...inMenu, ...world].sort()).toEqual([...ALL_BUILDINGS].sort());
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

describe('the docs router', () => {
  it('parses every page kind', () => {
    expect(parseDocsPath('/docs')).toEqual({ page: 'index' });
    expect(parseDocsPath('/docs/buildings')).toEqual({ page: 'buildings' });
    expect(parseDocsPath('/docs/buildings/bakery')).toEqual({ page: 'building', id: 'bakery' });
    expect(parseDocsPath('/docs/units/knight')).toEqual({ page: 'unit', id: 'knight' });
    expect(parseDocsPath('/docs/goods/wood')).toEqual({ page: 'good', id: 'wood' });
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
