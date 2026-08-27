/**
 * Mission 1 — The Clearing: wood for the axe, stone for the hearth, beds
 * for the hands you hire.
 *
 * The tutorial's white room, and the only map in the campaign allowed to
 * be simple. Everything the first commission asks for stands inside the
 * castle's opening view, on opposite sides of it, so the lesson is read
 * off the ground rather than off the hint panel: the TREELINE to the
 * west, the STONE SHOULDER to the east, and open meadow south of the keep
 * with nothing on it — the beds go there.
 *
 * What the map deliberately does not hold: silver, gold, and any iron a
 * six-serf village could reach. One seam sits in the far north-eastern
 * hills where the eye can find it and the mission cannot, because the
 * valley should not lie about what this country holds — but a mine is not
 * this commission's business and nothing near the town invites one.
 */
import { HILL, MEADOW, Valley, type Authored } from '../kit.ts';
import { keepAnchor, keepCenter, seats } from '../layout.ts';

export function build(): Authored {
  const v = new Valley(96, 1061);
  const [start] = seats(1);
  const keep = keepCenter(start!);
  /** Everything in this recipe is said as an offset from the keep. */
  const at = (dx: number, dy: number) => ({ x: keep.x + dx, y: keep.y + dy });

  v.meadow(MEADOW, 0.055)
    // Wooded shoulders west and north, hill country east: the valley's
    // whole shape, and the reason the timber is on one side of the town
    // and the stone on the other.
    .mound(at(-24, -6), 20, 0.16)
    .mound(at(-12, 20), 14, 0.12)
    .mound(at(14, -2), 10, HILL - MEADOW, 0.14)
    .mound(at(24, -16), 15, 0.28, 0.16)
    .mound(at(20, 14), 12, 0.14)
    // The clearing itself — level ground for a keep, two huts and the
    // houses, released into the slopes around it.
    .level(keep, 9, 0.44, 5)
    // The brook off those eastern hills, running south-west to the sea,
    // with a pool at the clearing's foot: the water every valley owes its
    // fishery, a walk south of the keep and out of the town's way.
    .river([at(19, 6), at(9, 14), at(-2, 18), at(-12, 30), at(-18, 42)], 1.4, 0.09)
    .pond(at(-3, 13), 3)
    .borders({ n: 'forest', e: 'ridge', s: 'sea', w: 'forest' });

  const drowned = v.settle(keepAnchor(start!));

  // --- The woods, west ---------------------------------------------------
  // One unbroken edge of forest about nine tiles out: in the opening
  // view, clear of the ground the town needs, and one hut's reach from
  // the meadow. Two stands behind it are the rest of the mission's timber.
  v.treeline([at(-8, -18), at(-11, -6), at(-10, 6), at(-6, 16)], 4.5, 0.9);
  v.grove(at(-19, -9), 6, 0.85);
  v.grove(at(-17, 8), 5.5, 0.85);
  v.grove(at(-27, -2), 6, 0.8);
  // A birch stand across the brook, and alders along it — timber for the
  // hour after this one, and something for the eye to walk toward.
  v.grove(at(-14, 22), 5, 0.75);
  v.grove(at(11, 20), 4.5, 0.75);

  // --- The stone, east ---------------------------------------------------
  // The shoulder of the knoll comes down almost to the town: stone is in
  // the opening view, and the quarry that works it has the whole hill.
  v.outcrop(at(9, -3), 2.8, 0.9);
  v.outcrop(at(13, 3), 3, 0.85);
  v.outcrop(at(16, -8), 3.2, 0.85);
  v.outcrop(at(24, -15), 3, 0.8);
  v.outcrop(at(-21, 17), 2.4, 0.8);

  // --- What this country holds, for later --------------------------------
  v.ironSeam(120, at(27, -23));

  // The town's own meadow: the woods have an edge, and it is out here
  // rather than one stray tree from the keep's doorstep.
  v.clearing(keep, 10);
  v.noDeadWoodSites([start!]);
  v.plantBelt();
  // The keep's own ground and the meadow its first serfs stand on.
  v.clear(start!.x - 2, start!.y - 2, 7, 9);

  return {
    valley: v,
    name: 'The Clearing',
    starts: [start!],
    intent: [
      'a treeline west and a stone shoulder east, both in the opening view',
      'open meadow south of the keep — the houses go there',
      'no silver, no gold, and the only iron a valley away',
    ],
    drowned,
  };
}
