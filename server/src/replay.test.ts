import { describe, expect, it } from 'vitest';
import { parseReplay } from '../../src/app/replay.ts';
import { REPLAY_VERSION } from '../../src/shared/replayVersion.ts';
import { deserializeWorld, serializeWorld } from '../../src/sim/save.ts';
import { createWorld } from '../../src/sim/world.ts';
import { tickWorld, type PlayerCommand } from '../../src/sim/tick.ts';
import type { SimCommand } from '../../src/sim/commands.ts';
import type { ReplayData } from '../../src/app/replay.ts';
import {
  TICK_MS,
  addSeat,
  createRoom,
  pumpRoom,
  queueCommands,
  replayFor,
  startMatch,
  type Room,
  type Seat,
} from './rooms.ts';
import { roomFromRecord, roomToRecord } from './persist.ts';

/** Pump exactly `ticks` ticks, one per call, on the room's own clock. */
function advance(room: Room, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    pumpRoom(room, room.matchStartMs! + (room.world!.tick + 1) * TICK_MS);
  }
}

let seq = 0;
function order(room: Room, seat: Seat, ...commands: SimCommand[]): void {
  queueCommands(room, seat, ++seq, commands);
}

/** Re-run a parsed replay the way the client's sim worker does: boot from
 * its loadData or config and feed the logged commands at their ticks. No
 * AiSeats anywhere — the log already holds the brains' moves. */
function playBack(replay: ReplayData) {
  const world =
    replay.loadData !== undefined ? deserializeWorld(replay.loadData) : createWorld(replay.config);
  let cursor = 0;
  while (world.tick < replay.endTick) {
    const executed: PlayerCommand[] = [];
    while (cursor < replay.commands.length && replay.commands[cursor]!.tick === world.tick) {
      executed.push(...replay.commands[cursor]!.commands);
      cursor++;
    }
    tickWorld(world, executed);
  }
  return world;
}

describe('server replay recording', () => {
  it('is withheld while the match is undecided', () => {
    const room = createRoom('closed', { ai: 1, bandits: false, seed: 555, bots: [] });
    const seat = addSeat(room, 'human', null);
    startMatch(room);
    advance(room, 20);
    expect(replayFor(room, seat)).toBeNull();
  });

  it('reproduces the pumped match without re-running the AI', () => {
    const room = createRoom('closed', { ai: 1, bandits: false, seed: 900, bots: [] });
    const seat = addSeat(room, 'human', null);
    startMatch(room);

    advance(room, 50);
    order(room, seat, { kind: 'hireSerf' });
    advance(room, 100);
    order(room, seat, { kind: 'moveUnits', unitIds: [7, 8], x: 20, y: 20 });
    order(room, seat, { kind: 'placeBuilding', building: 'well', x: 30, y: 30 });
    advance(room, 250);

    const expected = serializeWorld(room.world!);
    // The gate wants a decided match; the test decides it by fiat. Captured
    // `expected` first — playback cannot know about this mutation.
    room.world!.outcome = { state: 'over', winner: 0 };

    const data = replayFor(room, seat)!;
    expect(data).not.toBeNull();
    const replay = parseReplay(data)!;
    expect(replay).not.toBeNull();
    expect(replay.replayVersion).toBe(REPLAY_VERSION);
    expect(replay.config.myPlayerId).toBe(seat.playerId);
    expect(replay.endTick).toBe(room.world!.tick);
    // The AI seat's moves are in the log, not left for playback to invent.
    expect(replay.commands.some((e) => e.commands.some((c) => c.playerId === 1))).toBe(true);

    expect(serializeWorld(playBack(replay))).toBe(expected);
  });

  it('carries the log across a same-version restore, whole match intact', () => {
    const room = createRoom('closed', { ai: 1, bandits: false, seed: 4141, bots: [] });
    const seat = addSeat(room, 'human', null);
    startMatch(room);
    advance(room, 60);
    order(room, seat, { kind: 'hireSerf' });
    advance(room, 60);

    // Deploy under the same version: the log rides the snapshot and keeps
    // being written; the brains being rebuilt doesn't matter, since their
    // moves land in the log as they actually happen.
    const record = roomToRecord(room)!;
    const revived = roomFromRecord(JSON.parse(JSON.stringify(record)), Date.now());
    expect(revived.replay?.loadData).toBeUndefined();

    const seat2 = revived.seats[0]!;
    advance(revived, 40);
    order(revived, seat2, { kind: 'moveUnits', unitIds: [3], x: 10, y: 12 });
    advance(revived, 100);

    const expected = serializeWorld(revived.world!);
    revived.world!.outcome = { state: 'over', winner: 0 };

    const replay = parseReplay(replayFor(revived, seat2)!)!;
    // From the very beginning: pre-restore commands are in the log too.
    expect(replay.loadData).toBeUndefined();
    expect(replay.commands[0]!.tick).toBeLessThan(120);

    expect(serializeWorld(playBack(replay))).toBe(expected);
  });

  it('rebases onto the snapshot when the version changed across the deploy', () => {
    const room = createRoom('closed', { ai: 1, bandits: false, seed: 660, bots: [] });
    const seat = addSeat(room, 'human', null);
    startMatch(room);
    advance(room, 80);
    order(room, seat, { kind: 'hireSerf' });
    advance(room, 40);

    const record = roomToRecord(room)!;
    // The next process runs a different build: its sim cannot be trusted
    // to re-simulate the old ticks, so the recording restarts from the
    // snapshot world itself.
    const tampered = JSON.parse(JSON.stringify(record)) as typeof record;
    tampered.replay!.replayVersion = REPLAY_VERSION - 1;
    const revived = roomFromRecord(tampered, Date.now());
    expect(revived.replay?.replayVersion).toBe(REPLAY_VERSION);
    expect(revived.replay?.loadData).toBe(record.world);
    expect(revived.replay?.commands).toEqual([]);

    const seat2 = revived.seats[0]!;
    advance(revived, 120);
    const expected = serializeWorld(revived.world!);
    revived.world!.outcome = { state: 'over', winner: 0 };

    const replay = parseReplay(replayFor(revived, seat2)!)!;
    expect(replay.loadData).toBe(record.world);
    expect(serializeWorld(playBack(replay))).toBe(expected);
  });
});
