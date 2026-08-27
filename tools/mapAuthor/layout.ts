/**
 * Where the seats sit. Authored maps keep worldgen's own start layout —
 * solo in the middle of the valley, two seats on the classic diagonal —
 * so a mission's ground can be compared against a generated world tile
 * for tile, and so the AI's "rival doorstep" landmarks stay honest.
 */
import { DEFAULT_MAP_SIZE, marginFor } from '../../src/shared/grid.ts';
import { startLayout } from '../../src/sim/world.ts';
import type { StartSpot } from '../../src/sim/map.ts';
import type { Pt } from './kit.ts';

export const PLAY = DEFAULT_MAP_SIZE;

export function seats(count: number, play = PLAY): StartSpot[] {
  const layout = startLayout(play, marginFor(play), count);
  if (!layout) throw new Error(`no start layout for ${count} seats`);
  return layout.map(([x, y]) => ({ x, y }));
}

/** The point a castle's sight circle is stamped from — what "in the
 * opening view" is measured against. */
export function keepCenter(s: StartSpot): Pt {
  return { x: s.x + 1.5, y: s.y + 1.5 };
}

/** The tile the landmass is judged from (worldgen's plateau anchor). */
export function keepAnchor(s: StartSpot): Pt {
  return { x: s.x + 2, y: s.y + 2 };
}

/** A point `d` tiles from `c` on a compass bearing in degrees (0 = north,
 * 90 = east) — recipes read better as "the hill twelve tiles east". */
export function bearing(c: Pt, deg: number, d: number): Pt {
  const rad = (deg * Math.PI) / 180;
  return { x: c.x + Math.sin(rad) * d, y: c.y - Math.cos(rad) * d };
}
