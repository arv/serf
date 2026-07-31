import type { WebSocket } from 'ws';
import { createWorld, type World } from '../../src/sim/world.ts';
import { tickWorld, type PlayerCommand } from '../../src/sim/tick.ts';
import { TICK_MS } from '../../src/sim/defs/balance.ts';
import type { SimCommand } from '../../src/sim/commands.ts';
import type { GameEvent, MapDelta } from '../../src/sim/world.ts';
import { SeatView, recomputeVision, sendHot, sendStruct } from './sync.ts';

export { TICK_MS };

/**
 * A pump that woke up very late (GC, a suspended container) must not try to
 * simulate the whole gap in one go. Ticks are ~0.05 ms, so ten per 10 ms pump
 * still catches up 50x faster than real time.
 */
const MAX_CATCHUP = 10;

/**
 * Ticks between visibility recomputes. Stamping sight circles for every
 * seat is the most expensive thing the server does per room — far more
 * than the tick itself — and units cross a fraction of a tile in this
 * time, so recomputing at every tick buys nothing a player could notice.
 * The renderer throttles its own fog to ~12 Hz for the same reason.
 */
const VISION_INTERVAL = 2;

export interface Seat {
  playerId: number;
  kind: 'human' | 'ai';
  token: string;
  ws: WebSocket | null;
  lastSeq: number;
  connected: boolean;
  /** What this seat has observed, and what it has been told. Created when
   * the match starts — a lobby seat has nothing to see yet. */
  view?: SeatView;
}

export interface Room {
  code: string;
  state: 'lobby' | 'running';
  seats: Seat[];
  /**
   * The authoritative world. It exists only here — clients receive filtered
   * views of it and never simulate, which is what makes information cheating
   * impossible rather than merely inconvenient.
   */
  world?: World;
  matchStartMs?: number;
  /** Mirrors world.tick; -1 until the match starts (the PONG sentinel). */
  closedTick: number;
  /** Orders accepted since the last tick; applied at the next one. */
  queued: PlayerCommand[];
  lastVisionTick: number;
  /** When the last human disconnected (running rooms only; sweep target). */
  emptySinceMs?: number;
}

const rooms = new Map<string, Room>();

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

function makeCode(): string {
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return rooms.has(code) ? makeCode() : code;
}

export function createRoom(): Room {
  const room: Room = {
    code: makeCode(),
    state: 'lobby',
    seats: [],
    closedTick: -1,
    queued: [],
    lastVisionTick: -1,
  };
  rooms.set(room.code, room);
  return room;
}

export function getRoom(code: string): Room | undefined {
  return rooms.get(code.toUpperCase());
}

export function findSeatByToken(token: string): { room: Room; seat: Seat } | undefined {
  for (const room of rooms.values()) {
    const seat = room.seats.find((s) => s.token === token);
    if (seat) return { room, seat };
  }
  return undefined;
}

export function addSeat(room: Room, kind: 'human' | 'ai', ws: WebSocket | null): Seat {
  const seat: Seat = {
    playerId: room.seats.length,
    kind,
    token: crypto.randomUUID(),
    ws,
    lastSeq: -1,
    connected: ws !== null,
  };
  room.seats.push(seat);
  return seat;
}

/** Build the world and start the clock. The server generates it: with one
 * simulator there is no cross-engine worldgen risk, and no blob to ship. */
export function startMatch(room: Room, seed: number): void {
  room.world = createWorld({
    seed,
    players: room.seats.map((s) => ({ kind: s.kind })),
    // Cheats are a single-player affair; a networked world never honors them.
    adminEnabled: false,
    banditsEnabled: true,
  });
  room.state = 'running';
  room.closedTick = 0;
  room.matchStartMs = Date.now();
  for (const seat of room.seats) seat.view = new SeatView();
  // Seats must be able to see their own starting village before the first
  // frame goes out, or the opening init would arrive with an empty map.
  recomputeVision(room);
}

/**
 * Queue a client's orders for the next tick. `seq` only guards against
 * duplicates on a reconnect — ordering within a tick is by seat, and the
 * playerId is stamped here from the authenticated seat, never trusted from
 * the wire.
 */
export function queueCommands(room: Room, seat: Seat, seq: number, commands: SimCommand[]): void {
  if (seq <= seat.lastSeq) return; // already applied (reconnect replay)
  seat.lastSeq = seq;
  for (const cmd of commands) room.queued.push({ playerId: seat.playerId, cmd });
}

/** Advance the world to wall-clock time and broadcast what changed. */
export function pumpRoom(room: Room, nowMs: number): void {
  const world = room.world;
  if (room.state !== 'running' || !world || room.matchStartMs === undefined) return;
  const target = Math.floor((nowMs - room.matchStartMs) / TICK_MS);
  if (target <= world.tick) return;

  const ticks = Math.min(target - world.tick, MAX_CATCHUP);
  const deltas: MapDelta[] = [];
  const events: GameEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    const commands = room.queued;
    room.queued = [];
    tickWorld(world, commands);
    // Drain every tick of the burst: these are outboxes, and the next tick
    // would otherwise pile onto news nobody has been handed yet.
    deltas.push(...world.pendingDeltas.splice(0));
    events.push(...world.pendingEvents.splice(0));
  }
  room.closedTick = world.tick;

  if (world.tick - room.lastVisionTick >= VISION_INTERVAL) {
    room.lastVisionTick = world.tick;
    recomputeVision(room);
  }

  // Exactly one hot frame per burst. The renderer reads movement by diffing
  // the two newest frames, so a duplicated tick reads as "standing still".
  sendHot(room);
  sendStruct(room, deltas, events);
}

export function deleteRoomIfDead(room: Room): void {
  const allGone = room.seats.filter((s) => s.kind === 'human').every((s) => !s.connected);
  if (!allGone) {
    room.emptySinceMs = undefined;
    return;
  }
  // Lobby rooms die at once; running matches linger — there is a window
  // where every lobby socket has closed and no worker socket has bound
  // yet (match start), and disconnected players may rejoin by token.
  if (room.state === 'lobby') rooms.delete(room.code);
  else room.emptySinceMs ??= Date.now();
}

/** Sweep long-abandoned running rooms. */
export function sweepRooms(nowMs: number): void {
  for (const room of rooms.values()) {
    if (room.emptySinceMs !== undefined && nowMs - room.emptySinceMs > 5 * 60_000) {
      rooms.delete(room.code);
    }
  }
}

export function roomsIterable(): Iterable<Room> {
  return rooms.values();
}
