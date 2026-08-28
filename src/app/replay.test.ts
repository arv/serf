import { describe, expect, it } from 'vitest';
import {
  parseReplay,
  readReplayVersion,
  serializeReplay,
  REPLAY_FORMAT,
  type ReplayData,
} from './replay';
import { AiSeats } from '../sim/aiSeats';
import { REPLAY_VERSION } from '../shared/replayVersion';
import { createWorld, type World, type WorldConfig } from '../sim/world';
import { tickWorld, type PlayerCommand } from '../sim/tick';
import type { SimCommand } from '../sim/commands';
import { BuildingTypeId } from '../sim/defs/buildings';
import { CommandKind } from '../sim/commands';
import { PlayerKind } from '../sim/player';

function sample(): ReplayData {
  return {
    format: REPLAY_FORMAT,
    replayVersion: REPLAY_VERSION,
    savedAt: '2026-08-12T10:00:00.000Z',
    config: { seed: 42, players: [{ kind: PlayerKind.human }, { kind: PlayerKind.ai }], myPlayerId: 0 },
    commands: [
      { tick: 10, commands: [{ playerId: 0, cmd: { kind: CommandKind.hireSerf } }] },
      {
        tick: 25,
        commands: [
          { playerId: 0, cmd: { kind: CommandKind.placeBuilding, building: BuildingTypeId.well, x: 3, y: 4 } },
          // An AI seat's move rides the same log — playback never runs brains.
          { playerId: 1, cmd: { kind: CommandKind.hireSerf } },
        ],
      },
    ],
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
    expect(parseReplay(JSON.stringify({ format: 'serf-replay-v1' }))).toBeNull(); // old format string
    expect(parseReplay(JSON.stringify({ format: REPLAY_FORMAT }))).toBeNull();
    const unversioned = { ...sample(), replayVersion: undefined };
    expect(parseReplay(JSON.stringify(unversioned))).toBeNull();
    expect(
      parseReplay(JSON.stringify({ format: REPLAY_FORMAT, replayVersion: 1, config: { seed: 1 }, endTick: 5 })),
    ).toBeNull(); // players missing
  });

  it('screens garbled commands and keeps the rest', () => {
    const data = sample();
    const doc = JSON.parse(serializeReplay(data)) as {
      commands: { tick: number; commands: unknown[] }[];
    };
    doc.commands[0]!.commands.push(
      { playerId: 0, cmd: { kind: CommandKind.placeBuilding, building: 'bogus', x: 1, y: 1 } },
      { playerId: 'zero', cmd: { kind: CommandKind.hireSerf } },
      'garbage',
    );
    const parsed = parseReplay(JSON.stringify(doc));
    expect(parsed).not.toBeNull();
    expect(parsed!.commands[0]!.commands).toEqual([{ playerId: 0, cmd: { kind: CommandKind.hireSerf } }]);
  });

  it('restates ascending tick order on the log', () => {
    const data = sample();
    data.commands.reverse();
    const parsed = parseReplay(serializeReplay(data))!;
    expect(parsed.commands.map((e) => e.tick)).toEqual([10, 25]);
  });

  it('carries the fog memory a save-resumed replay needs', () => {
    const data: ReplayData = {
      ...sample(),
      loadData: 'world-string',
      explored: 'AQID', // opaque here; the fog unpacks it at playback
    };
    const parsed = parseReplay(serializeReplay(data))!;
    expect(parsed.loadData).toBe('world-string');
    expect(parsed.explored).toBe('AQID');
    // A garbled grid must not cost the file its world — it is dropped, and
    // playback simply re-accumulates fog from the resumed tick.
    const bad = parseReplay(JSON.stringify({ ...data, explored: 42 }))!;
    expect(bad).not.toBeNull();
    expect(bad.explored).toBeUndefined();
    expect(bad.loadData).toBe('world-string');
  });

  it('exposes the version stamp from the file head alone', () => {
    const raw = serializeReplay(sample());
    expect(readReplayVersion(raw)).toBe(REPLAY_VERSION);
    expect(readReplayVersion('{}')).toBeUndefined();
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

const CONFIG: WorldConfig = { seed: 77, players: [{ kind: PlayerKind.human }, { kind: PlayerKind.ai }] };

function playerScript(tick: number): SimCommand[] {
  if (tick === 50) return [{ kind: CommandKind.hireSerf }];
  if (tick === 120) return [{ kind: CommandKind.moveUnits, unitIds: [7, 8], x: 20, y: 20 }];
  if (tick === 121) return [{ kind: CommandKind.moveUnits, unitIds: [7], x: 30, y: 12 }];
  return [];
}

describe('replay determinism', () => {
  it('the recorded log reproduces the live match without ever running the AI', () => {
    // Live: the worker's loop — brains decide beside the world, and the
    // log captures everything each tick executed, their moves included.
    const live = createWorld(CONFIG);
    const liveAi = new AiSeats(live);
    const log: ReplayData['commands'] = [];
    for (let t = 0; t < 1500; t++) {
      const executed: PlayerCommand[] = playerScript(live.tick).map((cmd) => ({ playerId: 0, cmd }));
      executed.push(...liveAi.decide(live));
      if (executed.length > 0) log.push({ tick: live.tick, commands: executed.slice() });
      tickWorld(live, executed);
    }

    // Playback through the wire format: same config, logged commands at
    // their ticks, and no AiSeats anywhere — the brains could have been
    // rewritten since and this must not care.
    const parsed = parseReplay(
      serializeReplay({
        format: REPLAY_FORMAT,
        replayVersion: REPLAY_VERSION,
        config: CONFIG,
        commands: log,
        endTick: 1500,
      }),
    )!;
    const replayed = createWorld(parsed.config);
    let cursor = 0;
    for (let t = 0; t < 1500; t++) {
      const executed: PlayerCommand[] = [];
      while (cursor < parsed.commands.length && parsed.commands[cursor]!.tick === replayed.tick) {
        executed.push(...parsed.commands[cursor]!.commands);
        cursor++;
      }
      tickWorld(replayed, executed);
    }

    expect(digest(replayed)).toEqual(digest(live));
  });
});
