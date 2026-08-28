/**
 * Mission 2 — Bread and Water: water and wheat, mill and oven.
 *
 * A river valley, and the river is the lesson. It falls out of the
 * northern range, swings past the town and widens to the sea in the
 * south, and the whole chain the commission asks for lies along it in
 * the order it is built: the WELL on the near bank, the FLATS below the
 * town for the field, the MILL RISE above them, and the keep itself a
 * short haul from all three — a bakery wants to be near what it feeds.
 *
 * The valley is deliberately lopsided. Everything green is east and
 * south, on the water; the west is a wooded slope with the timber and
 * the stone on it. A player who has only ever built a woodcutter reads
 * that as two errands rather than one sprawl.
 */
import {HILL, MEADOW, RISE, Valley, type Authored} from '../kit.ts';
import {keepAnchor, keepCenter, seats} from '../layout.ts';

export function build(): Authored {
  const v = new Valley(96, 2027);
  const [start] = seats(1);
  const keep = keepCenter(start!);
  const at = (dx: number, dy: number) => ({x: keep.x + dx, y: keep.y + dy});

  v.meadow(MEADOW, 0.05)
    // The country: a wooded ridge shouldering in from the west, high
    // ground in the north the river comes out of, and a long fall to the
    // south where the sea is.
    .ridge([at(-30, -20), at(-22, 0), at(-26, 22)], 12, HILL - MEADOW, 0.3)
    .mound(at(-2, -26), 20, 0.26, 0.12)
    .mound(at(-11, -9), 8, RISE - MEADOW)
    .mound(at(22, -16), 12, 0.2)
    .bowl(at(8, 22), 20, 0.07)
    // The town terrace, and the flats below it: the field country, low
    // and level, with the river along its eastern edge.
    .level(keep, 9, 0.45, 5)
    .level(at(7, 13), 12, 0.36, 7)
    // The river itself, out of the northern hills and down to the sea.
    .river(
      [at(28, -28), at(17, -9), at(10, 5), at(2, 19), at(-6, 34), at(-9, 45)],
      2.2,
      0.12,
    )
    .borders({n: 'ridge', e: 'ridge', s: 'sea', w: 'forest'});

  const drowned = v.settle(keepAnchor(start!));

  // --- The wooded slope, west --------------------------------------------
  v.treeline([at(-11, -15), at(-12, -1), at(-11, 13)], 4, 0.88);
  v.grove(at(-22, -12), 6, 0.82);
  v.grove(at(-21, 9), 6, 0.82);
  v.grove(at(-14, 24), 5.5, 0.75);
  v.grove(at(4, -19), 5, 0.75);
  // A copse on the far bank — the first thing across the water.
  v.grove(at(20, 12), 5, 0.7);

  // --- Stone, on the shoulder above the town -----------------------------
  v.outcrop(at(-7, -6), 3.4, 0.95);
  v.outcrop(at(-12, -13), 3, 0.85);
  v.outcrop(at(-18, 3), 3, 0.8);
  v.outcrop(at(9, -17), 2.8, 0.8);

  // --- The hills' own business -------------------------------------------
  // Silver in the western shoulder, close enough to hire with; iron in the
  // northern range; the gold across the river, where a mission about bread
  // will not casually wander.
  v.silverSeam(150, at(-16, -6));
  v.ironSeam(150, at(9, -21));
  v.goldSeam(100, at(24, 20));

  // The town's own meadow: the woods have an edge, and it is out here
  // rather than one stray tree from the keep's doorstep.
  v.clearing(keep, 10);
  v.noDeadWoodSites([start!]);
  v.plantBelt();
  v.clear(start!.x - 2, start!.y - 2, 7, 9);

  return {
    valley: v,
    name: 'Bread and Water',
    starts: [start!],
    intent: [
      'the river is the lesson: well on the bank, field on the flats, mill on the rise',
      'green and level east and south, timber and stone on the western slope',
      'gold sits across the water — not this commission’s business',
    ],
    drowned,
  };
}
