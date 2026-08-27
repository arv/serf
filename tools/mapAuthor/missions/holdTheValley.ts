/**
 * Mission 6 — Hold the Valley: the full game, no help, no headstart.
 *
 * The campaign's signature valley, and the only map here that has to hold
 * a long game rather than teach one lesson. So it is drawn as a place: a
 * western FIRTH the sea reaches in through, the river that feeds it
 * falling out of the northern woods, the town on the meadow between them,
 * hill country east with the iron in it, and — beyond the BECK and its
 * two FORDS — the south-eastern heath where the bandits camp, sitting on
 * the valley's gold.
 *
 * The beck is the map's argument. It is not a wall: two fords cross it,
 * one north and one south, so marching on the camp is a choice of road
 * and holding the valley is a question of which crossing you watch. Every
 * raid the camp sends walks one of them.
 *
 * Resources are laid at worldgen's own distances (silver and iron on the
 * mid ring, timber and stone at the town's elbow), because this map is
 * the balance the whole game is tuned against — the intent here is
 * legibility, not generosity.
 */
import { HILL, MEADOW, RISE, Valley, type Authored } from '../kit.ts';
import { keepAnchor, keepCenter, seats } from '../layout.ts';

export function build(): Authored {
  const v = new Valley(96, 6067);
  const [start] = seats(1);
  const keep = keepCenter(start!);
  const at = (dx: number, dy: number) => ({ x: keep.x + dx, y: keep.y + dy });

  v.meadow(MEADOW, 0.06)
    // The country: wooded hills north, a long hill wall east, downs
    // south-east where the camp is, and the ground falling west to the sea.
    .mound(at(-2, -28), 20, 0.26, 0.14)
    .ridge([at(26, -22), at(31, -4), at(27, 15)], 9, HILL - MEADOW, 0.3)
    .mound(at(10, 28), 18, 0.18, 0.1)
    .mound(at(-14, -12), 9, RISE - MEADOW)
    .bowl(at(-26, 2), 16, 0.08)
    // The town meadow.
    .level(keep, 10, 0.45, 6)
    // The firth: the sea reaches in from the west and stops at a broad
    // lake a quarter of the valley across, with the river out of the
    // northern woods feeding it.
    .pond(at(-24, 3), 8.5)
    .river([at(-24, 3), at(-34, 1), at(-46, -1)], 4.5)
    .river([at(-7, -29), at(-14, -17), at(-20, -6), at(-24, 2)], 1.8, 0.1)
    // The beck, out of the eastern hills and down to the southern range —
    // the line between the valley and the bandits' heath.
    .river([at(35, 2), at(26, 13), at(17, 25), at(10, 38)], 2.2, 0.12)
    .ford(at(28, 10), 3)
    .ford(at(13, 32), 3)
    .borders({ n: 'forest', e: 'ridge', s: 'ridge', w: 'sea' });

  const drowned = v.settle(keepAnchor(start!));

  // --- Timber: the northern woods come down to the town's elbow ----------
  v.treeline([at(-6, -13), at(4, -14), at(14, -12)], 4, 0.85);
  v.grove(at(-12, -20), 6, 0.8);
  v.grove(at(8, -22), 6, 0.8);
  v.grove(at(-13, 13), 5.5, 0.8);
  v.grove(at(4, 18), 5.5, 0.78);
  v.grove(at(-24, 18), 6, 0.75);
  v.grove(at(20, 30), 6, 0.7);
  v.grove(at(30, 20), 5, 0.7);

  // --- Stone: the eastern shoulder, and a knap west of the town ----------
  v.outcrop(at(8, -6), 2.8, 0.9);
  v.outcrop(at(14, -4), 3, 0.85);
  v.outcrop(at(-9, 6), 2.6, 0.85);
  v.outcrop(at(18, 6), 3.2, 0.8);
  v.outcrop(at(-16, -18), 3, 0.8);
  v.outcrop(at(6, 26), 3, 0.8);
  v.outcrop(at(-20, 26), 3, 0.75);

  // --- Metal: the mid ring, as worldgen has always priced it -------------
  v.silverSeam(150, at(-13, -8));
  v.silverSeam(120, at(-20, 14));
  v.ironSeam(150, at(16, -11));
  v.ironSeam(120, at(24, 2));
  // The gold is the bandits' — it lies on their heath, across the beck,
  // and the only way to spend it is to take the camp down first.
  v.goldSeam(120, at(30, 27));

  // The town's own meadow: the woods have an edge, and it is out here
  // rather than one stray tree from the keep's doorstep.
  v.clearing(keep, 10);
  v.noDeadWoodSites([start!]);
  v.plantBelt();
  v.clear(start!.x - 2, start!.y - 2, 7, 9);
  v.clear(105, 105, 5, 5);

  return {
    valley: v,
    name: 'Hold the Valley',
    starts: [start!],
    intent: [
      'a firth west, wooded hills north, hill country east, the heath south-east',
      'the beck divides valley from bandits — two fords, and every raid walks one',
      'the gold lies on the camp’s own heath',
    ],
    drowned,
  };
}
