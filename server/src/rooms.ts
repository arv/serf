import type { WebSocket } from 'ws';
import { createWorld, type World } from '../../src/sim/world.ts';
import { tickWorld, type PlayerCommand } from '../../src/sim/tick.ts';
import { AiSeats } from '../../src/sim/aiSeats.ts';
import { TICK_MS } from '../../src/sim/defs/balance.ts';
import { MAX_SEATS, type LobbyConfig } from '../../src/protocol/lobby.ts';
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

/** Cap on a listing response — the browser has no pagination. */
const LIST_LIMIT = 20;

/**
 * Orders one client may submit in a single frame. A frame is one click's
 * worth of intent — the UI never sends more than a handful — so this is
 * only ever reached by something that is not playing the game.
 */
export const MAX_COMMANDS_PER_FRAME = 32;

/** Re-exported for index.ts; the number itself lives with the lobby wire
 * contract, which the client shares. */
export { MAX_SEATS };

export interface Room {
  code: string;
  state: 'lobby' | 'running';
  /** Open rooms are listed for anyone to join; closed ones need the code. */
  visibility: 'open' | 'closed';
  createdMs: number;
  /**
   * Match settings, host-edited from the War Council until the match
   * starts. Always a sanitized copy — the world is built from this, never
   * from anything straight off the wire.
   */
  config: LobbyConfig;
  /** In the lobby these are the humans only; the AI seats config asks for
   * are materialized at startMatch, so a joining human always outranks
   * a computer for a chair. */
  seats: Seat[];
  /**
   * The authoritative world. It exists only here — clients receive filtered
   * views of it and never simulate, which is what makes information cheating
   * impossible rather than merely inconvenient.
   */
  world?: World;
  /** Brains for this room's AI seats, run in-process next to the world. */
  ai?: AiSeats;
  matchStartMs?: number;
  /** Mirrors world.tick; -1 until the match starts (the PONG sentinel). */
  closedTick: number;
  /** Orders accepted since the last tick; applied at the next one. */
  queued: PlayerCommand[];
  lastVisionTick: number;
  /** Rolling cost of a pump, in ms — what says whether this process has room
   * for more matches. See serverStats(). */
  pumpMsAvg: number;
  pumpMsPeak: number;
  /** Pumps that threw, for log rate-limiting (see the clock in index.ts). */
  pumpErrors?: number;
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

export function createRoom(visibility: 'open' | 'closed', config: LobbyConfig): Room {
  const room: Room = {
    code: makeCode(),
    state: 'lobby',
    visibility,
    createdMs: Date.now(),
    config,
    seats: [],
    closedTick: -1,
    queued: [],
    lastVisionTick: -1,
    pumpMsAvg: 0,
    pumpMsPeak: 0,
  };
  rooms.set(room.code, room);
  return room;
}

export function getRoom(code: string): Room | undefined {
  return rooms.get(code.toUpperCase());
}

/**
 * Seat a room rebuilt from a persistence record (see persist.ts). Refused
 * when the code is already live: the snapshot is data off disk, and two
 * rooms under one code would cross their seat tokens.
 */
export function adoptRoom(room: Room): boolean {
  if (rooms.has(room.code)) return false;
  rooms.set(room.code, room);
  return true;
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

/**
 * Take a chair away again — a lobby seat whose occupant left for another
 * room. Only ever a lobby operation: playerId is the index into the world
 * the match will build, so the remaining seats renumber, which a running
 * room could not survive.
 */
export function removeSeat(room: Room, seat: Seat): void {
  const at = room.seats.indexOf(seat);
  if (at < 0) return;
  room.seats.splice(at, 1);
  room.seats.forEach((s, i) => (s.playerId = i));
}

/** Build the world and start the clock. The server generates it from the
 * room's own sanitized settings: with one simulator there is no
 * cross-engine worldgen risk, and no blob to ship. */
export function startMatch(room: Room): void {
  // The computer seats the host asked for, minus the chairs humans took —
  // AI fills in, it never holds a seat against a person.
  const aiFill = Math.max(0, Math.min(room.config.ai, MAX_SEATS - room.seats.length));
  for (let i = 0; i < aiFill; i++) addSeat(room, 'ai', null);
  room.world = createWorld({
    seed: room.config.seed,
    players: room.seats.map((s) => ({ kind: s.kind })),
    // Cheats are a single-player affair; a networked world never honors them.
    adminEnabled: false,
    banditsEnabled: room.config.bandits,
  });
  room.ai = new AiSeats(room.world);
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
  for (const cmd of commands) {
    // Everything queued is applied in one tick, on the thread every other
    // room ticks on. A backlog this deep is nobody playing, so the overflow
    // is dropped rather than allowed to stall the process.
    if (room.queued.length >= MAX_QUEUED) break;
    room.queued.push({ playerId: seat.playerId, cmd });
  }
}

/**
 * Orders a room may hold between ticks. Four seats clicking as fast as
 * hands allow is a handful; this is only reached by a client submitting
 * frames in a loop.
 */
const MAX_QUEUED = 256;

/**
 * How long a pump may take before it is worth complaining about. A room
 * costs well under a millisecond; ticking is only a fraction of the 50 ms
 * budget, and this process ticks every room on one thread, so a room that
 * regularly runs long is the signal that the box is full.
 */
const SLOW_PUMP_MS = 8;

/** Advance the world to wall-clock time and broadcast what changed. */
export function pumpRoom(room: Room, nowMs: number): void {
  const world = room.world;
  if (room.state !== 'running' || !world || room.matchStartMs === undefined) return;
  const target = Math.floor((nowMs - room.matchStartMs) / TICK_MS);
  if (target <= world.tick) return;
  const startedAt = performance.now();

  const ticks = Math.min(target - world.tick, MAX_CATCHUP);
  const deltas: MapDelta[] = [];
  const events: GameEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    const commands = room.queued;
    room.queued = [];
    // Brains decide from the state this tick starts in, and their orders
    // go in with the players' — no frame of hindsight.
    if (room.ai) commands.push(...room.ai.decide(world));
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

  const took = performance.now() - startedAt;
  // Exponential average: one slow pump is a GC pause, a sustained one is a
  // capacity problem, and only the second is worth acting on.
  room.pumpMsAvg = room.pumpMsAvg === 0 ? took : room.pumpMsAvg * 0.9 + took * 0.1;
  if (took > room.pumpMsPeak) room.pumpMsPeak = took;
  if (room.pumpMsAvg > SLOW_PUMP_MS) {
    console.warn(
      `[serf] room ${room.code} pumps slowly: ${room.pumpMsAvg.toFixed(1)}ms avg ` +
        `(${room.seats.length} seats, tick ${world.tick})`,
    );
    room.pumpMsAvg = 0; // re-arm rather than warn every pump
  }
}

/** A snapshot for /health: is this process comfortable? */
export function serverStats(): {
  rooms: number;
  running: number;
  seats: number;
  pumpMsAvg: number;
  pumpMsPeak: number;
} {
  let running = 0;
  let seats = 0;
  let avg = 0;
  let peak = 0;
  for (const room of rooms.values()) {
    seats += room.seats.length;
    if (room.state !== 'running') continue;
    running++;
    avg += room.pumpMsAvg;
    peak = Math.max(peak, room.pumpMsPeak);
  }
  return {
    rooms: rooms.size,
    running,
    seats,
    pumpMsAvg: running > 0 ? Number((avg / running).toFixed(3)) : 0,
    pumpMsPeak: Number(peak.toFixed(3)),
  };
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

/** One row of the start screen's room browser. */
export interface RoomListing {
  code: string;
  filled: number;
  total: number;
  ai: number;
  ageMs: number;
}

/**
 * Rooms a stranger may join: still in the lobby, and open. A room that has
 * started drops out of the list by construction — its state is 'running' —
 * which is what keeps the browser self-cleaning alongside deleteRoomIfDead.
 *
 * The room code is the identity. There are no player names anywhere in the
 * sim, and inventing one here would be inventing a whole social feature.
 */
export function listOpenRooms(nowMs: number): RoomListing[] {
  const out: RoomListing[] = [];
  for (const room of rooms.values()) {
    if (room.state !== 'lobby' || room.visibility !== 'open') continue;
    out.push({
      code: room.code,
      // Lobby seats are all human, and AI only fills what stays empty, so
      // a human can always join until the table itself is full.
      filled: room.seats.length,
      total: MAX_SEATS,
      ai: room.config.ai,
      ageMs: Math.max(0, nowMs - room.createdMs),
    });
  }
  // Newest first, then capped — a player wants the room someone just made.
  out.sort((a, z) => a.ageMs - z.ageMs);
  return out.slice(0, LIST_LIMIT);
}
