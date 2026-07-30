import type { SimCommand } from '../sim/commands';

/**
 * The multiplayer wire protocol, shared verbatim by the browser worker and
 * the relay server (keep this file dependency-free: no vite-isms, no DOM,
 * no node imports). Lobby/control traffic is JSON text frames; the per-tick
 * hot messages below are little-endian binary frames. Command payloads stay
 * JSON inside the binary envelopes — commands are click-rate, the framing
 * is what runs at 20Hz.
 */

/** Client -> server: "run these commands at desiredTick". The server stamps
 * playerId from the authenticated seat — never trusted from the client. */
export interface CommandEnvelope {
  desiredTick: number;
  /** Per-player, monotonic from 0 — identifies the envelope forever. */
  seq: number;
  commands: SimCommand[];
}

/** Server -> client: canonical contents of a closed tick. */
export interface TurnRecord {
  tick: number;
  playerId: number;
  seq: number;
  commands: SimCommand[];
}

export const FRAME = {
  TURN_SUBMIT: 0x01,
  TURN: 0x02,
  HASH: 0x03,
  PING: 0x05,
  PONG: 0x06,
} as const;

export type NetFrame =
  | { kind: 'turnSubmit'; envelope: CommandEnvelope }
  | { kind: 'turn'; firstTick: number; tickCount: number; records: TurnRecord[] }
  | { kind: 'hash'; tick: number; hash: number }
  | { kind: 'ping'; clientTimeMs: number }
  | { kind: 'pong'; clientTimeEcho: number; serverTimeMs: number; serverClosedTick: number };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeTurnSubmit(envelope: CommandEnvelope): Uint8Array<ArrayBuffer> {
  const payload = textEncoder.encode(JSON.stringify(envelope.commands));
  const buf = new Uint8Array(9 + payload.length);
  const view = new DataView(buf.buffer);
  view.setUint8(0, FRAME.TURN_SUBMIT);
  view.setUint32(1, envelope.desiredTick, true);
  view.setUint32(5, envelope.seq, true);
  buf.set(payload, 9);
  return buf;
}

/**
 * One TURN frame covers `tickCount` contiguous closed ticks starting at
 * `firstTick` (live streaming: 1; rejoin batches: up to 512). An empty
 * closed tick costs 9 bytes.
 */
export function encodeTurn(firstTick: number, tickCount: number, records: TurnRecord[]): Uint8Array<ArrayBuffer> {
  const encoded = records.map((r) => ({
    r,
    payload: textEncoder.encode(JSON.stringify(r.commands)),
  }));
  let size = 9;
  for (const e of encoded) size += 9 + e.payload.length;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  view.setUint8(0, FRAME.TURN);
  view.setUint32(1, firstTick, true);
  view.setUint16(5, tickCount, true);
  view.setUint16(7, records.length, true);
  let off = 9;
  for (const { r, payload } of encoded) {
    view.setUint16(off, r.tick - firstTick, true);
    view.setUint8(off + 2, r.playerId);
    view.setUint32(off + 3, r.seq, true);
    view.setUint16(off + 7, payload.length, true);
    buf.set(payload, off + 9);
    off += 9 + payload.length;
  }
  return buf;
}

export function encodeHash(tick: number, hash: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(9);
  const view = new DataView(buf.buffer);
  view.setUint8(0, FRAME.HASH);
  view.setUint32(1, tick, true);
  view.setUint32(5, hash, true);
  return buf;
}

export function encodePing(clientTimeMs: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(5);
  const view = new DataView(buf.buffer);
  view.setUint8(0, FRAME.PING);
  view.setUint32(1, clientTimeMs >>> 0, true);
  return buf;
}

export function encodePong(
  clientTimeEcho: number,
  serverTimeMs: number,
  serverClosedTick: number,
): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(13);
  const view = new DataView(buf.buffer);
  view.setUint8(0, FRAME.PONG);
  view.setUint32(1, clientTimeEcho >>> 0, true);
  view.setUint32(5, serverTimeMs >>> 0, true);
  view.setUint32(9, serverClosedTick, true);
  return buf;
}

/** Parse any binary frame. Throws on malformed input — callers treat that
 * as a protocol error and drop the connection. */
export function decodeFrame(data: Uint8Array): NetFrame {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const type = view.getUint8(0);
  switch (type) {
    case FRAME.TURN_SUBMIT: {
      const desiredTick = view.getUint32(1, true);
      const seq = view.getUint32(5, true);
      const commands = JSON.parse(textDecoder.decode(data.subarray(9))) as SimCommand[];
      return { kind: 'turnSubmit', envelope: { desiredTick, seq, commands } };
    }
    case FRAME.TURN: {
      const firstTick = view.getUint32(1, true);
      const tickCount = view.getUint16(5, true);
      const recordCount = view.getUint16(7, true);
      const records: TurnRecord[] = [];
      let off = 9;
      for (let i = 0; i < recordCount; i++) {
        const tickDelta = view.getUint16(off, true);
        const playerId = view.getUint8(off + 2);
        const seq = view.getUint32(off + 3, true);
        const len = view.getUint16(off + 7, true);
        const commands = JSON.parse(
          textDecoder.decode(data.subarray(off + 9, off + 9 + len)),
        ) as SimCommand[];
        records.push({ tick: firstTick + tickDelta, playerId, seq, commands });
        off += 9 + len;
      }
      return { kind: 'turn', firstTick, tickCount, records };
    }
    case FRAME.HASH:
      return { kind: 'hash', tick: view.getUint32(1, true), hash: view.getUint32(5, true) };
    case FRAME.PING:
      return { kind: 'ping', clientTimeMs: view.getUint32(1, true) };
    case FRAME.PONG:
      return {
        kind: 'pong',
        clientTimeEcho: view.getUint32(1, true),
        serverTimeMs: view.getUint32(5, true),
        serverClosedTick: view.getUint32(9, true),
      };
    default:
      throw new Error(`unknown frame type 0x${type.toString(16)}`);
  }
}
