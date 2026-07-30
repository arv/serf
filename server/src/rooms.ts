import type { WebSocket } from 'ws';
import { encodeTurn, type CommandEnvelope, type TurnRecord } from '../../src/protocol/net.ts';

/** Milliseconds per tick — must match src/sim/defs/balance.ts TICK_MS. */
export const TICK_MS = 50;

export interface Seat {
  playerId: number;
  kind: 'human' | 'ai';
  token: string;
  ws: WebSocket | null;
  lastSeq: number;
  connected: boolean;
}

export interface Room {
  code: string;
  state: 'lobby' | 'running' | 'ended';
  seats: Seat[];
  worldBlob?: string;
  matchStartMs?: number;
  closedTick: number;
  pending: Map<number, TurnRecord[]>;
  /** One encoded TURN frame per closed tick — the rejoin/replay source. */
  history: Buffer[];
  /** Desync bookkeeping: tick -> seat -> hash (windowed). */
  hashes: Map<number, Map<number, number>>;
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
    pending: new Map(),
    history: [],
    hashes: new Map(),
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

/** Accept a submission: validate seq continuity, assign the earliest open
 * tick, and queue it. Returns false on a protocol violation. */
export function acceptSubmission(room: Room, seat: Seat, env: CommandEnvelope): boolean {
  if (env.seq !== seat.lastSeq + 1) return false;
  seat.lastSeq = env.seq;
  const tick = Math.max(env.desiredTick, room.closedTick + 1);
  let bucket = room.pending.get(tick);
  if (!bucket) room.pending.set(tick, (bucket = []));
  bucket.push({ tick, playerId: seat.playerId, seq: env.seq, commands: env.commands });
  return true;
}

/** Close every tick the wall clock has passed; broadcast one TURN frame per
 * tick and append it to history. */
export function pumpRoom(room: Room, nowMs: number): void {
  if (room.state !== 'running' || room.matchStartMs === undefined) return;
  const target = Math.floor((nowMs - room.matchStartMs) / TICK_MS);
  while (room.closedTick < target) {
    const tick = ++room.closedTick;
    const records = (room.pending.get(tick) ?? []).sort(
      (a, z) => a.playerId - z.playerId || a.seq - z.seq,
    );
    room.pending.delete(tick);
    const frame = Buffer.from(encodeTurn(tick, 1, records));
    room.history.push(frame);
    for (const seat of room.seats) {
      if (seat.connected && seat.ws) seat.ws.send(frame);
    }
  }
}

/** Compare hashes for a tick once every connected human seat reported. */
export function recordHash(
  room: Room,
  seat: Seat,
  tick: number,
  hash: number,
): { desync: boolean; hashes?: Record<number, number> } {
  let byId = room.hashes.get(tick);
  if (!byId) room.hashes.set(tick, (byId = new Map()));
  byId.set(seat.playerId, hash);
  const reporters = room.seats.filter((s) => s.kind === 'human' && s.connected);
  if (reporters.every((s) => byId.has(s.playerId))) {
    const values = new Set(byId.values());
    const result =
      values.size > 1
        ? { desync: true, hashes: Object.fromEntries(byId) as Record<number, number> }
        : { desync: false };
    // Window the bookkeeping: this tick is settled.
    room.hashes.delete(tick);
    for (const t of room.hashes.keys()) if (t < tick - 600) room.hashes.delete(t);
    return result;
  }
  return { desync: false };
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

/** Sweep long-abandoned running rooms (called from the pump loop). */
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
