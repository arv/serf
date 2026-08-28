import type { Enum } from '../../shared/enum.ts';
import {
  BUILDING_DEFS,
  type BuildingTypeId,
  buildingFromKey,
  BUILDING_KEYS,
} from '../../sim/defs/buildings';
import { GOODS, type GoodId, goodFromKey, GOOD_KEYS } from '../../sim/defs/goods';
import { UNIT_DEFS, type UnitTypeId, UNIT_KEYS, unitFromKey } from '../../sim/defs/units';
import { TECH_KEYS } from '../../sim/defs/techs';
import * as TechId from '../../sim/defs/techIdEnum.ts';

type TechId = Enum<typeof TechId>;

/**
 * What a /docs URL names. Pure — the screen feeds it location.pathname and
 * tests feed it strings. Unknown paths and unknown ids both land on
 * 'missing' rather than throwing: a docs URL is hand-editable, and the
 * right answer to a typo is a page that says so with a way back.
 */
export type DocsRoute =
  | { page: 'index' }
  | { page: 'buildings' }
  | { page: 'building'; id: BuildingTypeId }
  | { page: 'units' }
  | { page: 'unit'; id: UnitTypeId }
  | { page: 'goods' }
  | { page: 'good'; id: GoodId }
  | { page: 'techs' }
  | { page: 'commands' }
  | { page: 'basics' }
  | { page: 'missing'; path: string };

/** Own-property lookup, like sanitizeCommand's isDefined: 'constructor' is
 * truthy through the prototype and must not become a page. */
function isKeyOf<T extends object>(table: T, key: string): key is Extract<keyof T, string> {
  return Object.hasOwn(table, key);
}

export function parseDocsPath(pathname: string): DocsRoute {
  const parts = pathname.split('/').filter((p) => p !== '');
  // parts[0] is 'docs' — screenKey() only sends /docs paths here, but a
  // stray call with something else is still just a missing page.
  if (parts[0] !== 'docs') return { page: 'missing', path: pathname };
  const [, section, id, ...rest] = parts;
  if (rest.length > 0) return { page: 'missing', path: pathname };
  switch (section) {
    case undefined:
      return { page: 'index' };
    case 'buildings':
      if (id === undefined) return { page: 'buildings' };
      {
        const building = buildingFromKey(id);
        if (building !== undefined) return { page: 'building', id: building };
      }
      return { page: 'missing', path: pathname };
    case 'units':
      if (id === undefined) return { page: 'units' };
      {
        const unit = unitFromKey(id);
        if (unit !== undefined) return { page: 'unit', id: unit };
      }
      return { page: 'missing', path: pathname };
    case 'goods':
      if (id === undefined) return { page: 'goods' };
      const good = goodFromKey(id);
      if (good !== undefined) return { page: 'good', id: good };
      return { page: 'missing', path: pathname };
    case 'techs':
      if (id === undefined) return { page: 'techs' };
      return { page: 'missing', path: pathname };
    case 'commands':
      if (id === undefined) return { page: 'commands' };
      return { page: 'missing', path: pathname };
    case 'basics':
      if (id === undefined) return { page: 'basics' };
      return { page: 'missing', path: pathname };
    default:
      return { page: 'missing', path: pathname };
  }
}

export function buildingHref(id: BuildingTypeId): string {
  return `/docs/buildings/${BUILDING_KEYS[id]}`;
}
export function unitHref(id: UnitTypeId): string {
  return `/docs/units/${UNIT_KEYS[id]}`;
}
export function goodHref(id: GoodId): string {
  return `/docs/goods/${GOOD_KEYS[id]}`;
}
/** Techs share one page; a tech link is an anchor on it. */
export function techHref(id: TechId): string {
  return `/docs/techs#tech-${TECH_KEYS[id]}`;
}
