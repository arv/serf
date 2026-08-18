/**
 * Server -> client state frames, and the client's command frame back.
 *
 * This is the server-authoritative protocol: the server simulates and ships
 * state, rather than relaying inputs for every client to simulate (that is
 * src/protocol/net.ts, the lockstep protocol this replaces). Shared by the
 * server and the browser, so relative imports carry `.ts` and nothing here
 * touches the DOM.
 *
 * The split mirrors the one the client already had internally: units move
 * every tick and ride a packed binary frame; buildings, stock and tech
 * change slowly and ride JSON. Commands stay JSON too — they are
 * click-rate, and binary only pays on the 20 Hz frame.
 */
import { gridFor, MAX_MAP_SIZE, MIN_MAP_SIZE, tileCount } from '../shared/grid.ts';
import { AUX_STRIDE, type UnitSnapshot } from './sabLayout.ts';
import type { SimCommand } from '../sim/commands.ts';
import type { MapSnapshot } from './messages.ts';

/** Clock probe, kept from the lockstep protocol that this replaces — it is
 * the one frame that was never about relaying inputs. */
export const PING = 0x05;
export const PONG = 0x06;

export const STATE_INIT = 0x10;
export const STATE_HOT = 0x11;
export const STATE_STRUCT = 0x12;
export const CMD_SUBMIT = 0x13;

/** id (i32) + x (f32) + y (f32) + aux. */
const UNIT_BYTES = 12 + AUX_STRIDE;

/** Byte size of the map arrays in a STATE_INIT frame, in wire order. */
function mapBytes(tiles: number): number {
  return (
    tiles + // terrain    u8
    tiles + // resource   u8
    tiles + // blocked    u8
    tiles + // pathLevel  u8
    tiles * 2 + // buildingAt i16
    tiles * 4 + // height     f32
    tiles // explored   u8
  );
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function rawBytes(a: ArrayBufferView): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}

/**
 * Match start (and rejoin): the immutable map plus everything the client
 * needs to build its mirror. Sent once per client — the map arrays are tens
 * of KiB and worldgen never rewrites terrain or height.
 *
 * `explored` is the seat's ever-seen grid, straight from the server's own
 * visibility filter. It exists so a reload keeps its memory of the map:
 * the renderer's fog re-accumulates from live sight, and without this a
 * rejoining player found everything they had scouted dark again — and the
 * build gate refusing ground they had legitimately explored.
 */
export function encodeInit(
  tick: number,
  playerId: number,
  map: MapSnapshot,
  explored: Uint8Array,
  json: unknown,
): Uint8Array<ArrayBuffer> {
  const tiles = tileCount(map.size);
  const body = enc.encode(JSON.stringify(json));
  const out = new Uint8Array(14 + mapBytes(tiles) + body.length);
  const view = new DataView(out.buffer);
  out[0] = STATE_INIT;
  view.setUint32(1, tick, true);
  out[5] = playerId;
  view.setUint32(6, body.length, true);
  view.setUint16(10, map.size, true);
  view.setUint16(12, map.play, true);
  let off = 14;
  for (const arr of [map.terrain, map.resource, map.blocked, map.pathLevel]) {
    out.set(arr, off);
    off += tiles;
  }
  out.set(rawBytes(map.buildingAt), off);
  off += tiles * 2;
  out.set(rawBytes(map.height), off);
  off += tiles * 4;
  out.set(explored, off);
  off += tiles;
  out.set(body, off);
  return out;
}

export interface InitFrame {
  kind: 'init';
  tick: number;
  playerId: number;
  map: MapSnapshot;
  /** Ever-seen grid for this seat — fog memory across reloads. */
  explored: Uint8Array;
  json: unknown;
}

function decodeInit(data: Uint8Array): InitFrame {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tick = view.getUint32(1, true);
  const playerId = data[5]!;
  const jsonLen = view.getUint32(6, true);
  const size = view.getUint16(10, true);
  const play = view.getUint16(12, true);
  // Nothing off the wire earns an allocation on its own say-so: the sizes
  // must be ones the game can actually generate, and the frame must really
  // hold the arrays (and JSON) it claims — a corrupt or hostile frame gets
  // an exception here, not a multi-gigabyte Float32Array further down.
  if (
    play < MIN_MAP_SIZE ||
    play > MAX_MAP_SIZE ||
    play % 2 !== 0 || // play sizes are even by contract (resolveMapSize)
    size < play ||
    size > gridFor(MAX_MAP_SIZE) ||
    (size - play) % 2 !== 0
  ) {
    throw new Error(`corrupt init frame: map size ${size}/${play}`);
  }
  const tiles = tileCount(size);
  if (data.byteLength < 14 + mapBytes(tiles) + jsonLen) {
    throw new Error('corrupt init frame: truncated');
  }
  let off = 14;
  const u8 = (): Uint8Array => {
    // Copy, never view: the frame's byte offset has no alignment guarantee,
    // and the mirror owns these arrays for the rest of the match.
    const a = data.slice(off, off + tiles);
    off += tiles;
    return a;
  };
  const terrain = u8();
  const resource = u8();
  const blocked = u8();
  const pathLevel = u8();
  const buildingAt = new Int16Array(tiles);
  rawBytes(buildingAt).set(data.subarray(off, off + tiles * 2));
  off += tiles * 2;
  const height = new Float32Array(tiles);
  rawBytes(height).set(data.subarray(off, off + tiles * 4));
  off += tiles * 4;
  const explored = u8();
  const json = jsonLen > 0 ? JSON.parse(dec.decode(data.subarray(off, off + jsonLen))) : undefined;
  return {
    kind: 'init',
    tick,
    playerId,
    map: { size, play, terrain, resource, blocked, pathLevel, buildingAt, height },
    explored,
    json,
  };
}

/** The 20 Hz frame: every unit this client may see, packed. */
export function encodeHot(tick: number, units: Iterable<UnitSnapshot>): Uint8Array<ArrayBuffer> {
  const rows: readonly UnitSnapshot[] = Array.isArray(units) ? units : [...units];
  const out = new Uint8Array(7 + rows.length * UNIT_BYTES);
  const view = new DataView(out.buffer);
  out[0] = STATE_HOT;
  view.setUint32(1, tick, true);
  view.setUint16(5, rows.length, true);
  let off = 7;
  for (const u of rows) {
    view.setInt32(off, u.id, true);
    view.setFloat32(off + 4, u.x, true);
    view.setFloat32(off + 8, u.y, true);
    out[off + 12] = u.kind;
    out[off + 13] = u.owner;
    out[off + 14] = u.hpPct;
    out[off + 15] = u.carrying;
    out[off + 16] = u.action;
    out[off + 17] = u.workKind ?? 0;
    out[off + 18] = u.profession ?? 0;
    off += UNIT_BYTES;
  }
  return out;
}

export interface HotFrame {
  kind: 'hot';
  tick: number;
  units: UnitSnapshot[];
}

function decodeHot(data: Uint8Array): HotFrame {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tick = view.getUint32(1, true);
  const count = view.getUint16(5, true);
  const units: UnitSnapshot[] = new Array(count);
  let off = 7;
  for (let i = 0; i < count; i++) {
    units[i] = {
      id: view.getInt32(off, true),
      x: view.getFloat32(off + 4, true),
      y: view.getFloat32(off + 8, true),
      kind: data[off + 12]!,
      owner: data[off + 13]!,
      hpPct: data[off + 14]!,
      carrying: data[off + 15]!,
      action: data[off + 16]!,
      workKind: data[off + 17]!,
      profession: data[off + 18]!,
    };
    off += UNIT_BYTES;
  }
  return { kind: 'hot', tick, units };
}

/** The slow frame: buildings, stock, tech, events, map deltas. */
export function encodeStruct(tick: number, json: unknown): Uint8Array<ArrayBuffer> {
  return encodeStructBody(tick, JSON.stringify(json));
}

/** encodeStruct for a payload the caller already stringified — the server
 * compares the body against the last one sent before paying for a frame. */
export function encodeStructBody(tick: number, body: string): Uint8Array<ArrayBuffer> {
  const bytes = enc.encode(body);
  const out = new Uint8Array(5 + bytes.length);
  new DataView(out.buffer).setUint32(1, tick, true);
  out[0] = STATE_STRUCT;
  out.set(bytes, 5);
  return out;
}

export interface StructFrame {
  kind: 'struct';
  tick: number;
  json: unknown;
}

function decodeStruct(data: Uint8Array): StructFrame {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    kind: 'struct',
    tick: view.getUint32(1, true),
    json: JSON.parse(dec.decode(data.subarray(5))),
  };
}

/**
 * Client -> server orders. `seq` is monotonic per connection so the server
 * can drop duplicates on a reconnect; playerId is never on the wire — the
 * server stamps it from the authenticated seat.
 */
export function encodeCmd(seq: number, commands: SimCommand[]): Uint8Array<ArrayBuffer> {
  const body = enc.encode(JSON.stringify(commands));
  const out = new Uint8Array(5 + body.length);
  new DataView(out.buffer).setUint32(1, seq, true);
  out[0] = CMD_SUBMIT;
  out.set(body, 5);
  return out;
}

export interface CmdFrame {
  kind: 'cmd';
  seq: number;
  commands: SimCommand[];
}

function decodeCmd(data: Uint8Array): CmdFrame {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    kind: 'cmd',
    seq: view.getUint32(1, true),
    commands: JSON.parse(dec.decode(data.subarray(5))) as SimCommand[],
  };
}

export function encodePing(clientTimeMs: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(5);
  out[0] = PING;
  new DataView(out.buffer).setUint32(1, clientTimeMs >>> 0, true);
  return out;
}

export function encodePong(clientTimeEcho: number, serverTimeMs: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(9);
  const view = new DataView(out.buffer);
  out[0] = PONG;
  view.setUint32(1, clientTimeEcho >>> 0, true);
  view.setUint32(5, serverTimeMs >>> 0, true);
  return out;
}

export interface PingFrame {
  kind: 'ping';
  clientTimeMs: number;
}

export interface PongFrame {
  kind: 'pong';
  clientTimeEcho: number;
  serverTimeMs: number;
}

export type StateFrame = InitFrame | HotFrame | StructFrame | CmdFrame | PingFrame | PongFrame;

/** Returns null for tags this protocol does not own. */
export function decodeState(data: Uint8Array): StateFrame | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  switch (data[0]) {
    case PING:
      return { kind: 'ping', clientTimeMs: view.getUint32(1, true) };
    case PONG:
      return {
        kind: 'pong',
        clientTimeEcho: view.getUint32(1, true),
        serverTimeMs: view.getUint32(5, true),
      };
    case STATE_INIT:
      // A frame that fails validation (impossible size, truncated arrays,
      // unparseable JSON) is dropped like a foreign tag rather than thrown:
      // this runs in the net worker's socket handler, and one corrupt frame
      // must not crash the whole worker.
      try {
        return decodeInit(data);
      } catch {
        return null;
      }
    case STATE_HOT:
      return decodeHot(data);
    case STATE_STRUCT:
      return decodeStruct(data);
    case CMD_SUBMIT:
      return decodeCmd(data);
    default:
      return null;
  }
}
