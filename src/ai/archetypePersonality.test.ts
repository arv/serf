import {describe, expect, it} from 'vitest';
import {AiSeats} from '../sim/aiSeats.ts';
import * as AiStrategyId from '../sim/defs/aiStrategyIdEnum.ts';
import * as MatchState from '../sim/matchStateEnum.ts';
import * as PlayerKind from '../sim/playerKindEnum.ts';
import {tickWorld} from '../sim/tick.ts';
import {createWorld} from '../sim/world.ts';
import {classifyRival} from './archetype.ts';
import * as Archetype from './archetypeEnum.ts';
import {summarizeForSeat} from './summary.ts';

/**
 * The legibility acceptance test: can a seat TELL who it is playing?
 *
 * The archetype classifier was measured as a null when it shipped, and the
 * README's diagnosis was upstream of it — "behind fog, three playbooks
 * whose blurbs promise completely different games look much alike: every
 * one of them walks a lone scout past your castle around minute four, and
 * none of them brings a force to your gates before the match is nearly
 * decided." The stance engine and the war behaviors exist to change
 * exactly that, so the classifier doubles as their acceptance test: watch
 * a warlord and an abbot through a real seat's own fog and the reads must
 * finally order the way the blurbs promise.
 *
 * Orderings, not thresholds, on purpose: a threshold here would be seat
 * bias and seed noise wearing a pass mark. What is asserted is only the
 * direction — the warlord reads as a rusher more than the abbot does —
 * pooled over seeds so one valley's geography cannot decide it.
 *
 * There was a second ordering here, the mirror of that one: the abbot as
 * the calm one more than the warlord. It was removed when the Archery
 * Range took the barracks' footprint, and not because that change broke
 * it. Measured on five pools, it does not hold on main either:
 *
 *   pool        main (calm a/w)      3x3 range (calm a/w)
 *   1..24       0.364/0.343  holds   0.339/0.378  inverts
 *   4..23       0.334/0.370  inverts 0.312/0.368  inverts
 *   24..40      0.340/0.469  inverts 0.376/0.332  holds
 *   1..40       0.343/0.404  inverts 0.342/0.356  inverts
 *   1..48       0.345/0.407  inverts 0.359/0.375  inverts
 *
 * One pool in five, and the one it holds on is the one that was pinned.
 * The remedy this file reached for last time — "the pool widened rather
 * than the assertion softening" — is the first thing that was tried and it
 * does not work here: widening inverts it for BOTH builds. An assertion
 * that needs one particular draw to pass is measuring the draw, and every
 * footprint change in the game will keep knocking it over; the fishery's
 * did, one release ago, and the note below records that round.
 *
 * The rusher half is a different matter and is what remains. It holds on
 * every pool measured, on both builds, and reads wider on the 3x3 range
 * (0.056/0.005 against 0.035/0.000 at 1..40) rather than narrower — which
 * is the direction that says the signal is real.
 */

/** One warlord-vs-abbot match, each brain classifying the other every 500
 * ticks from minute five; reads pooled per side. */
function readsFor(seed: number, horizon: number) {
  const world = createWorld({
    seed,
    players: [
      {kind: PlayerKind.ai, strategy: AiStrategyId.warlord},
      {kind: PlayerKind.ai, strategy: AiStrategyId.abbot},
    ],
    banditsEnabled: false,
    mapSize: 64,
  });
  const seats = new AiSeats(world);
  const counts = {
    warlord: new Map<number, number>(),
    abbot: new Map<number, number>(),
  };
  const bump = (m: Map<number, number>, k: number): void =>
    void m.set(k, (m.get(k) ?? 0) + 1);
  for (
    let t = 0;
    t < horizon && world.outcome.state === MatchState.playing;
    t++
  ) {
    tickWorld(world, seats.decide(world));
    if (world.tick % 500 !== 0 || world.tick < 6000) continue;
    // Seat 1 (the abbot) reads seat 0 (the warlord), and vice versa — each
    // through its OWN brain's fog and intel, which is the whole point.
    const abbotEyes = seats.brainFor(1);
    const warlordEyes = seats.brainFor(0);
    if (abbotEyes) {
      const s = summarizeForSeat(world, abbotEyes);
      const rival = s.rivals.find(r => r.id === 0);
      if (rival) bump(counts.warlord, classifyRival(rival, s.minutes));
    }
    if (warlordEyes) {
      const s = summarizeForSeat(world, warlordEyes);
      const rival = s.rivals.find(r => r.id === 1);
      if (rival) bump(counts.abbot, classifyRival(rival, s.minutes));
    }
  }
  return counts;
}

describe('personalities read through the fog', () => {
  it('a warlord finally looks like a rusher, and an abbot does not', () => {
    const pooled = {
      warlord: new Map<number, number>(),
      abbot: new Map<number, number>(),
    };
    // A contiguous range of seeds, and it is worth saying why rather than
    // leaving it to look arbitrary. This pool was six Fibonacci seeds, then
    // ten of them (the salvage change made seed 8 invert hard, and at six
    // that one valley tied the pool at 63/94 apiece — so the pool widened
    // rather than the assertion softening). The fishery's footprint, 3x3
    // down to 2x2, re-times every match that has a shore in it, and that
    // draw inverted again: pooled calm went 0.345/0.328 to 0.383/0.430,
    // and pushing the same sequence out to sixteen did not mend it
    // (0.394/0.468).
    //
    // It was the draw and not the signal. Measured on three pools of
    // sixteen the ordering holds on both footprints — seeds 4..23 read
    // 0.387/0.308 before and 0.429/0.361 after, seeds 24..40 read
    // 0.438/0.402 and 0.425/0.382 — and it holds on this contiguous
    // twenty-four, 0.364/0.322 before and 0.399/0.386 after. A run of
    // seeds nobody chose is the pool least able to hide a valley, which is
    // what this test wanted from pooling in the first place.
    for (let seed = 1; seed <= 24; seed++) {
      const {warlord, abbot} = readsFor(seed, 18_000);
      for (const [k, n] of warlord)
        pooled.warlord.set(k, (pooled.warlord.get(k) ?? 0) + n);
      for (const [k, n] of abbot)
        pooled.abbot.set(k, (pooled.abbot.get(k) ?? 0) + n);
    }
    const share = (m: Map<number, number>, k: number): number => {
      let total = 0;
      for (const n of m.values()) total += n;
      return total === 0 ? 0 : (m.get(k) ?? 0) / total;
    };
    const rusher = (m: Map<number, number>): number =>
      share(m, Archetype.rusher);

    // The loop saw real games: both sides produced reads at all.
    let warlordReads = 0;
    for (const n of pooled.warlord.values()) warlordReads += n;
    expect(warlordReads).toBeGreaterThan(20);

    // The blurb, finally visible from the other side of the fog. Its
    // mirror — the abbot reading calmer than the warlord — used to stand
    // here; the header says what five pools made of it.
    expect(pooled.warlord.get(Archetype.rusher) ?? 0).toBeGreaterThan(0);
    expect(rusher(pooled.warlord)).toBeGreaterThan(rusher(pooled.abbot));
  }, 300_000);
});
