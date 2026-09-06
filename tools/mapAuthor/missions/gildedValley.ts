/**
 * Mission 7 — The Gilded Valley: the commission you finish instead of win.
 *
 * Every other bandit mission ends at somebody's camp. This one ends at a
 * Monument, and the ground has to argue for that: the gold is the whole
 * point of the map, so it is the one seam that is nowhere near home.
 *
 * The shape is a long valley on the north-west/south-east diagonal. The
 * keep sits in the western meadow with its ordinary trades around it —
 * timber on the wooded slope behind, stone in the shoulder north, iron and
 * silver in the near hills — and the GOLD KNAP stands out at the far end,
 * a low bald rise with a level shelf beside it. That shelf is the mission:
 * three by three of flat ground within four tiles of the seam, which is
 * everything the Monument's placement rule asks for, and it is a long haul
 * from the storehouse on purpose. Sixty-odd goods have to walk there.
 *
 * The camp sits north-east, off the town-to-knap diagonal rather than on
 * it, and the same forty-four tiles from the keep as from the Monument's
 * shelf. So it threatens both the town and the haul and gates neither: a
 * player who wants to raze it may, and a player who would rather out-build
 * it may do that instead. That choice is the commission. (The distance is
 * not decoration — the shipped bandit missions both march about forty-four,
 * and a camp at twenty-five has guards whose reach covers ground the town
 * wants to work. Serfs walk into it and die by the dozen, which reads as a
 * broken economy rather than as a hard mission.)
 *
 * The gold is deliberately generous (a wide seam, not a stub): the lesson
 * is the haul and the defence of a half-built thing, not a shortage of ore.
 */
import {HILL, MEADOW, Valley, type Authored} from '../kit.ts';
import {keepAnchor, keepCenter, seats} from '../layout.ts';

export function build(): Authored {
  const v = new Valley(96, 5077);
  const [start] = seats(1);
  const keep = keepCenter(start!);
  const at = (dx: number, dy: number) => ({x: keep.x + dx, y: keep.y + dy});

  v.meadow(MEADOW, 0.05)
    // The valley walls: a wooded slope behind the town to the west, the
    // stone shoulder north, and the range the near seams come out of.
    .mound(at(-22, -6), 16, 0.26, 0.13)
    .mound(at(-6, -20), 13, 0.22, 0.12)
    .mound(at(10, -18), 11, HILL - MEADOW, 0.12)
    .mound(at(-14, 18), 12, 0.2, 0.11)
    // The gold knap, out at the far end. Low and bald — a rise you can
    // build beside rather than a peak you have to mine into.
    .mound(at(26, 22), 10, 0.22, 0.16)
    // The town floor, and the knap's own shelf. The shelf is the one piece
    // of ground this whole mission turns on: the Monument is 3x3, it is not
    // a mine, so it needs FLAT ground — and it must be within four tiles of
    // the seam below. Levelled generously so the site is a choice of a few
    // tiles rather than a single pixel-hunt.
    .level(keep, 11, 0.45, 6)
    .level(at(22, 19), 8, 0.42, 5)
    // The water: a beck down the middle of the valley, which the builders'
    // road crosses on its way out to the knap. It runs a good eight tiles
    // east of the keep — closer and it floods the town's own building
    // ground, which the audit counts and refuses.
    .river(
      [at(-2, -26), at(5, -14), at(12, -2), at(15, 10), at(18, 24), at(22, 40)],
      1.5,
      0.09,
    )
    .ford(at(16, 15), 4)
    .pond(at(-9, 9), 3.4)
    .borders({n: 'ridge', e: 'forest', s: 'sea', w: 'forest'});

  const drowned = v.settle(keepAnchor(start!));

  // --- The town's own trades ---------------------------------------------
  // Timber on the slope behind the keep, stone in the shoulder north of it.
  // Both close: this mission's walk is the one out to the gold, and a
  // player who spends it fetching firewood has learned about firewood.
  v.treeline([at(-13, -9), at(-15, 2), at(-12, 12)], 4, 0.87);
  v.grove(at(-21, -14), 5.5, 0.8);
  v.grove(at(-19, 15), 5.5, 0.78);
  v.grove(at(4, 20), 5, 0.72);
  v.grove(at(20, -12), 5, 0.7);

  // The near outcrop sits close enough that the FIRST legal quarry site out
  // of the keep — the sim will accept any flat tile, so that is a doorstep
  // one — has a real day's work inside its eight-tile reach. Further out and
  // a player who builds where the game lets them gets an idle hut.
  v.outcrop(at(-2, -6), 2.8, 0.9);
  v.outcrop(at(-4, -10), 2.8, 0.9);
  v.outcrop(at(3, -13), 3, 0.88);
  // Clear of the silver at (-8,-16): a stone outcrop dropped on a seam
  // walls its tiles in, and a miner has to be able to stand beside one.
  v.outcrop(at(-14, -11), 2.8, 0.82);
  v.outcrop(at(14, 6), 2.8, 0.8);
  v.outcrop(at(-16, 8), 2.6, 0.78);

  // --- The near seams ----------------------------------------------------
  // Silver pays for the research this mission needs and the hands that do
  // the hauling; iron tools the posts. Both in the near hills, because
  // neither is the lesson.
  v.silverSeam(150, at(-8, -16));
  v.ironSeam(160, at(11, -15));

  // --- The gold, and the whole reason for the map ------------------------
  // Wide rather than deep: the Monument wants twelve gold and a mine wants
  // somewhere to keep working while the stone is hauled. Sited on the
  // knap's south-west face so the shelf levelled above sits between the
  // seam and the town — the site a player picks is on the near side of the
  // hill, which is the side they can defend from.
  v.goldSeam(220, at(25, 21));

  // The town's own meadow: the woods have an edge, and it is out here
  // rather than one stray tree from the keep's doorstep.
  v.clearing(keep, 10);
  v.noDeadWoodSites([start!]);
  v.plantBelt();
  v.clear(start!.x - 2, start!.y - 2, 7, 9);

  return {
    valley: v,
    name: 'The Gilded Valley',
    starts: [start!],
    intent: [
      'a long valley: town west, the gold knap out at the south-east end',
      'a levelled shelf beside the seam — flat 3x3 within four tiles, which is all the Monument asks',
      'timber, stone, iron and silver all near home: the only long walk is the gold',
      'the camp north-east and 44 tiles out — equidistant from the keep and the shelf, off the diagonal, gating neither',
    ],
    drowned,
  };
}
