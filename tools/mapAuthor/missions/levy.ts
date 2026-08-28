/**
 * Mission 5 — The Levy: the first raid, and then the camp.
 *
 * This is the map that has to say "they are coming from over there".
 *
 * The bandit camp is pinned in the north-west (the def's campSpot), and
 * the ground between it and the town is not open valley: a rock spur
 * comes in from the western wall and a long tarn hangs off the northern
 * hills, and between them there is ONE gap — the pass the briefing talks
 * about, about eighteen tiles up the north-west diagonal from the keep.
 * Every raid walks through it, which is what makes the barracks (and the
 * tower a player thinks of on their own) a decision about a place rather
 * than a number.
 *
 * Behind the pass the valley is the comfortable one the campaign has
 * taught: the standing village south and east of the keep on level
 * ground, silver in the knoll the def puts its mine on, iron in the
 * eastern hills where the smith can reach it.
 */
import {HILL, MEADOW, PEAK, Valley, type Authored} from '../kit.ts';
import {keepAnchor, keepCenter, seats} from '../layout.ts';

export function build(): Authored {
  const v = new Valley(96, 5051);
  const [start] = seats(1);
  const keep = keepCenter(start!);
  const at = (dx: number, dy: number) => ({x: keep.x + dx, y: keep.y + dy});

  v.meadow(MEADOW, 0.05)
    // The northern hills, and the silver knoll the mission's own mine
    // stands on, eight tiles north of the keep.
    .mound(at(2, -26), 18, 0.26, 0.12)
    .mound(at(-2, -12), 8, 0.2)
    // The eastern hill country, where the iron is.
    .ridge([at(18, -14), at(24, -2), at(22, 12)], 8, HILL - MEADOW, 0.28)
    // --- The pass ---------------------------------------------------------
    // Crag, not merely height: the sim paths on the flat grid, so a
    // mountain that is only tall is a mountain raiders stroll over. A spur
    // of bare rock comes off the western wall and a second off the
    // northern hills, and they stop short of each other — that gap, up the
    // diagonal to the camp, is the road the bandits know.
    .wall([at(-40, -4), at(-30, -8), at(-19, -13)], 6, PEAK - MEADOW)
    .wall([at(-4, -34), at(-7, -28), at(-9, -22)], 6, PEAK - MEADOW)
    // The village floor, level for the ten huts that already stand on it.
    .level(keep, 12, 0.45, 6)
    // The mere south-west of the town and the beck draining out of it:
    // the valley's water, well behind the pass.
    .pond(at(-13, 8), 4.6)
    .river([at(-13, 9), at(-17, 21), at(-21, 33), at(-25, 44)], 1.3, 0.08)
    // The camp's own ground: the def pins it fifteen tiles off the corner,
    // and the western range would otherwise take it. The band eases away
    // instead, leaving the hollow in the hills the bandits sit in.
    .keepClear({x: 44.5, y: 44.5}, 8)
    .borders({n: 'ridge', e: 'forest', s: 'sea', w: 'ridge'});

  const drowned = v.settle(keepAnchor(start!));

  // --- The village's own woods and stone ---------------------------------
  v.treeline([at(-9, 6), at(-11, 16), at(-6, 26)], 4, 0.85);
  v.grove(at(-10, -4), 4.5, 0.85);
  v.grove(at(-22, 2), 5.5, 0.8);
  v.grove(at(6, 20), 5.5, 0.8);
  v.grove(at(20, 20), 5, 0.75);
  v.grove(at(-24, -26), 6, 0.75);
  // The wood the raiders come out of, this side of the pass.
  v.grove(at(-24, -20), 5, 0.7);

  v.outcrop(at(7, -7), 2.8, 0.9);
  v.outcrop(at(12, -12), 3, 0.85);
  v.outcrop(at(16, 4), 3, 0.85);
  v.outcrop(at(-4, 18), 2.8, 0.8);
  v.outcrop(at(-26, -6), 3, 0.8);

  // --- Metal -------------------------------------------------------------
  // Silver in the knoll the def's mine already stands on; iron in the
  // eastern hills, for the smith the levy is armed from.
  v.silverSeam(180, at(-1, -11));
  v.ironSeam(180, at(19, -6));
  // Gold in the wilds beyond the pass, under the bandits' own noses.
  v.goldSeam(110, at(-30, -24));

  // The town's own meadow: the woods have an edge, and it is out here
  // rather than one stray tree from the keep's doorstep.
  v.clearing(keep, 10);
  v.noDeadWoodSites([start!]);
  v.plantBelt();
  v.clear(start!.x - 2, start!.y - 2, 7, 9);
  // The camp's ground: the def pins it, and the balance was proven with
  // the enemy standing exactly there.
  v.clear(42, 42, 5, 5);

  return {
    valley: v,
    name: 'The Levy',
    starts: [start!],
    intent: [
      'one gap between the western spur and the northern tarn — every raid walks it',
      'the standing village on level ground south and east of the keep',
      'silver in the knoll the def mines, iron in the eastern hills, gold past the pass',
    ],
    drowned,
  };
}
