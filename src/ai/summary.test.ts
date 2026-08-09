import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../sim/world.ts';
import { tickWorld, type PlayerCommand } from '../sim/tick.ts';
import { AiBrain } from '../sim/systems/ai.ts';
import { strategyOf } from '../sim/defs/aiStrategies.ts';
import { summarizeForSeat } from './summary.ts';

/**
 * The summary is the strategist's only eyes: what is covered here is that
 * it stays honest against a real match — counts that match the world,
 * distances that make sense — and that it stays small, because its size is
 * the model's latency.
 */

/** A skirmish driven by the real brains, far enough in to have villages. */
function playedWorld(ticks: number): World {
  const world = createWorld({
    seed: 11,
    players: [{ kind: 'ai', strategy: 'steward' }, { kind: 'ai', strategy: 'warlord' }],
  });
  const brains = world.players.map((p) => new AiBrain(p.id, strategyOf(p.strategy)));
  for (let t = 0; t < ticks && world.outcome.state === 'playing'; t++) {
    const commands: PlayerCommand[] = [];
    for (const brain of brains) {
      if (!brain.shouldDecide(world.tick)) continue;
      for (const cmd of brain.decide(world)) commands.push({ playerId: brain.playerId, cmd });
    }
    tickWorld(world, commands);
  }
  return world;
}

describe('summarizeForSeat', () => {
  it('reports a mid-game village the way the world holds it', () => {
    const world = playedWorld(4_000);
    const summary = summarizeForSeat(world, 0);

    expect(summary.tick).toBe(world.tick);
    expect(summary.minutes).toBe(Math.round(world.tick / 1200)); // 20 Hz
    expect(summary.seat).toMatchObject({ id: 0, strategyId: 'steward' });
    expect(summary.seat.knobs.armyAttackSize).toBe(strategyOf('steward').armyAttackSize);

    // Counts agree with a straight scan of the world.
    const myBuildings = [...world.buildings.values()].filter((b) => !b.dead && b.owner === 0);
    const counted = Object.values(summary.me.buildings).reduce((a, n) => a + n, 0);
    expect(counted).toBe(myBuildings.length);
    expect(summary.me.buildings.storehouse).toBe(1);
    expect(summary.me.pop).toBeGreaterThan(0);
    expect(summary.me.pop).toBeLessThanOrEqual(summary.me.popCap);
    expect(summary.me.serfs).toBeGreaterThan(0);

    // Stock carries no zero lines — dead weight in every prompt otherwise.
    expect(Object.values(summary.me.stock).every((n) => n > 0)).toBe(true);

    // The rival is seat 1, seen from the outside: alive, at a distance.
    expect(summary.rivals).toHaveLength(1);
    expect(summary.rivals[0]).toMatchObject({ id: 1, alive: true });
    expect(summary.rivals[0]!.distance).toBeGreaterThan(0);
    expect(summary.rivals[0]!.buildings).toBeGreaterThan(0);

    // The campaign map seeds a bandit camp; the seat can see how far.
    expect(summary.bandits.camps).toBeGreaterThan(0);
    expect(summary.bandits.nearestCamp).toBeGreaterThan(0);
  });

  it('stays under the prompt budget however the match sprawls', () => {
    const world = playedWorld(12_000);
    for (const p of world.players) {
      expect(JSON.stringify(summarizeForSeat(world, p.id)).length).toBeLessThan(2000);
    }
  });

  it('mirrors the two seats: my army is the rival count seen from the other side', () => {
    const world = playedWorld(12_000);
    const mine = summarizeForSeat(world, 0);
    const theirs = summarizeForSeat(world, 1);
    const myArmy = mine.me.army.knight + mine.me.army.spearman + mine.me.army.archer;
    expect(theirs.rivals[0]!.army).toBe(myArmy);
    expect(mine.rivals[0]!.distance).toBe(theirs.rivals[0]!.distance);
  });

  it('does not crash on a seat whose castle has fallen', () => {
    const world = playedWorld(500);
    for (const b of world.buildings.values()) {
      if (b.owner === 0 && b.type === 'storehouse') b.dead = true;
    }
    const summary = summarizeForSeat(world, 0);
    expect(summary.me.stock).toEqual({});
    expect(summary.rivals[0]!.distance).toBe(-1);
    expect(summary.bandits.nearestCamp).toBe(-1);
  });
});
