import type { WebSocket } from 'ws';
import { tileCount } from '../../src/shared/grid.ts';
import { REPLAY_VERSION } from '../../src/shared/replayVersion.ts';
import { createWorld, type World, type WorldConfig } from '../../src/sim/world.ts';
import { tickWorld, type PlayerCommand } from '../../src/sim/tick.ts';
import { AiSeats } from '../../src/sim/aiSeats.ts';
import { parseStrategyId } from '../../src/sim/defs/aiStrategies.ts';
import { TICK_MS } from '../../src/sim/defs/balance.ts';
import { REPLAY_FORMAT, serializeReplay, type ReplayData } from '../../src/app/replay.ts';
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
  /** The page behind this socket reports itself hidden (a backgrounded
   * phone). The seat keeps its chair and its socket — this is a battery
   * saver, not a disconnect — but no frames are sent until it returns,
   * when one init frame catches it up. Cleared on every fresh bind. */
  hidden?: boolean;
  /** What this seat has observed, and what it has been told. Created when
   * the match starts — a lobby seat has nothing to see yet, and an AI seat
   * never gets one: its brain reads the world directly, so a filtered view
   * would only be recomputed for nobody. */
  view?: SeatView;
  /** Debug overlay open on this seat's client ({t:'debug'} message) — only
   * then do its struct frames carry the jobs table. */
  wantsJobs?: boolean;
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
  /**
   * The match's replay log, written as it happens (see src/app/replay.ts):
   * what the world booted from plus every command each tick executed, the
   * AI seats' moves included — playback never re-runs the brains, so the
   * AI is free to change between builds. Started by startMatch and carried
   * through deploy snapshots while the version holds (persist.ts); a
   * cross-version restore rebases onto the snapshot world instead, since
   * the new sim cannot be trusted to re-simulate the old ticks. Handed out
   * by replayFor, and only once the match is decided — before that the log
   * is a full-information view of a fogged world.
   */
  replay?: {
    replayVersion: number;
    config: ReplayData['config'];
    loadData?: string;
    /** Beside a rebased loadData: each seat's explored grid as of that
     * snapshot, packed, indexed by playerId. Fog is per seat, so the
     * requester's is the one that ships — a replay must show the seat its
     * own memory of the map, never another's. */
    exploredBySeat?: string[];
    commands: ReplayData['commands'];
  };
  matchStartMs?: number;
  /** Mirrors world.tick; -1 until the match starts (the PONG sentinel). */
  closedTick: number;
  /** Orders accepted since the last tick; applied at the next one. */
  queued: PlayerCommand[];
  lastVisionTick: number;
  /**
   * When each tile last changed, stamped from the drained deltas as
   * `tick + 1` — offset so 0 stays free to mean "never" in the companion
   * SeatView.tileSentTick even at tick 0. Together they are what lets a
   * fog re-reveal of ground that never changed owe the seat nothing: idle
   * units wandering in and out of their own tiles otherwise re-queued
   * unchanged tiles forever, forcing structural frames at the full
   * cadence in a quiet match. Initialized to 1 ("changed before anything
   * was sent"), so every tile starts changed: correctness then never
   * depends on delta history a restore did not keep — a tile is sent once
   * when first revealed, and only re-sent when it truly changes.
   */
  tileChangedTick: Uint32Array;
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

/** Every seat by its token. Rejoins spike exactly when the process is
 * busiest (every client reconnect-loops through a deploy), and the token is
 * client-controlled — a scan over rooms × seats per attempt was both the
 * slow path and the cheap way to make the server walk it. */
const seatsByToken = new Map<string, { room: Room; seat: Seat }>();

/** The one door out of the room map, so the token index can never leak a
 * deleted room's seats. */
function dropRoom(room: Room): void {
  rooms.delete(room.code);
  for (const seat of room.seats) seatsByToken.delete(seat.token);
}

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
    tileChangedTick: new Uint32Array(tileCount(config.size)).fill(1),
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
  for (const seat of room.seats) seatsByToken.set(seat.token, { room, seat });
  return true;
}

export function findSeatByToken(token: string): { room: Room; seat: Seat } | undefined {
  return seatsByToken.get(token);
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
  seatsByToken.set(seat.token, { room, seat });
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
  seatsByToken.delete(seat.token);
  room.seats.forEach((s, i) => (s.playerId = i));
}

/**
 * The exact WorldConfig this room's match is built from — one function so
 * the world and its replay log can never describe two different matches.
 * Requires the AI seats to be materialized already (playerId order is the
 * players array).
 */
export function matchWorldConfig(room: Room): WorldConfig {
  // The council's picks, in the order the computer seats filled up. A seat
  // the host left on Random names nothing and the seed deals it one. The
  // fallback is for a room restored from a snapshot written before the
  // field existed: no picks recorded means every seat is dealt.
  const bots = room.config.bots ?? [];
  let picked = 0;
  return {
    seed: room.config.seed,
    // A running (or restored) world already knows its size; before the
    // match starts, the sanitized lobby setting is the promise.
    mapSize: room.world?.map.size ?? room.config.size,
    players: room.seats.map((s) => ({
      kind: s.kind,
      strategy: s.kind === 'ai' ? parseStrategyId(bots[picked++]) : undefined,
    })),
    // Cheats are a single-player affair; a networked world never honors them.
    adminEnabled: false,
    banditsEnabled: room.config.bandits,
  };
}

/** Build the world and start the clock. The server generates it from the
 * room's own sanitized settings: with one simulator there is no
 * cross-engine worldgen risk, and no blob to ship. */
export function startMatch(room: Room): void {
  // The computer seats the host asked for, minus the chairs humans took —
  // AI fills in, it never holds a seat against a person.
  const aiFill = Math.max(0, Math.min(room.config.ai, MAX_SEATS - room.seats.length));
  for (let i = 0; i < aiFill; i++) addSeat(room, 'ai', null);
  const config = matchWorldConfig(room);
  room.world = createWorld(config);
  // Re-sized to the world actually built: the array was allocated when the
  // room was created, and the host may have changed the lobby's map size
  // since — a stale, smaller array would silently drop the change stamps
  // for every high-index tile.
  room.tileChangedTick = new Uint32Array(tileCount(room.world.map.size)).fill(1);
  room.replay = { replayVersion: REPLAY_VERSION, config, commands: [] };
  room.ai = new AiSeats(room.world);
  room.state = 'running';
  room.closedTick = 0;
  room.matchStartMs = Date.now();
  // Human seats only: recomputing vision is the most expensive thing the
  // server does per room, and an AI seat would never consume its view — the
  // brain reads the world directly, and no socket ever asks for its frames.
  for (const seat of room.seats) {
    if (seat.kind === 'human') seat.view = new SeatView(room.world.map.size);
  }
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
    // Log everything this tick executes, the AI's moves included, under
    // the tick it applies on — playback replays the log verbatim rather
    // than re-running the brains.
    if (room.replay && commands.length > 0) {
      room.replay.commands.push({ tick: world.tick, commands: commands.slice() });
    }
    tickWorld(world, commands);
    // Drain every tick of the burst: these are outboxes, and the next tick
    // would otherwise pile onto news nobody has been handed yet.
    deltas.push(...world.pendingDeltas.splice(0));
    events.push(...world.pendingEvents.splice(0));
  }
  room.closedTick = world.tick;

  // Stamp before vision runs: the recompute is what turns a reveal into
  // owed tiles, and it must see this burst's changes as changed. The +1
  // keeps 0 meaning "never" on the seat side of the comparison.
  for (const d of deltas) room.tileChangedTick[d.idx] = world.tick + 1;

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

/**
 * One seat's copy of the room's replay, serialized for the wire — or null
 * while the match is still being played. The gate is the whole security
 * story: the log plus the config reconstructs the entire world at every
 * tick, so handing it out mid-match would hand out everything the fog
 * exists to withhold. Once the outcome is decided there is nothing left to
 * protect. myPlayerId is stamped per request, so playback opens on the
 * requester's own seat.
 */
export function replayFor(room: Room, seat: Seat): string | null {
  const world = room.world;
  if (!world || !room.replay || world.outcome.state !== 'over') return null;
  // replayVersion right after format — readReplayVersion scans only the
  // head of the file for it.
  return serializeReplay({
    format: REPLAY_FORMAT,
    replayVersion: room.replay.replayVersion,
    savedAt: new Date().toISOString(),
    config: { ...room.replay.config, myPlayerId: seat.playerId },
    ...(room.replay.loadData !== undefined ? { loadData: room.replay.loadData } : {}),
    ...(room.replay.exploredBySeat?.[seat.playerId]
      ? { explored: room.replay.exploredBySeat[seat.playerId] }
      : {}),
    commands: room.replay.commands,
    endTick: world.tick,
  });
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
  if (room.state === 'lobby') dropRoom(room);
  else room.emptySinceMs ??= Date.now();
}

/** Sweep long-abandoned running rooms. */
export function sweepRooms(nowMs: number): void {
  for (const room of rooms.values()) {
    if (room.emptySinceMs !== undefined && nowMs - room.emptySinceMs > 5 * 60_000) {
      dropRoom(room);
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
