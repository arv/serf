import { describe, expect, it } from 'vitest';
import { parseReplay } from '../../src/app/replay.ts';
import { AiSeats } from '../../src/sim/aiSeats.ts';
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
 * its loadData or config, feed logged commands at their ticks, let the AI
 * seats re-decide. Returns the world at endTick. */
function playBack(replay: ReplayData) {
  const world =
    replay.loadData !== undefined ? deserializeWorld(replay.loadData) : createWorld(replay.config);
  const ai = new AiSeats(world);
  let cursor = 0;
  while (world.tick < replay.endTick) {
    const executed: PlayerCommand[] = [];
    while (cursor < replay.commands.length && replay.commands[cursor]!.tick === world.tick) {
      executed.push(...replay.commands[cursor]!.commands);
      cursor++;
    }
    executed.push(...ai.decide(world));
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

  it('reproduces the pumped match, AI seats and all', () => {
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
    expect(replay.config.myPlayerId).toBe(seat.playerId);
    expect(replay.endTick).toBe(room.world!.tick);

    expect(serializeWorld(playBack(replay))).toBe(expected);
  });

  it('rebases onto the snapshot across a restore, so playback matches what players saw', () => {
    const room = createRoom('closed', { ai: 1, bandits: false, seed: 4141, bots: [] });
    const seat = addSeat(room, 'human', null);
    startMatch(room);
    advance(room, 60);
    order(room, seat, { kind: 'hireSerf' });
    advance(room, 60);

    // Deploy: the room goes to disk and comes back in a new process. Its
    // AI brains are rebuilt from the restored world, which is exactly what
    // a playback booted from the snapshot will do too.
    const record = roomToRecord(room)!;
    const revived = roomFromRecord(JSON.parse(JSON.stringify(record)), Date.now());
    expect(revived.replay?.loadData).toBe(record.world);

    const seat2 = revived.seats[0]!;
    advance(revived, 40);
    order(revived, seat2, { kind: 'moveUnits', unitIds: [3], x: 10, y: 12 });
    advance(revived, 100);

    const expected = serializeWorld(revived.world!);
    revived.world!.outcome = { state: 'over', winner: 0 };

    const replay = parseReplay(replayFor(revived, seat2)!)!;
    expect(replay.loadData).toBe(record.world);
    // The log speaks absolute ticks, so it starts where the snapshot did.
    expect(replay.commands[0]!.tick).toBeGreaterThanOrEqual(120);

    expect(serializeWorld(playBack(replay))).toBe(expected);
  });
});
