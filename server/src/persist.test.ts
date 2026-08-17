import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAP_SIZE } from '../../src/shared/grid.ts';
import { tickWorld } from '../../src/sim/tick.ts';
import { serializeWorld } from '../../src/sim/save.ts';
import {
  TICK_MS,
  addSeat,
  adoptRoom,
  createRoom,
  deleteRoomIfDead,
  getRoom,
  pumpRoom,
  startMatch,
  sweepRooms,
} from './rooms.ts';
import { recomputeVision } from './sync.ts';
import { persistRooms, restorePersistedRooms, roomFromRecord, roomToRecord } from './persist.ts';

/** A running two-seat match (one human, one AI), a few hundred ticks in. */
function runningRoom(seed: number) {
  const room = createRoom('closed', { ai: 1, bandits: false, seed, size: DEFAULT_MAP_SIZE, bots: [] });
  const seat = addSeat(room, 'human', null);
  startMatch(room);
  for (let i = 0; i < 200; i++) tickWorld(room.world!, []);
  room.closedTick = room.world!.tick;
  recomputeVision(room);
  return { room, seat };
}

describe('room persistence', () => {
  it('a running room survives the record round-trip', () => {
    const { room, seat } = runningRoom(4242);
    const record = roomToRecord(room)!;
    // Through JSON, exactly as the disk holds it.
    const revived = roomFromRecord(JSON.parse(JSON.stringify(record)), Date.now());

    expect(serializeWorld(revived.world!)).toBe(serializeWorld(room.world!));
    expect(revived.seats.map((s) => s.kind)).toEqual(['human', 'ai']);
    expect(revived.seats[0]!.token).toBe(seat.token);
    expect(revived.seats.every((s) => !s.connected && s.ws === null)).toBe(true);
    expect(revived.config).toEqual(room.config);
    // Fog survives: the seat still knows everything it had explored.
    expect([...revived.seats[0]!.view!.vision.explored]).toEqual([
      ...seat.view!.vision.explored,
    ]);
  });

  it('the clock resumes where it paused, not fast-forwarded', () => {
    const { room } = runningRoom(9);
    const nowMs = Date.now();
    const revived = roomFromRecord(roomToRecord(room)!, nowMs);
    const tick = revived.world!.tick;
    // The restore instant maps to the tick the world stopped at...
    pumpRoom(revived, nowMs);
    expect(revived.world!.tick).toBe(tick);
    // ...and wall time advances it from there at the normal rate.
    pumpRoom(revived, nowMs + 5 * TICK_MS);
    expect(revived.world!.tick).toBe(tick + 5);
  });

  it('lobby rooms have no record — their tokens were never dealt', () => {
    const lobby = createRoom('open', { ai: 0, bandits: true, seed: 1, size: DEFAULT_MAP_SIZE, bots: [] });
    addSeat(lobby, 'human', null);
    expect(roomToRecord(lobby)).toBeUndefined();
  });

  it('adoption refuses a code that is already live', () => {
    const { room } = runningRoom(77);
    const revived = roomFromRecord(roomToRecord(room)!, Date.now());
    expect(adoptRoom(revived)).toBe(false);
  });

  it('a restored room nobody reclaims is swept like any other', () => {
    const { room } = runningRoom(31);
    const record = roomToRecord(room)!;
    // The old process's copy goes away (all humans gone, five minutes pass).
    deleteRoomIfDead(room);
    sweepRooms(Date.now() + 6 * 60_000);
    expect(getRoom(room.code)).toBeUndefined();

    const bootMs = Date.now();
    expect(adoptRoom(roomFromRecord(record, bootMs))).toBe(true);
    expect(getRoom(room.code)).toBeDefined();
    sweepRooms(bootMs + 6 * 60_000);
    expect(getRoom(room.code)).toBeUndefined();
  });

  it('rooms round-trip through the snapshot file', () => {
    process.env.SERF_STATE_DIR = mkdtempSync(join(tmpdir(), 'serf-persist-'));
    const { room, seat } = runningRoom(1234);
    expect(persistRooms()).toBeGreaterThanOrEqual(1);

    // The old process dies; its room goes with it.
    deleteRoomIfDead(room);
    sweepRooms(Date.now() + 6 * 60_000);
    expect(getRoom(room.code)).toBeUndefined();

    expect(restorePersistedRooms(Date.now())).toBeGreaterThanOrEqual(1);
    const revived = getRoom(room.code)!;
    expect(revived.state).toBe('running');
    expect(revived.seats[0]!.token).toBe(seat.token);
    expect(revived.world!.tick).toBe(room.world!.tick);
  });
});
