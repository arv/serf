import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../sim/world.ts';
import { tickWorld, type PlayerCommand } from '../sim/tick.ts';
import { AiBrain } from '../sim/systems/ai.ts';
import { strategyOf } from '../sim/defs/aiStrategies.ts';
import { summarizeForSeat } from './summary.ts';

/**
 * The summary is the strategist's only eyes, and the brain it serves plays
 * under fog — so what is covered here is honesty in both directions: the
 * seat's own village reported the way the world holds it, and everything
 * across the fog reported only as far as scouting has actually seen. The
 * omniscient leak (true rival armies off the raw world) is the regression
 * this file exists to keep dead.
 */

/** A skirmish driven by the real brains, far enough in to have villages. */
function playedWorld(ticks: number): { world: World; brains: AiBrain[] } {
  const world = createWorld({
    seed: 11,
    players: [{ kind: 'ai', strategy: 'steward' }, { kind: 'ai', strategy: 'warlord' }],
    // What is under test is the summary's shape and budget, at the tempo
    // its tick horizons were written for — the classic 64 map keeps these
    // sims inside vitest's default timeout. Map scale has its own tests.
    mapSize: 64,
  });
  const brains = world.players.map((p) => new AiBrain(p.id, strategyOf(p.strategy), world.map.size));
  for (let t = 0; t < ticks && world.outcome.state === 'playing'; t++) {
    const commands: PlayerCommand[] = [];
    for (const brain of brains) {
      if (!brain.shouldDecide(world.tick)) continue;
      for (const cmd of brain.decide(world)) commands.push({ playerId: brain.playerId, cmd });
    }
    tickWorld(world, commands);
  }
  return { world, brains };
}

describe('summarizeForSeat', () => {
  it('reports the seat\'s own village the way the world holds it', () => {
    const { world, brains } = playedWorld(4_000);
    const summary = summarizeForSeat(world, brains[0]!);

    expect(summary.tick).toBe(world.tick);
    expect(summary.minutes).toBe(Math.round(world.tick / 1200)); // 20 Hz
    expect(summary.seat).toMatchObject({ id: 0, strategyId: 'steward' });
    expect(summary.seat.knobs.armyAttackSize).toBe(strategyOf('steward').armyAttackSize);

    // Own counts agree with a straight scan — a seat always knows itself.
    const myBuildings = [...world.buildings.values()].filter((b) => !b.dead && b.owner === 0);
    const counted = Object.values(summary.me.buildings).reduce((a, n) => a + n, 0);
    expect(counted).toBe(myBuildings.length);
    expect(summary.me.buildings.storehouse).toBe(1);
    expect(summary.me.pop).toBeGreaterThan(0);
    expect(summary.me.pop).toBeLessThanOrEqual(summary.me.popCap);
    expect(summary.me.serfs).toBeGreaterThan(0);

    // Stock carries no zero lines — dead weight in every prompt otherwise.
    expect(Object.values(summary.me.stock).every((n) => n > 0)).toBe(true);

    // The village lights its own surroundings, nothing more this early.
    expect(summary.explored).toBeGreaterThan(0);
    expect(summary.explored).toBeLessThan(0.6);
  });

  it('reports across the fog only what scouting has seen', () => {
    // Early: nobody has walked anywhere yet. The rival exists as a rumor —
    // not found, no distance, no intel, no true army count anywhere.
    const early = playedWorld(200);
    const dark = summarizeForSeat(early.world, early.brains[0]!);
    expect(dark.rivals).toHaveLength(1);
    expect(dark.rivals[0]).toMatchObject({
      id: 1,
      alive: true,
      found: false,
      distance: -1,
      intel: null,
    });
    expect(dark.rivals[0]).not.toHaveProperty('army'); // the omniscient leak
    expect(dark.bandits.camps).toBe(0); // the camp sits in dark ground

    // The same moment with the map fully explored (through the same getter
    // the summary reads): everything scouting could deliver appears.
    early.brains[0]!.vision.explored.fill(1);
    const lit = summarizeForSeat(early.world, early.brains[0]!);
    expect(lit.explored).toBe(1);
    expect(lit.rivals[0]!.found).toBe(true);
    expect(lit.rivals[0]!.distance).toBeGreaterThan(0);
    expect(lit.rivals[0]!.buildings).toBeGreaterThan(0);
    expect(lit.bandits.camps).toBeGreaterThan(0);
    expect(lit.bandits.nearestCamp).toBeGreaterThan(0);
    // Intel is a scout's sighting, not a map property: exploring ground
    // does not conjure a look at an army nobody watched march.
    expect(lit.rivals[0]!.intel).toBeNull();
  });

  it('carries intel as the brain holds it, age attached', () => {
    const { world, brains } = playedWorld(12_000);
    for (const brain of brains) {
      const summary = summarizeForSeat(world, brain);
      for (const rival of summary.rivals) {
        if (rival.intel === null) continue;
        expect(rival.intel.ageTicks).toBeGreaterThanOrEqual(0);
        expect(rival.intel.ageTicks).toBeLessThanOrEqual(8_000); // trustFor
        expect(rival.intel.heavy + rival.intel.light + rival.intel.ranged).toBe(
          rival.intel.total,
        );
        expect(rival.intel.total).toBeGreaterThan(0);
      }
    }
  }, 60_000);

  it('stays under the prompt budget however the match sprawls', () => {
    const { world, brains } = playedWorld(12_000);
    for (const brain of brains) {
      expect(JSON.stringify(summarizeForSeat(world, brain)).length).toBeLessThan(2000);
    }
  }, 60_000);

  it('does not crash on a seat whose castle has fallen', () => {
    const { world, brains } = playedWorld(500);
    for (const b of world.buildings.values()) {
      if (b.owner === 0 && b.type === 'storehouse') b.dead = true;
    }
    const summary = summarizeForSeat(world, brains[0]!);
    expect(summary.me.stock).toEqual({});
    expect(summary.rivals[0]!.distance).toBe(-1);
    expect(summary.bandits.nearestCamp).toBe(-1);
    expect(summary.me.underAttack).toBe(false);
  });
});
