import {describe, expect, it} from 'vitest';
import {parseReplay, type ReplayData} from '../../src/app/replay.ts';
import {DEFAULT_MAP_SIZE} from '../../src/shared/grid.ts';
import {REPLAY_VERSION} from '../../src/shared/replayVersion.ts';
import * as CommandKind from '../../src/sim/commandKindEnum.ts';
import type {SimCommand} from '../../src/sim/commands.ts';
import * as BuildingTypeId from '../../src/sim/defs/buildingTypeIdEnum.ts';
import * as MatchState from '../../src/sim/matchStateEnum.ts';
import {deserializeWorld, serializeWorld} from '../../src/sim/save.ts';
import {tickWorld, type PlayerCommand} from '../../src/sim/tick.ts';
import {createWorld} from '../../src/sim/world.ts';
import {roomFromRecord, roomToRecord} from './persist.ts';
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
    replay.loadData !== undefined
      ? deserializeWorld(replay.loadData)
      : createWorld(replay.config);
  let cursor = 0;
  while (world.tick < replay.endTick) {
    const executed: PlayerCommand[] = [];
    while (
      cursor < replay.commands.length &&
      replay.commands[cursor]!.tick === world.tick
    ) {
      executed.push(...replay.commands[cursor]!.commands);
      cursor++;
    }
    tickWorld(world, executed);
  }
  return world;
}

describe('server replay recording', () => {
  it('is withheld while the match is undecided', () => {
    const room = createRoom('closed', {
      ai: 1,
      bandits: false,
      seed: 555,
      size: DEFAULT_MAP_SIZE,
      bots: [],
    });
    const seat = addSeat(room, 'human', null);
    startMatch(room);
    advance(room, 20);
    expect(replayFor(room, seat)).toBeNull();
  });

  it('gives an eliminated human nothing while the others still fight', () => {
    // The information-leak case the gate exists for: the log reconstructs
    // the whole world at every tick, so a replay handed to a beaten player
    // while their rivals play on is a maphack by proxy — their game being
    // over is not the game being over.
    const room = createRoom('closed', {
      ai: 0,
      bandits: false,
      seed: 21,
      size: DEFAULT_MAP_SIZE,
      bots: [],
    });
    const winner = addSeat(room, 'human', null);
    addSeat(room, 'human', null);
    const fallen = addSeat(room, 'human', null);
    startMatch(room);
    advance(room, 50);
    // Seat 2's castle falls; seats 0 and 1 fight on, so the match is
    // still undecided — victory waits for a single banner.
    room.world!.players[fallen.playerId]!.alive = false;
    advance(room, 10);
    expect(room.world!.outcome.state).toBe(MatchState.playing);
    expect(replayFor(room, fallen)).toBeNull();
    // Decided: now every seat may take its copy home, the fallen included.
    room.world!.outcome = {state: MatchState.over, winner: winner.playerId};
    expect(replayFor(room, fallen)).not.toBeNull();
    expect(replayFor(room, winner)).not.toBeNull();
  });

  it('reproduces the pumped match without re-running the AI', () => {
    const room = createRoom('closed', {
      ai: 1,
      bandits: false,
      seed: 900,
      size: DEFAULT_MAP_SIZE,
      bots: [],
    });
    const seat = addSeat(room, 'human', null);
    startMatch(room);

    advance(room, 50);
    order(room, seat, {kind: CommandKind.hireSerf});
    advance(room, 100);
    order(room, seat, {
      kind: CommandKind.moveUnits,
      unitIds: [7, 8],
      x: 20,
      y: 20,
    });
    order(room, seat, {
      kind: CommandKind.placeBuilding,
      building: BuildingTypeId.well,
      x: 30,
      y: 30,
    });
    advance(room, 250);

    const expected = serializeWorld(room.world!);
    // The gate wants a decided match; the test decides it by fiat. Captured
    // `expected` first — playback cannot know about this mutation.
    room.world!.outcome = {state: MatchState.over, winner: 0};

    const data = replayFor(room, seat)!;
    expect(data).not.toBeNull();
    const replay = parseReplay(data)!;
    expect(replay).not.toBeNull();
    expect(replay.replayVersion).toBe(REPLAY_VERSION);
    expect(replay.config.myPlayerId).toBe(seat.playerId);
    expect(replay.endTick).toBe(room.world!.tick);
    // The AI seat's moves are in the log, not left for playback to invent.
    expect(
      replay.commands.some(e => e.commands.some(c => c.playerId === 1)),
    ).toBe(true);

    expect(serializeWorld(playBack(replay))).toBe(expected);
  });

  it('carries the log across a same-version restore, whole match intact', () => {
    const room = createRoom('closed', {
      ai: 1,
      bandits: false,
      seed: 4141,
      size: DEFAULT_MAP_SIZE,
      bots: [],
    });
    const seat = addSeat(room, 'human', null);
    startMatch(room);
    advance(room, 60);
    order(room, seat, {kind: CommandKind.hireSerf});
    advance(room, 60);

    // Deploy under the same version: the log rides the snapshot and keeps
    // being written; the brains being rebuilt doesn't matter, since their
    // moves land in the log as they actually happen.
    const record = roomToRecord(room)!;
    const revived = roomFromRecord(
      JSON.parse(JSON.stringify(record)),
      Date.now(),
    );
    expect(revived.replay?.loadData).toBeUndefined();

    const seat2 = revived.seats[0]!;
    advance(revived, 40);
    order(revived, seat2, {
      kind: CommandKind.moveUnits,
      unitIds: [3],
      x: 10,
      y: 12,
    });
    advance(revived, 100);

    const expected = serializeWorld(revived.world!);
    revived.world!.outcome = {state: MatchState.over, winner: 0};

    const replay = parseReplay(replayFor(revived, seat2)!)!;
    // From the very beginning: pre-restore commands are in the log too.
    expect(replay.loadData).toBeUndefined();
    expect(replay.commands[0]!.tick).toBeLessThan(120);

    expect(serializeWorld(playBack(replay))).toBe(expected);
  });

  it('rebases onto the snapshot when the version changed across the deploy', () => {
    const room = createRoom('closed', {
      ai: 1,
      bandits: false,
      seed: 660,
      size: DEFAULT_MAP_SIZE,
      bots: [],
    });
    const seat = addSeat(room, 'human', null);
    startMatch(room);
    advance(room, 80);
    order(room, seat, {kind: CommandKind.hireSerf});
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
    revived.world!.outcome = {state: MatchState.over, winner: 0};

    const replay = parseReplay(replayFor(revived, seat2)!)!;
    expect(replay.loadData).toBe(record.world);
    // A rebased replay opens mid-match, so it carries the seat's own fog
    // from the snapshot — otherwise playback would darken ground the
    // player had scouted long before the deploy.
    expect(replay.explored).toBe(record.seats[seat2.playerId]!.explored);
    expect(serializeWorld(playBack(replay))).toBe(expected);
  });
});
