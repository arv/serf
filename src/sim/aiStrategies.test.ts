import { describe, expect, it } from 'vitest';
import { createWorld, type World, type WorldConfig } from './world.ts';
import { tickWorld, type PlayerCommand } from './tick.ts';
import { AiBrain, mustersNeeded } from './systems/ai.ts';
import {
  AI_STRATEGIES,
  AI_STRATEGY_ORDER,
  strategyForSeat,
  type AiStrategyId,
} from './defs/aiStrategies.ts';

/**
 * Every AI seat used to run one hard-coded playbook, so beating one
 * computer opponent was beating all of them. What is covered here is that
 * the playbooks are real: each one can carry a village on its own, seats
 * get different ones, and a world of four of them still reaches an ending.
 *
 * (The steward's own campaign win is winnable.test.ts — that one is the
 * balance regression, and it stays the yardstick this file compares to.)
 */

const IDS = Object.keys(AI_STRATEGIES) as AiStrategyId[];

/** Drive one playbook alone on the campaign map, the way its host does. */
function playCampaign(id: AiStrategyId, maxTicks: number): World {
  const world = createWorld({ seed: 20260724, players: [{ kind: 'ai' }] });
  const brain = new AiBrain(0, AI_STRATEGIES[id]);
  for (let t = 0; t < maxTicks && world.outcome.state === 'playing'; t++) {
    const commands = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
    tickWorld(
      world,
      commands.map((cmd) => ({ playerId: 0, cmd })),
    );
  }
  return world;
}

function playSeats(config: WorldConfig, maxTicks: number): World {
  const world = createWorld(config);
  const brains = config.players.map((p, i) => (p.kind === 'ai' ? new AiBrain(i) : null));
  for (let t = 0; t < maxTicks && world.outcome.state === 'playing'; t++) {
    const commands: PlayerCommand[] = [];
    for (const brain of brains) {
      if (!brain || !brain.shouldDecide(world.tick)) continue;
      for (const cmd of brain.decide(world)) commands.push({ playerId: brain.playerId, cmd });
    }
    tickWorld(world, commands);
  }
  return world;
}

describe('the AI playbooks', () => {
  it('every playbook can win the campaign map on its own', () => {
    for (const id of IDS) {
      const world = playCampaign(id, 60_000);
      expect(world.outcome, `${id} ended at tick ${world.tick}`).toEqual({
        state: 'over',
        winner: 0,
      });
    }
  }, 240_000);

  it('gives each seat a different playbook, and seat 0 the tested one', () => {
    const seated = [0, 1, 2, 3].map((id) => strategyForSeat(id).id);
    expect(seated[0]).toBe('steward');
    expect(new Set(seated).size).toBe(4);
    expect(seated).toEqual(AI_STRATEGY_ORDER);
  });

  it('plays four visibly different games in one world', () => {
    const world = playSeats(
      {
        seed: 11,
        players: [{ kind: 'ai' }, { kind: 'ai' }, { kind: 'ai' }, { kind: 'ai' }],
        banditsEnabled: false,
      },
      9_000,
    );

    // A fingerprint per seat: what it researched and what it built. Two
    // seats running the same playbook would land on the same one.
    const fingerprints = world.players.map((p) => {
      const built = [...world.buildings.values()]
        .filter((b) => !b.dead && b.owner === p.id)
        .map((b) => b.type)
        .sort()
        .join(',');
      return `${[...p.techs.researched].sort().join('/')}|${built}`;
    });
    expect(new Set(fingerprints).size, fingerprints.join('\n')).toBe(4);

    // And the differences are the ones the playbooks promise: the fletcher
    // takes the bow line and never touches iron, the warlord digs a second
    // seam to keep two sword forges fed.
    expect(world.players[3]!.techs.researched).toContain('archery');
    expect(world.players[3]!.techs.researched).not.toContain('ironworking');
    const ironMines = (owner: number): number =>
      [...world.buildings.values()].filter(
        (b) => !b.dead && b.owner === owner && b.type === 'ironMine',
      ).length;
    expect(ironMines(1)).toBeGreaterThan(ironMines(0));
  }, 120_000);

  it('four different playbooks still reach an ending', () => {
    // Seed 42 is the standoff that found the impatience rule: two exhausted
    // villages, each below its own muster size, neither ever marching.
    const world = playSeats(
      {
        seed: 42,
        players: [{ kind: 'ai' }, { kind: 'ai' }, { kind: 'ai' }, { kind: 'ai' }],
        banditsEnabled: false,
      },
      90_000,
    );
    expect(world.outcome.state, `still playing at tick ${world.tick}`).toBe('over');
  }, 240_000);

  it('drops the muster bar only once a standoff has really set in', () => {
    expect(mustersNeeded(7, 0)).toBe(7);
    expect(mustersNeeded(7, 19_999)).toBe(7);
    expect(mustersNeeded(7, 20_001)).toBe(6);
    expect(mustersNeeded(7, 26_001)).toBe(3);
    // Never below the floor, however long the standoff runs.
    expect(mustersNeeded(7, 500_000)).toBe(3);
    expect(mustersNeeded(3, 500_000)).toBe(3);
  });
});
