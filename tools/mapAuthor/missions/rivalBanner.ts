/**
 * Mission 7 — The Rival Banner: two banners, one charter, last one
 * standing.
 *
 * The only map in the campaign that has to be *fair*, so it is the only
 * one drawn as a half. Every landform, every stand of timber, every seam
 * is laid once against the north-western seat and repeated at its
 * half-turn about the middle of the grid — and the valley's own grain is
 * mirrored with it (`mirror: true`), so the two reeves do not even get
 * different ragged edges on their woods.
 *
 * What that half says: each banner opens in a bay of its own corner —
 * water at its back, timber and stone at its elbow, its iron and silver
 * in the ground behind it — and the two of them face each other across an
 * open middle, with the bandit camp and the valley's only gold standing
 * in it. The two MERES flank that middle on the other diagonal, so the
 * ground between the banners is a broad road rather than a field, and
 * both roads to the camp are the same length. They are: the camp's own
 * footprint sits off-centre by a tile and a half, on the line between the
 * meres, which is exactly the line the two seats are equidistant from.
 */
import { HILL, MEADOW, RISE, Valley, type Authored, type Pt } from '../kit.ts';
import { keepAnchor, keepCenter, seats } from '../layout.ts';

export function build(): Authored {
  const v = new Valley(96, 7079, { mirror: true });
  const starts = seats(2);
  const keep = keepCenter(starts[0]!);
  /** Said against the north-western banner... */
  const a = (dx: number, dy: number): Pt => ({ x: keep.x + dx, y: keep.y + dy });
  /** ...and mirrored: a place and its half-turn twin. */
  const twin = (dx: number, dy: number): [Pt, Pt] => v.pair(a(dx, dy));
  /** Both halves of a polyline. */
  const both = (pts: Pt[]): Pt[][] => [pts, pts.map((p) => v.rotated(p))];
  /** The grid's own centre — the one place that is its own twin. */
  const middle: Pt = { x: v.size / 2, y: v.size / 2 };

  v.meadow(MEADOW, 0.05);
  // Each banner's own country: a shoulder of hill behind it, the bay in
  // front, and the ground falling away toward the middle.
  for (const p of twin(-13, -13)) v.mound(p, 13, HILL - MEADOW, 0.12);
  for (const p of twin(9, -14)) v.mound(p, 9, RISE - MEADOW);
  for (const p of twin(-16, 8)) v.mound(p, 10, 0.14);
  for (const spine of both([a(14, 6), a(20, 16), a(22, 28)])) {
    v.ridge(spine, 7, 0.2, 0.22);
  }
  // The middle: a low heath the two roads meet on, with the meres on the
  // other diagonal holding it to a road's width.
  v.level(middle, 12, 0.4, 8);
  for (const p of twin(-9, -9)) v.level(p, 9, 0.45, 5);
  for (const p of v.pair({ x: middle.x - 15.5, y: middle.y + 14.5 })) v.pond(p, 7);
  // Each banner's water, at its back.
  for (const p of twin(-12, -9)) v.pond(p, 4);
  for (const course of both([a(-12, -9), a(-20, -14), a(-30, -20)])) v.river(course, 1.6, 0.08);
  // The camp stands in the middle, far from any border — but the two
  // banners open twenty-seven tiles off their corners, which a deep bay
  // can reach. Reserved in pairs, like everything else here.
  for (const s of starts) v.keepClear({ x: s.x + 1.5, y: s.y + 1.5 }, 6);
  v.borders({ n: 'ridge', e: 'sea', s: 'ridge', w: 'sea' });

  const drowned = v.settle(keepAnchor(starts[0]!));

  // --- Each banner's timber and stone ------------------------------------
  // A duel map has no forest belt to fall back on (both land borders are
  // ranges and both sea borders are sea), so every stick of timber on it
  // is a stand somebody put there — and a war of elimination that runs
  // out of wood does not end. Each banner gets the same seven.
  for (const course of both([a(-15, 1), a(-8, 10), a(3, 13)])) v.treeline(course, 5, 0.88);
  for (const p of twin(-18, -5)) v.grove(p, 6, 0.85);
  for (const p of twin(-5, -19)) v.grove(p, 6, 0.85);
  for (const p of twin(12, 15)) v.grove(p, 5.5, 0.8);
  for (const p of twin(20, -5)) v.grove(p, 5.5, 0.8);
  for (const p of twin(-20, -15)) v.grove(p, 5.5, 0.78);
  for (const p of twin(7, 23)) v.grove(p, 5.5, 0.78);
  for (const p of twin(23, 8)) v.grove(p, 5, 0.75);

  for (const p of twin(7, -6)) v.outcrop(p, 2.8, 0.9);
  for (const p of twin(-7, 6)) v.outcrop(p, 2.6, 0.85);
  for (const p of twin(13, -12)) v.outcrop(p, 3, 0.85);
  for (const p of twin(-16, 14)) v.outcrop(p, 3, 0.8);

  // --- Ore is a birthright ------------------------------------------------
  // Priced exactly as worldgen prices a two-seat valley's seams, and set
  // in each banner's own ground rather than on a shared ring.
  for (const p of twin(-11, -6)) v.silverSeam(180, p);
  for (const p of twin(-5, -14)) v.ironSeam(144, p);
  // The gold is the exception by design: contested, in the middle, with
  // the bandit camp standing over it.
  // Two lodes rather than one, at each other's half-turn: a single blob
  // in the middle cannot be symmetric about a point it does not sit on,
  // and "contested" has to mean the same walk for both banners.
  for (const p of v.pair({ x: middle.x - 6.5, y: middle.y + 5.5 })) v.goldSeam(60, p);

  // Each banner's own meadow swept: the woods have an edge, and a lone
  // tree by the keep is a woodcutter site that fells it and starves.
  for (const s of starts) v.clearing({ x: s.x + 1.5, y: s.y + 1.5 }, 10);
  v.noDeadWoodSites(starts);
  v.plantBelt();
  for (const s of starts) v.clear(s.x - 2, s.y - 2, 7, 9);
  v.clear(75, 72, 5, 5);

  return {
    valley: v,
    name: 'The Rival Banner',
    starts,
    intent: [
      'one half authored and mirrored at the half-turn — grain, groves and seams alike',
      'each banner opens in its own bay: water behind, timber and stone at its elbow',
      'the middle is open road between two meres, with camp and gold standing in it',
    ],
    drowned,
    symmetric: true,
  };
}
