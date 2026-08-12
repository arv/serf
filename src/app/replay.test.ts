import { describe, expect, it } from 'vitest';
import { parseReplay, replayName, serializeReplay, REPLAY_FORMAT, type ReplayData } from './replay';
import { AiSeats } from '../sim/aiSeats';
import { createWorld, type World, type WorldConfig } from '../sim/world';
import { tickWorld, type PlayerCommand } from '../sim/tick';
import type { SimCommand } from '../sim/commands';

function sample(): ReplayData {
  return {
    format: REPLAY_FORMAT,
    savedAt: '2026-08-12T10:00:00.000Z',
    config: { seed: 42, players: [{ kind: 'human' }, { kind: 'ai' }], myPlayerId: 0 },
    commands: [
      { tick: 10, commands: [{ playerId: 0, cmd: { kind: 'hireSerf' } }] },
      {
        tick: 25,
        commands: [{ playerId: 0, cmd: { kind: 'placeBuilding', building: 'well', x: 3, y: 4 } }],
      },
    ],
    advice: [{ tick: 40, playerId: 1, override: { serfTarget: 12 } }],
    endTick: 500,
  };
}

describe('replay format', () => {
  it('round-trips through serialize/parse', () => {
    const data = sample();
    expect(parseReplay(serializeReplay(data))).toEqual(data);
  });

  it('rejects documents that are not replays', () => {
    expect(parseReplay('not json')).toBeNull();
    expect(parseReplay('{}')).toBeNull();
    expect(parseReplay(JSON.stringify({ format: 'serf-save-v2' }))).toBeNull();
    expect(parseReplay(JSON.stringify({ format: REPLAY_FORMAT }))).toBeNull();
    expect(
      parseReplay(JSON.stringify({ format: REPLAY_FORMAT, config: { seed: 1 }, endTick: 5 })),
    ).toBeNull(); // players missing
  });

  it('screens garbled commands and keeps the rest', () => {
    const data = sample();
    const doc = JSON.parse(serializeReplay(data)) as {
      commands: { tick: number; commands: unknown[] }[];
    };
    doc.commands[0]!.commands.push(
      { playerId: 0, cmd: { kind: 'placeBuilding', building: 'bogus', x: 1, y: 1 } },
      { playerId: 'zero', cmd: { kind: 'hireSerf' } },
      'garbage',
    );
    const parsed = parseReplay(JSON.stringify(doc));
    expect(parsed).not.toBeNull();
    expect(parsed!.commands[0]!.commands).toEqual([{ playerId: 0, cmd: { kind: 'hireSerf' } }]);
  });

  it('restates ascending tick order on both logs', () => {
    const data = sample();
    data.commands.reverse();
    data.advice.reverse();
    const parsed = parseReplay(serializeReplay(data))!;
    expect(parsed.commands.map((e) => e.tick)).toEqual([10, 25]);
    expect(parsed.advice.map((e) => e.tick)).toEqual([40]);
  });

  it('names replays by datetime, filename-safe', () => {
    const name = replayName(new Date(2026, 7, 12, 14, 3, 5));
    expect(name).toBe('2026-08-12 14.03.05');
  });
});

/** Deep-comparable digest of sim state (see determinism.test.ts). */
function digest(world: World) {
  return {
    tick: world.tick,
    rngState: world.rngState,
    nextId: world.nextId,
    units: [...world.units.values()].map((u) => ({ ...u, path: u.path ? [...u.path] : null })),
    buildings: [...world.buildings.values()],
    blocked: [...world.map.blocked],
    wear: [...world.map.wear],
  };
}

const CONFIG: WorldConfig = { seed: 77, players: [{ kind: 'human' }, { kind: 'ai' }] };

function playerScript(tick: number): SimCommand[] {
  if (tick === 50) return [{ kind: 'hireSerf' }];
  if (tick === 120) return [{ kind: 'moveUnits', unitIds: [7, 8], x: 20, y: 20 }];
  if (tick === 121) return [{ kind: 'moveUnits', unitIds: [7], x: 30, y: 12 }];
  return [];
}

describe('replay determinism', () => {
  it('the recorded command log reproduces the live match, AI seats included', () => {
    // Live: the worker's loop — the player's commands recorded at the tick
    // they apply on, the AI deciding beside the world, nothing else stored.
    const live = createWorld(CONFIG);
    const liveAi = new AiSeats(live);
    const log: ReplayData['commands'] = [];
    for (let t = 0; t < 1500; t++) {
      const player: PlayerCommand[] = playerScript(live.tick).map((cmd) => ({ playerId: 0, cmd }));
      if (player.length > 0) log.push({ tick: live.tick, commands: player.slice() });
      player.push(...liveAi.decide(live));
      tickWorld(live, player);
    }

    // Playback through the wire format: same config, logged commands at
    // their ticks, the AI re-deciding from the identical world.
    const parsed = parseReplay(
      serializeReplay({ format: REPLAY_FORMAT, config: CONFIG, commands: log, advice: [], endTick: 1500 }),
    )!;
    const replayed = createWorld(parsed.config);
    const replayAi = new AiSeats(replayed);
    let cursor = 0;
    for (let t = 0; t < 1500; t++) {
      const executed: PlayerCommand[] = [];
      while (cursor < parsed.commands.length && parsed.commands[cursor]!.tick === replayed.tick) {
        executed.push(...parsed.commands[cursor]!.commands);
        cursor++;
      }
      executed.push(...replayAi.decide(replayed));
      tickWorld(replayed, executed);
    }

    expect(digest(replayed)).toEqual(digest(live));
  });
});
