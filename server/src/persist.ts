/**
 * Room persistence across relay restarts.
 *
 * Every deploy replaces this process, and rooms live only in its memory —
 * so a push used to kill every match in progress, and players saw "the
 * match is gone" mid-game. Now SIGTERM serializes each running room —
 * world, seat tokens, seat kinds, per-seat fog — into one snapshot file,
 * and the next boot restores them before the listener opens, so the tokens
 * clients are already retrying with are honored by the new process.
 *
 * The file must live somewhere that outlives the container image: on
 * Railway that is a volume, whose mount path arrives as
 * RAILWAY_VOLUME_MOUNT_PATH. Local dev falls back to server/.data, and
 * SERF_STATE_DIR overrides both (the tests point it at a scratch dir).
 *
 * The snapshot is not deleted after a restore. A deploy that crash-loops
 * then restores the same pre-deploy state on every attempt instead of
 * consuming it on the first; the cost is that a plain crash — no SIGTERM,
 * so no fresh snapshot — resurrects rooms from the previous deploy. Those
 * come back with every seat disconnected, so the five-minute sweep clears
 * them like any other abandoned room.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TILE_COUNT } from '../../src/shared/grid.ts';
import { deserializeWorld, serializeWorld } from '../../src/sim/save.ts';
import { AiSeats } from '../../src/sim/aiSeats.ts';
import type { EntityId } from '../../src/sim/entities.ts';
import type { LobbyConfig } from '../../src/protocol/lobby.ts';
import type { BuildingSnap } from '../../src/protocol/messages.ts';
import { REPLAY_VERSION } from '../../src/shared/replayVersion.ts';
import {
  TICK_MS,
  adoptRoom,
  matchWorldConfig,
  roomsIterable,
  type Room,
  type Seat,
} from './rooms.ts';
import { SeatView, recomputeVision } from './sync.ts';

interface PersistedSeat {
  kind: 'human' | 'ai';
  token: string;
  /** This seat's explored bits, packed and base64ed. Fog lives outside the
   * world (SeatVision accumulates it per seat), so without this a deploy
   * would hand every player back a freshly darkened map. */
  explored: string;
  /** Enemy buildings as this seat last saw them — the other half of the
   * seat's memory the world does not carry. */
  lastSeen: [EntityId, BuildingSnap][];
}

interface PersistedRoom {
  code: string;
  visibility: 'open' | 'closed';
  createdMs: number;
  config: LobbyConfig;
  /** In playerId order, like Room.seats — a running room never renumbers. */
  seats: PersistedSeat[];
  /** serializeWorld output, kept as the string that function already
   * speaks; deserializeWorld guards its own version on the way back. */
  world: string;
  /** The match's replay log so far, carried across the deploy. Optional:
   * snapshots from before the field existed simply have none. */
  replay?: Room['replay'];
}

interface Snapshot {
  version: 1;
  savedMs: number;
  rooms: PersistedRoom[];
}

const SNAPSHOT_FILE = 'rooms.json';

function stateDir(): string {
  return (
    process.env.SERF_STATE_DIR ??
    process.env.RAILWAY_VOLUME_MOUNT_PATH ??
    join(fileURLToPath(import.meta.url), '../../.data')
  );
}

function packBits(bits: Uint8Array): string {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) bytes[i >> 3]! |= 1 << (i & 7);
  }
  return Buffer.from(bytes).toString('base64');
}

function unpackBits(b64: string, into: Uint8Array): void {
  const bytes = Buffer.from(b64, 'base64');
  const n = Math.min(into.length, bytes.length * 8);
  for (let i = 0; i < n; i++) into[i] = (bytes[i >> 3]! >> (i & 7)) & 1;
}

/** A running room as its snapshot record; lobby rooms return undefined —
 * their occupants never learned a token (those go out at 'begin'), so
 * nobody could ever claim a restored lobby seat. */
export function roomToRecord(room: Room): PersistedRoom | undefined {
  if (room.state !== 'running' || !room.world) return undefined;
  return {
    code: room.code,
    visibility: room.visibility,
    createdMs: room.createdMs,
    config: room.config,
    seats: room.seats.map((s) => ({
      kind: s.kind,
      token: s.token,
      explored: packBits(s.view?.vision.explored ?? new Uint8Array(0)),
      lastSeen: s.view ? [...s.view.lastSeen] : [],
    })),
    world: serializeWorld(room.world),
    ...(room.replay ? { replay: room.replay } : {}),
  };
}

/** The room a record describes, rebuilt as the next process's own. Throws
 * on a record it cannot trust; the caller decides what a bad room costs. */
export function roomFromRecord(record: PersistedRoom, nowMs: number): Room {
  const world = deserializeWorld(record.world);
  if (record.seats.length !== world.players.length) {
    throw new Error(
      `room ${record.code}: ${record.seats.length} seats for ${world.players.length} players`,
    );
  }
  const seats = record.seats.map((s, i): Seat => {
    // Human seats only, the same rule as startMatch: an AI seat's view has
    // no consumer, and recomputing its vision would be the room's biggest
    // cost paid for nobody.
    let view: SeatView | undefined;
    if (s.kind === 'human') {
      view = new SeatView();
      unpackBits(s.explored, view.vision.explored);
      for (const [id, snap] of s.lastSeen) view.lastSeen.set(id, snap);
    }
    return {
      playerId: i,
      kind: s.kind,
      token: s.token,
      ws: null,
      // A fresh -1, not the old high-water mark: every socket died with the
      // old process, and a page reloaded during the deploy restarts its seq
      // at zero — a preserved counter would silently eat its first orders.
      lastSeq: -1,
      connected: false,
      ...(view ? { view } : {}),
    };
  });
  const room: Room = {
    code: record.code,
    state: 'running',
    visibility: record.visibility,
    createdMs: record.createdMs,
    config: record.config,
    seats,
    world,
    ai: new AiSeats(world),
    // Rebased so the same instant lands on the same tick: the clock is wall
    // time since match start, and the honest reading of a deploy is a pause
    // — preserving the old start would fast-forward the whole outage,
    // minutes of raids and hunger against players who could not possibly
    // have connected.
    matchStartMs: nowMs - world.tick * TICK_MS,
    closedTick: world.tick,
    queued: [],
    lastVisionTick: -1,
    // All-ones on purpose: the delta history that fed the old process's
    // stamps is gone, so every tile counts as changed until sent once.
    tileChangedTick: new Uint32Array(TILE_COUNT).fill(1),
    pumpMsAvg: 0,
    pumpMsPeak: 0,
    // Every seat starts disconnected, so the standard sweep applies: a room
    // nobody reclaims within five minutes of boot goes the usual way.
    emptySinceMs: nowMs,
  };
  // The replay log rides the snapshot, so a same-version restore simply
  // keeps writing it: every command the ticks executed is in there — the
  // AI seats' moves included, which is why the brains being rebuilt fresh
  // above doesn't matter; playback replays their recorded moves and never
  // consults them. What playback does re-run is the sim itself, so a
  // restore under a *different* version rebases instead: a new build
  // cannot be trusted to re-simulate the old build's ticks, but booting
  // from the very string this world was deserialized from reproduces the
  // restore exactly. (Snapshots from before replays existed rebase too.)
  room.replay =
    record.replay && record.replay.replayVersion === REPLAY_VERSION
      ? record.replay
      : {
          replayVersion: REPLAY_VERSION,
          config: matchWorldConfig(room),
          loadData: record.world,
          // The seats' fog as of this snapshot, kept packed exactly as it
          // sits on disk (the client unpacks the same format). A rebased
          // replay resumes mid-match, so without it playback would open on
          // a dark map the seat had long since scouted.
          exploredBySeat: record.seats.map((s) => s.explored),
          commands: [],
        };
  // Same reason startMatch does it: a rejoin can arrive before the first
  // pump, and its init frame must already know what this seat may see.
  recomputeVision(room);
  return room;
}

/** Write every running room to the snapshot file. Called on SIGTERM — and
 * always written, even empty, so a stale snapshot cannot outlive the state
 * it described. */
export function persistRooms(): number {
  const records: PersistedRoom[] = [];
  for (const room of roomsIterable()) {
    const record = roomToRecord(room);
    if (record) records.push(record);
  }
  const snapshot: Snapshot = { version: 1, savedMs: Date.now(), rooms: records };
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  // Whole file, then rename: a SIGKILL mid-write (the grace period running
  // out) leaves the previous snapshot intact rather than half of this one.
  const tmp = join(dir, `${SNAPSHOT_FILE}.tmp`);
  writeFileSync(tmp, JSON.stringify(snapshot));
  renameSync(tmp, join(dir, SNAPSHOT_FILE));
  return records.length;
}

/** Restore what the previous process left. One bad room costs that room,
 * not the boot: everything else in the snapshot still comes back. */
export function restorePersistedRooms(nowMs: number): number {
  let raw: string;
  try {
    raw = readFileSync(join(stateDir(), SNAPSHOT_FILE), 'utf8');
  } catch {
    return 0; // first boot, or nothing was ever persisted here
  }
  let restored = 0;
  try {
    const snapshot = JSON.parse(raw) as Snapshot;
    if (snapshot.version !== 1) {
      console.warn(`[serf] rooms snapshot is version ${snapshot.version}; ignoring it`);
      return 0;
    }
    for (const record of snapshot.rooms) {
      try {
        if (adoptRoom(roomFromRecord(record, nowMs))) restored++;
        else console.warn(`[serf] room ${record.code} is already live; snapshot copy dropped`);
      } catch (err) {
        console.warn(`[serf] room ${record.code} failed to restore:`, err);
      }
    }
  } catch (err) {
    console.warn('[serf] rooms snapshot unreadable:', err);
  }
  return restored;
}
