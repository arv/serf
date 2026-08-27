/**
 * Mission 4 — Hammer and Haft: bare racks, and the Smith that fills them.
 *
 * The predecessor's valley, and it has to read as one. A closed bowl —
 * wooded slopes north and south, the eastern hill with a mine already cut
 * into it, a tarn in the western meadow — with the whole abandoned
 * village standing in the middle of it: woodcutter, quarry, house, well,
 * field, mill, oven, and the mine, none of them with a soul inside.
 *
 * So the ground has one job the other maps do not have: every one of
 * those eight huts is placed by offset from the keep, and every one has
 * to find legal ground and its own work there — timber inside the
 * woodcutter's reach, stone inside the quarry's, and the seam inside the
 * mine's. The valley floor is broad and level for exactly that reason,
 * and the iron sits a short walk east, in the hill the briefing says it
 * is in.
 */
import { HILL, MEADOW, Valley, type Authored } from '../kit.ts';
import { keepAnchor, keepCenter, seats } from '../layout.ts';

export function build(): Authored {
  const v = new Valley(96, 4049);
  const [start] = seats(1);
  const keep = keepCenter(start!);
  const at = (dx: number, dy: number) => ({ x: keep.x + dx, y: keep.y + dy });

  v.meadow(MEADOW, 0.05)
    // The bowl: wooded shoulders north and south, the ore hill east, and
    // a long open meadow west where the water is.
    .mound(at(-4, -22), 18, 0.24, 0.12)
    .mound(at(2, 24), 17, 0.2, 0.1)
    .mound(at(15, -4), 11, HILL - MEADOW, 0.12)
    .mound(at(26, 8), 13, 0.24, 0.14)
    .bowl(at(-16, 6), 12, 0.06)
    // The village floor. Broad and level, because eight inherited huts
    // are about to stand on it.
    .level(keep, 13, 0.45, 6)
    // The tarn in the western meadow — the valley's water, out of the
    // village's way but inside a fishery's walk.
    .pond(at(-12, 7), 3.6)
    .river([at(-12, 7), at(-19, 17), at(-24, 30)], 1.2, 0.06)
    .borders({ n: 'ridge', e: 'ridge', s: 'forest', w: 'sea' });

  const drowned = v.settle(keepAnchor(start!));

  // --- The woods the old woodcutter worked -------------------------------
  // Its hut stands six tiles west of the keep, and a hut only draws a
  // worker if there is timber inside eight of it.
  v.treeline([at(-10, -12), at(-12, -2), at(-11, 9)], 4, 0.85);
  v.grove(at(-19, -9), 5.5, 0.8);
  v.grove(at(-8, 17), 6, 0.8);
  v.grove(at(9, 19), 5.5, 0.75);
  v.grove(at(-21, 20), 5, 0.7);

  // --- The stone the old quarry worked -----------------------------------
  // Its hut stands five east and six north of the keep.
  v.outcrop(at(4, -8), 2.8, 0.9);
  v.outcrop(at(9, -13), 3, 0.85);
  v.outcrop(at(0, -14), 2.6, 0.85);
  v.outcrop(at(19, 8), 3, 0.8);
  v.outcrop(at(-17, -16), 2.8, 0.8);

  // --- The mine in the eastern hill --------------------------------------
  // Twelve east and three north is where the def stands the mine; the
  // seam has to be inside its reach of that, and it is the only iron in
  // the valley — the whole mission is one hill's worth of ore.
  v.ironSeam(190, at(12, -5));
  // No silver and no gold: the crown is not asking for either, and a
  // valley whose racks are bare has no business being rich.

  // The town's own meadow: the woods have an edge, and it is out here
  // rather than one stray tree from the keep's doorstep.
  v.clearing(keep, 10);
  v.noDeadWoodSites([start!]);
  v.plantBelt();
  v.clear(start!.x - 2, start!.y - 2, 7, 9);

  return {
    valley: v,
    name: 'Hammer and Haft',
    starts: [start!],
    intent: [
      'a closed bowl with the whole abandoned village standing on its floor',
      'timber west, stone north-east, the seam in the eastern hill — one hut each',
      'no silver and no gold: bare racks, one hill of iron',
    ],
    drowned,
  };
}
