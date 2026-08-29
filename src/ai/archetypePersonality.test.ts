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
    for (const seed of [1, 2, 3, 5, 8, 13]) {
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
    const calm = (m: Map<number, number>): number =>
      share(m, Archetype.booming) + share(m, Archetype.turtling);

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
