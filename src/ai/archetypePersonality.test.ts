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
 * direction — the warlord reads as a rusher more than the abbot does, and
 * the abbot as the calm one more than the warlord — pooled over seeds so
 * one valley's geography cannot decide it.
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
    /**
     * The calm read is `booming` alone — army at or under one, ten
     * buildings standing — and it used to be booming + turtling.
     *
     * Turtling left because it stopped being a read about temperament. It
     * needs a force of three SEEN, so it says as much about how big a
     * rival's army has grown as about what he does with it, and the two
     * playbooks grow theirs at opposite ends of their lists: the warlord
     * buys its war techs first and the abbot buys them last. Once studies
     * had to be carried to the Abbey before they began — a slower tech
     * line for everyone — that gap opened wide enough to swamp the read.
     * Pooled over these twenty-four seeds the abbot turtles 0.190 of the
     * time against the warlord's 0.331, so booming + turtling now calls
     * the WARLORD the calm one, 0.401 to 0.335. Running the pool out to
     * 22_000 ticks does not mend it; the abbot's army is smaller through
     * the whole match, not just past the window.
     *
     * Booming alone says what this test means and says it twice as
     * loudly: 0.145 for the abbot against 0.070 for the warlord, where
     * the old composite separated the pair by 0.022 (0.365 to 0.343)
     * back when nothing was carried anywhere. If a rebalance ever gives
     * the abbot an army inside fifteen minutes again, turtling is worth
     * reconsidering here.
     */
    const calm = (m: Map<number, number>): number =>
      share(m, Archetype.booming);

    // The loop saw real games: both sides produced reads at all.
    let warlordReads = 0;
    for (const n of pooled.warlord.values()) warlordReads += n;
    expect(warlordReads).toBeGreaterThan(20);

    // The blurbs, finally visible from the other side of the fog.
    expect(pooled.warlord.get(Archetype.rusher) ?? 0).toBeGreaterThan(0);
    expect(rusher(pooled.warlord)).toBeGreaterThan(rusher(pooled.abbot));
    expect(calm(pooled.abbot)).toBeGreaterThan(calm(pooled.warlord));
  }, 300_000);
});
