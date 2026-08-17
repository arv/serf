import { describe, expect, it } from 'vitest';
import { canPlace, createWorld, missionWorldConfig, type World } from './world.ts';
import { tickWorld } from './tick.ts';
import { cmds } from './testUtils.ts';
import { AiBrain } from './systems/ai.ts';
import { AI_STRATEGIES, type AiStrategyId } from './defs/aiStrategies.ts';
import {
  MISSION_DEFS,
  MISSION_ORDER,
  nextMissionId,
  parseMissionId,
  type MissionId,
} from './defs/missions.ts';
import { hashWorld } from './hash.ts';
import { deserializeWorld, serializeWorld } from './save.ts';
import { firstRaidTickFor } from './defs/balance.ts';
import type { BuildingTypeId } from './defs/buildings.ts';
import type { SimCommand } from './commands.ts';

/**
 * The campaign missions hold the same line winnable.test.ts holds for the
 * solo game: every pinned seed affords its mission, and the mission can be
 * won with ordinary commands. Missions 2-4 are played by the AI brain (the
 * competent-player stand-in the whole suite uses); mission 1 is scripted
 * by hand because its lesson — six serfs, a tight purse — is below the
 * brain's operating floor.
 */

function countBuilt(world: World, type: BuildingTypeId, owner = 0): number {
  let n = 0;
  for (const b of world.buildings.values()) {
    if (!b.dead && b.state === 'built' && b.owner === owner && b.type === type) n++;
  }
  return n;
}

/** Castle stock of one good (all storage buildings of the seat). */
function stockOf(world: World, good: 'wood' | 'silver'): number {
  let n = 0;
  for (const b of world.buildings.values()) {
    if (!b.dead && b.owner === 0 && b.type === 'storehouse') n += b.stock[good] ?? 0;
  }
  return n;
}

/** The nearest spot the placement rules accept — the ghost search a player
 * runs by eye, in the same ring-spiral order worldgen uses. */
function findSpot(world: World, type: BuildingTypeId, cx: number, cy: number): { x: number; y: number } {
  for (let r = 0; r < 16; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (canPlace(world.map, type, cx + dx, cy + dy)) return { x: cx + dx, y: cy + dy };
      }
    }
  }
  throw new Error(`no spot for ${type} near ${cx},${cy}`);
}

/** Drive the AI brain in the human's chair — the stand-in for a competent
 * player, the same harness winnable.test.ts uses. */
function playMission(id: MissionId, strategy: AiStrategyId, maxTicks: number): World {
  const config = missionWorldConfig(id);
  config.players = config.players.map((p, i) => (i === 0 ? { kind: 'ai' as const } : p));
  const world = createWorld(config);
  const brain = new AiBrain(0, AI_STRATEGIES[strategy], world.map.size);
  for (let t = 0; t < maxTicks && world.outcome.state === 'playing'; t++) {
    const commands = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
    tickWorld(
      world,
      commands.map((cmd) => ({ playerId: 0, cmd })),
    );
  }
  return world;
}

describe('the campaign missions', () => {
  it('mission 1 (The Clearing) is won by the taught line: build, hire, stockpile', () => {
    const world = createWorld(missionWorldConfig('clearing'));
    expect(world.missionId).toBe('clearing');
    expect(world.objectivesDone).toEqual([false, false, false, false, false]);

    // The taught opening: woodcutter at the trees, quarry at the rocks, a
    // house by the castle. Search order matches the reach rule the mission
    // teaches — canPlace refuses a hut out of range of its resource. The
    // castle is wherever worldgen put the solo start (the map's middle,
    // whatever the size), not a pinned coordinate.
    const keep = [...world.buildings.values()].find((b) => b.type === 'storehouse')!;
    const castle = { x: keep.x + 1, y: keep.y + 1 };
    const place = (type: BuildingTypeId): SimCommand => {
      const spot = findSpot(world, type, castle.x, castle.y);
      return { kind: 'placeBuilding', building: type, x: spot.x, y: spot.y };
    };
    tickWorld(world, cmds(place('woodcutter')));
    tickWorld(world, cmds(place('quarry')));
    tickWorld(world, cmds(place('house')));

    let hired = false;
    const MAX = 36_000; // 30 minutes of game time, far past the expected 5-8
    for (let t = 0; t < MAX && world.outcome.state === 'playing'; t++) {
      if (!hired && countBuilt(world, 'house') >= 1) {
        // Five hires at 4 silver: 6 souls to the checklist's 11.
        tickWorld(
          world,
          cmds(
            { kind: 'hireSerf' },
            { kind: 'hireSerf' },
            { kind: 'hireSerf' },
            { kind: 'hireSerf' },
            { kind: 'hireSerf' },
          ),
        );
        hired = true;
        continue;
      }
      tickWorld(world, []);
    }

    expect(world.outcome, `ended at tick ${world.tick}`).toEqual({ state: 'over', winner: 0 });
    expect(world.objectivesDone).toEqual([true, true, true, true, true]);
    // The completion events fired once each (five objectives, one gameOver).
    const completions = world.pendingEvents.filter((e) => e.kind === 'objectiveComplete');
    expect(completions.length).toBe(5);
  }, 120_000);

  it('mission 2 (Bread and Water) is winnable', () => {
    const world = playMission('breadAndWater', 'steward', 45_000);
    expect(world.outcome, `ended at tick ${world.tick}`).toEqual({ state: 'over', winner: 0 });
    expect(stockOf(world, 'wood')).toBeGreaterThanOrEqual(0);
  }, 240_000);

  it('mission 3 (The Abbey’s Ledger) is won by the taught line: dig, study, forge', () => {
    // Scripted rather than AI-driven: the brain trains soldiers the moment
    // it can and eats every spear the checklist wants stockpiled. A player
    // in a bandit-free mission has no barracks and no such leak.
    const world = createWorld(missionWorldConfig('ledger'));
    const keep = [...world.buildings.values()].find((b) => b.type === 'storehouse')!;
    const castle = { x: keep.x + 1, y: keep.y + 1 };
    const researched = (tech: 'cobbledBoots' | 'ironworking'): boolean =>
      world.players[0]!.techs.researched.includes(tech);
    const place = (type: BuildingTypeId): SimCommand => {
      const spot = findSpot(world, type, castle.x, castle.y);
      return { kind: 'placeBuilding', building: type, x: spot.x, y: spot.y };
    };

    tickWorld(world, cmds(place('abbey')));
    tickWorld(world, cmds(place('silverMine')));

    let ironPlaced = false;
    const MAX = 45_000;
    for (let t = 0; t < MAX && world.outcome.state === 'playing'; t++) {
      // A player clicks when the button lights up; every 50 ticks is fine.
      if (world.tick % 50 === 0) {
        const active = world.players[0]!.techs.active;
        if (!active && countBuilt(world, 'abbey') >= 1 && !researched('cobbledBoots')) {
          tickWorld(world, cmds({ kind: 'research', tech: 'cobbledBoots' }));
          continue;
        }
        if (!active && researched('cobbledBoots') && !researched('ironworking')) {
          tickWorld(world, cmds({ kind: 'research', tech: 'ironworking' }));
          continue;
        }
        if (!ironPlaced && researched('ironworking')) {
          tickWorld(world, cmds(place('ironMine')));
          tickWorld(world, cmds(place('weaponsmith')));
          ironPlaced = true;
          continue;
        }
      }
      tickWorld(world, []);
    }

    expect(world.outcome, `ended at tick ${world.tick}`).toEqual({ state: 'over', winner: 0 });
    expect(world.objectivesDone).toEqual([true, true, true, true, true, true]);
  }, 240_000);

  it('mission 4 (The Levy) is winnable, early raid and all', () => {
    const world = playMission('levy', 'steward', 60_000);
    expect(world.outcome, `ended at tick ${world.tick}`).toEqual({ state: 'over', winner: 0 });
  }, 240_000);

  it('mission 5 (Hold the Valley) is exactly the winnable map, reached by mission id', () => {
    const world = playMission('holdTheValley', 'steward', 45_000);
    expect(world.outcome, `ended at tick ${world.tick}`).toEqual({ state: 'over', winner: 0 });
    expect(world.objectivesDone).toEqual([true]);
  }, 240_000);

  it('mission 6 (The Rival Banner) reaches an ending under the elimination rules', () => {
    const config = missionWorldConfig('rivalBanner');
    config.players = config.players.map((p, i) => (i === 0 ? { kind: 'ai' as const } : p));
    const world = createWorld(config);
    expect(world.players[1]!.strategy).toBe('steward');
    const brains = world.players.map((p) => new AiBrain(p.id, AI_STRATEGIES[p.strategy ?? 'steward'], world.map.size));
    for (let t = 0; t < 90_000 && world.outcome.state === 'playing'; t++) {
      const commands = [];
      for (const brain of brains) {
        if (!brain.shouldDecide(world.tick)) continue;
        for (const cmd of brain.decide(world)) commands.push({ playerId: brain.playerId, cmd });
      }
      tickWorld(world, commands);
    }
    expect(world.outcome.state, `still playing at tick ${world.tick}`).toBe('over');
  }, 480_000);

  it('the levy opens with its village standing and its lessons granted', () => {
    const world = createWorld(missionWorldConfig('levy'));
    const def = MISSION_DEFS.levy;
    for (const spec of def.prebuilt!) {
      expect(countBuilt(world, spec.type), `prebuilt ${spec.type} missing`).toBeGreaterThanOrEqual(
        def.prebuilt!.filter((s) => s.type === spec.type).length,
      );
    }
    expect(world.players[0]!.techs.researched).toEqual(['soldiery', 'cobbledBoots', 'ironworking']);
    expect(world.raidState.nextRaidTick).toBe(def.firstRaidTick);
    expect(stockOf(world, 'silver')).toBe(def.startStock!.silver);
    // And a mission with no clock override keeps the default — the
    // size-scaled peace period, since raid pacing follows the commutes.
    const finale = createWorld(missionWorldConfig('holdTheValley'));
    expect(finale.raidState.nextRaidTick).toBe(firstRaidTickFor(finale.map.play));
  });

  it('mission worlds are deterministic: same id, same world, tick for tick', () => {
    const a = createWorld(missionWorldConfig('levy'));
    const b = createWorld(missionWorldConfig('levy'));
    for (let t = 0; t < 1_000; t++) {
      tickWorld(a, []);
      tickWorld(b, []);
    }
    expect(hashWorld(a)).toBe(hashWorld(b));
  });

  it('mission fields ride the save', () => {
    const world = createWorld(missionWorldConfig('clearing'));
    for (let t = 0; t < 500; t++) tickWorld(world, []);
    const loaded = deserializeWorld(serializeWorld(world));
    expect(loaded.missionId).toBe('clearing');
    expect(loaded.objectivesDone).toEqual(world.objectivesDone);
    expect(hashWorld(loaded)).toBe(hashWorld(world));
    // A sandbox save carries no mission fields at all.
    const sandbox = deserializeWorld(serializeWorld(createWorld({ seed: 5, players: [{ kind: 'human' }] })));
    expect(sandbox.missionId).toBeUndefined();
    expect(sandbox.objectivesDone).toBeUndefined();
  });

  it('the campaign order is complete and the id gate refuses junk', () => {
    expect([...MISSION_ORDER].sort()).toEqual(Object.keys(MISSION_DEFS).sort());
    expect(nextMissionId('clearing')).toBe('breadAndWater');
    expect(nextMissionId('rivalBanner')).toBeUndefined();
    expect(parseMissionId('levy')).toBe('levy');
    expect(parseMissionId('constructor')).toBeUndefined(); // truthy on the prototype
    expect(parseMissionId('')).toBeUndefined();
    expect(parseMissionId(42)).toBeUndefined();
  });
});
