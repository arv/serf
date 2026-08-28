/**
 * Mission 3 — The Abbey's Ledger: silver, scholarship, iron, and a forge.
 *
 * Two hills, two metals, and a town between them. The commission is a
 * shopping list — abbey, silver mine, ironworking, iron mine, smith,
 * spears — and the ground answers it as a map rather than as a checklist:
 * the pale SILVER HILL stands north-west of the keep, the IRON SPUR runs
 * down out of the north-east, and the last reeve's camp (the prebuilt
 * woodcutter, quarry, house, well and field) sits in the meadow between
 * them, already working.
 *
 * Both seams are inside a dozen tiles of the keep on purpose. This is the
 * mission that teaches the tech tree, and a player who spends it walking
 * has learned about walking. The abbey has its own quiet shelf south of
 * the town, away from the hauling.
 */
import {HILL, MEADOW, Valley, type Authored} from '../kit.ts';
import {keepAnchor, keepCenter, seats} from '../layout.ts';

export function build(): Authored {
  const v = new Valley(96, 3037);
  const [start] = seats(1);
  const keep = keepCenter(start!);
  const at = (dx: number, dy: number) => ({x: keep.x + dx, y: keep.y + dy});

  v.meadow(MEADOW, 0.05)
    // The northern range the two hills come down from, the silver hill
    // itself, and the iron spur opposite it.
    .mound(at(0, -30), 22, 0.3, 0.14)
    .mound(at(-13, -13), 10, HILL - MEADOW, 0.1)
    .ridge([at(8, -17), at(16, -7), at(23, 4)], 7, 0.34, 0.28)
    .mound(at(-24, 10), 14, 0.16)
    // The town meadow between them, the field terrace east of it, and the
    // abbey's shelf to the south.
    .level(keep, 9, 0.45, 5)
    .level(at(8, 4), 7, 0.44, 5)
    .level(at(-2, 13), 6, 0.43, 5)
    // The beck that comes down between the hills and pools below the town.
    .river(
      [at(16, -27), at(14, -11), at(15, 2), at(11, 16), at(6, 30), at(2, 44)],
      1.6,
      0.1,
    )
    // The abbey road's ford. The beck runs the whole height of the valley
    // now that it reaches the hills at one end and the sea at the other,
    // and a border deep enough to meet both ends turns it into a wall:
    // everything east of it — the iron, the gold — off the landmass. One
    // crossing, and it is a beck again.
    .ford(at(14, -3), 4)
    .pond(at(9, 19), 3.5)
    .borders({n: 'ridge', e: 'ridge', s: 'sea', w: 'forest'});

  const drowned = v.settle(keepAnchor(start!));

  // --- The predecessor's woods and stone ---------------------------------
  // Sited for the huts the mission stands here: the woodcutter is placed
  // six tiles west of the keep and the quarry six east, and each has to
  // find its work inside a hut's reach of that.
  v.treeline([at(-11, -7), at(-12, 5), at(-9, 16)], 4, 0.88);
  v.grove(at(-20, -6), 6, 0.8);
  v.grove(at(-17, 19), 5.5, 0.75);
  v.grove(at(-6, -19), 5, 0.75);
  v.grove(at(18, 14), 5, 0.7);

  v.outcrop(at(9, -4), 2.8, 0.9);
  v.outcrop(at(14, -12), 3, 0.85);
  v.outcrop(at(19, 3), 2.8, 0.8);
  v.outcrop(at(-14, -18), 2.6, 0.8);

  // --- The two seams, one hill each --------------------------------------
  v.silverSeam(170, at(-10, -11));
  v.ironSeam(170, at(12, -9));
  // And what the crown has not asked about yet, far down the valley.
  v.goldSeam(100, at(25, 19));

  // The town's own meadow: the woods have an edge, and it is out here
  // rather than one stray tree from the keep's doorstep.
  v.clearing(keep, 10);
  v.noDeadWoodSites([start!]);
  v.plantBelt();
  v.clear(start!.x - 2, start!.y - 2, 7, 9);

  return {
    valley: v,
    name: "The Abbey's Ledger",
    starts: [start!],
    intent: [
      'silver hill north-west, iron spur north-east, town in between',
      'both seams within a dozen tiles — the lesson is the tech tree, not the walk',
      'a quiet shelf south of the town for the abbey',
    ],
    drowned,
  };
}
