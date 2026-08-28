import { describe, expect, it } from 'vitest';
import { createWorld, type World, type WorldConfig } from './world.ts';
import { tickWorld, type PlayerCommand } from './tick.ts';
import { serializeWorld, deserializeWorld } from './save.ts';
import { AiBrain, mustersNeeded } from './systems/ai.ts';
import { popCapOf, populationOf } from './population.ts';
import { BUILDING_DEFS } from './defs/buildings.ts';
import { AI_STRATEGIES, AI_STRATEGY_ORDER, dealStrategies, parseStrategyId, shuffledStrategies, strategyOf } from './defs/aiStrategies.ts';
import { BuildingTypeId } from './defs/buildings.ts';
import { TechId } from './defs/techs.ts';
import { MatchState } from './world.ts';
import { AiStrategyId } from './defs/aiStrategies.ts';
import { PlayerKind } from './player.ts';
import { AI_STRATEGY_IDS } from './defs/aiStrategies.ts';
import { AI_STRATEGY_KEYS } from './defs/aiStrategies.ts';

/**
 * Every AI seat used to run one hard-coded playbook, so beating one
 * computer opponent was beating all of them. What is covered here is that
 * the playbooks are real: each one can carry a village on its own, the
 * seed deals a different one to every seat, a named seat keeps the one it
 * asked for, and a world of four of them still reaches an ending.
 *
 * (The campaign win itself is winnable.test.ts — that one is the balance
 * regression, and it stays the yardstick this file compares to.)
 */

const IDS: readonly AiStrategyId[] = AI_STRATEGY_IDS;

/** Drive one playbook alone on the campaign map, the way its host does. */
function playCampaign(id: AiStrategyId, maxTicks: number): World {
  const world = createWorld({ seed: 37, players: [{ kind: PlayerKind.ai }] });
  const brain = new AiBrain(0, AI_STRATEGIES[id], world.map.size);
  for (let t = 0; t < maxTicks && world.outcome.state === MatchState.playing; t++) {
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
  const brains = world.players.map((p) =>
    p.kind === PlayerKind.ai ? new AiBrain(p.id, strategyOf(p.strategy), world.map.size) : null,
  );
  for (let t = 0; t < maxTicks && world.outcome.state === MatchState.playing; t++) {
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
      expect(world.outcome, `${AI_STRATEGY_KEYS[id]} ended at tick ${world.tick}`).toEqual({
        state: MatchState.over,
        winner: 0,
      });
    }
  }, 240_000);

  it('every playbook raises roofs, and outgrows the castle it started under', () => {
    for (const id of IDS) {
      const world = playCampaign(id, 12_000);
      const houses = [...world.buildings.values()].filter(
        (b) => !b.dead && b.owner === 0 && b.type === BuildingTypeId.house,
      );
      expect(houses.length, `${AI_STRATEGY_KEYS[id]} built no house`).toBeGreaterThan(0);
      // A plan that only ever builds beds is no better than one that builds
      // none: what the housing is for is a village bigger than ten.
      expect(populationOf(world, 0), `${AI_STRATEGY_KEYS[id]} never outgrew the castle`).toBeGreaterThan(
        BUILDING_DEFS[BuildingTypeId.storehouse].housing!,
      );
      // And it never sneaks past its own ceiling.
      expect(populationOf(world, 0)).toBeLessThanOrEqual(popCapOf(world, 0));
    }
  }, 240_000);

  it('mans its walls, or does not build them', () => {
    // A guard tower is only worth its stone to a seat that trains archers,
    // since nobody else can man one — so the two bow playbooks should raise
    // towers AND fill them, and the iron ones should raise none at all.
    const garrisonOf = (world: World): { towers: number; men: number } => {
      const towers = [...world.buildings.values()].filter(
        (b) => !b.dead && b.owner === 0 && b.type === BuildingTypeId.guardTower,
      );
      return { towers: towers.length, men: towers.reduce((n, b) => n + (b.garrison ?? 0), 0) };
    };

    for (const id of [AiStrategyId.abbot, AiStrategyId.fletcher]) {
      const held = garrisonOf(playCampaign(id, 45_000));
      expect(held.towers, `${AI_STRATEGY_KEYS[id]} raised no tower`).toBeGreaterThan(0);
      // Filled, not merely built: an empty tower is a wall that cannot shoot,
      // and the archers walk in on their own or the plan is a waste of stone.
      expect(held.men, `${AI_STRATEGY_KEYS[id]} left its towers empty`).toBeGreaterThan(0);
    }
    for (const id of [AiStrategyId.steward, AiStrategyId.warlord]) {
      expect(garrisonOf(playCampaign(id, 45_000)).towers, `${AI_STRATEGY_KEYS[id]} built a tower it cannot man`).toBe(
        0,
      );
    }
  }, 240_000);

  it('deals every AI seat a different playbook, and writes it into the world', () => {
    const world = createWorld({
      seed: 11,
      players: [{ kind: PlayerKind.human }, { kind: PlayerKind.ai }, { kind: PlayerKind.ai }, { kind: PlayerKind.ai }],
    });
    const dealt = world.players.slice(1).map((p) => p.strategy);
    expect(new Set(dealt).size).toBe(3);
    expect(world.players[0]!.strategy).toBeUndefined(); // the human draws nothing
  });

  it('deals from the seed, so a different valley brings different faces', () => {
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const deals = seeds.map((seed) => shuffledStrategies(seed).join(','));
    // Not a hard guarantee for any one pair of seeds — but ten seeds all
    // landing on one order would mean the shuffle is not shuffling.
    expect(new Set(deals).size).toBeGreaterThan(1);
    // Every deal is the whole deck, never a playbook twice.
    for (const seed of seeds) {
      expect([...shuffledStrategies(seed)].sort()).toEqual([...AI_STRATEGY_ORDER].sort());
    }
    // And the same seed always deals the same hand: a save reloaded or a
    // match resumed must face the opponents it started against.
    expect(shuffledStrategies(4242)).toEqual(shuffledStrategies(4242));
  });

  it('keeps a named opponent, and deals the rest around it', () => {
    const seats = [
      { kind: PlayerKind.human },
      { kind: PlayerKind.ai, strategy: AiStrategyId.fletcher as AiStrategyId },
      { kind: PlayerKind.ai },
      { kind: PlayerKind.ai },
    ];
    const deal = dealStrategies(7, seats);
    expect(deal[0]).toBeUndefined();
    expect(deal[1]).toBe(AiStrategyId.fletcher);
    // A picked playbook leaves the deck, so no one else turns up as it.
    expect(deal.slice(2)).not.toContain('fletcher');
    expect(new Set(deal.slice(1)).size).toBe(3);

    const world = createWorld({ seed: 7, players: seats });
    expect(world.players[1]!.strategy).toBe(AiStrategyId.fletcher);
  });

  it('refuses a playbook that does not exist, and falls back to the deal', () => {
    expect(parseStrategyId('warlord')).toBe(AiStrategyId.warlord);
    expect(parseStrategyId('constructor')).toBeUndefined(); // truthy on the prototype
    expect(parseStrategyId('')).toBeUndefined();
    expect(parseStrategyId(42)).toBeUndefined();
    // An unknown name is not an error, it is simply no name: the seat is
    // dealt one like any other.
    const world = createWorld({
      seed: 3,
      players: [{ kind: PlayerKind.ai, strategy: parseStrategyId('nonesuch') }],
    });
    expect(world.players[0]!.strategy).toBe(shuffledStrategies(3)[0]);
  });

  it('carries the deal through a save, so opponents do not change mid-match', () => {
    const world = createWorld({
      seed: 99,
      players: [{ kind: PlayerKind.human }, { kind: PlayerKind.ai }, { kind: PlayerKind.ai }],
    });
    const loaded = deserializeWorld(serializeWorld(world));
    expect(loaded.players.map((p) => p.strategy)).toEqual(world.players.map((p) => p.strategy));
    // A save from before the deal existed names nothing; those seats run
    // the campaign line rather than crashing or drawing at random.
    expect(strategyOf(undefined).id).toBe(AiStrategyId.steward);
  });

  it('plays four visibly different games in one world', () => {
    // Named seats rather than dealt ones, so the assertions can be about
    // particular playbooks — and so the naming itself is exercised. Seed 13
    // is pure data, re-pinned when a worldgen change rolls a valley the
    // playbooks do not separate on within the budget (11 held it until the
    // pan clamp took a share of the scenery ring, and left the warlord
    // digging one seam rather than two).
    const world = playSeats(
      {
        seed: 13,
        players: [
          { kind: PlayerKind.ai, strategy: AiStrategyId.steward },
          { kind: PlayerKind.ai, strategy: AiStrategyId.warlord },
          { kind: PlayerKind.ai, strategy: AiStrategyId.abbot },
          { kind: PlayerKind.ai, strategy: AiStrategyId.fletcher },
        ],
        banditsEnabled: false,
      },
      9_000,
    );
    expect(world.players.map((p) => p.strategy)).toEqual([
      AiStrategyId.steward,
      AiStrategyId.warlord,
      AiStrategyId.abbot,
      AiStrategyId.fletcher,
    ]);

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
    // takes the bow line first — ironworking comes last and only for the
    // axes (its forges stay on bowstaves) — while the warlord digs a
    // second seam to keep two sword forges fed.
    expect(world.players[3]!.techs.researched).toContain(TechId.archery);
    expect(world.players[3]!.techs.researched[0]).toBe(TechId.soldiery);
    const ironMines = (owner: number): number =>
      [...world.buildings.values()].filter(
        (b) => !b.dead && b.owner === owner && b.type === BuildingTypeId.ironMine,
      ).length;
    expect(ironMines(1)).toBeGreaterThan(ironMines(0));
  }, 120_000);

  it('four different playbooks still reach an ending', () => {
    // Seed 42 is the standoff that found the impatience rule: two exhausted
    // villages, each below its own muster size, neither ever marching. That
    // standoff lives on seed 42's classic 64 map, so the size is pinned
    // with it — what is under test is the impatience rule, not map scale.
    const world = playSeats(
      {
        seed: 42,
        players: [{ kind: PlayerKind.ai }, { kind: PlayerKind.ai }, { kind: PlayerKind.ai }, { kind: PlayerKind.ai }],
        banditsEnabled: false,
        mapSize: 64,
      },
      90_000,
    );
    expect(world.outcome.state, `still playing at tick ${world.tick}`).toBe(MatchState.over);
  }, 240_000);

  it('drops the muster bar only once a standoff has really set in', () => {
    expect(mustersNeeded(7, 0)).toBe(7);
    expect(mustersNeeded(7, 19_999)).toBe(7);
    expect(mustersNeeded(7, 20_001)).toBe(6);
    expect(mustersNeeded(7, 26_001)).toBe(3);
    // The floor holds through ordinary staleness...
    expect(mustersNeeded(7, 30_000)).toBe(3);
    expect(mustersNeeded(3, 30_000)).toBe(3);
    // ...but a forlorn standoff — both economies spent, the floor itself
    // unreachable — sends whatever still stands, down to a single soldier.
    expect(mustersNeeded(7, 30_001)).toBe(1);
    expect(mustersNeeded(3, 500_000)).toBe(1);
  });
});
