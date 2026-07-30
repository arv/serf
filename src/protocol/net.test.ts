import { describe, expect, it } from 'vitest';
import {
  decodeFrame,
  encodeHash,
  encodePing,
  encodePong,
  encodeTurn,
  encodeTurnSubmit,
  type TurnRecord,
} from './net';
import type { SimCommand } from '../sim/commands';

const SAMPLE: SimCommand[] = [
  { kind: 'placeBuilding', building: 'bambooHut', x: 12, y: 34 },
  { kind: 'moveUnits', unitIds: [5, 9, 12], x: 40, y: 41 },
  { kind: 'hireSerf' },
];

describe('net codecs', () => {
  it('TURN_SUBMIT round-trips', () => {
    const frame = decodeFrame(encodeTurnSubmit({ desiredTick: 12345, seq: 7, commands: SAMPLE }));
    expect(frame).toEqual({
      kind: 'turnSubmit',
      envelope: { desiredTick: 12345, seq: 7, commands: SAMPLE },
    });
  });

  it('TURN round-trips, empty and full', () => {
    const empty = decodeFrame(encodeTurn(500, 1, []));
    expect(empty).toEqual({ kind: 'turn', firstTick: 500, tickCount: 1, records: [] });
    expect(encodeTurn(500, 1, []).length).toBe(9); // the 20Hz idle cost

    const records: TurnRecord[] = [
      { tick: 500, playerId: 0, seq: 3, commands: SAMPLE },
      { tick: 500, playerId: 2, seq: 11, commands: [{ kind: 'hireSerf' }] },
      { tick: 507, playerId: 1, seq: 0, commands: [] },
    ];
    const full = decodeFrame(encodeTurn(500, 8, records));
    expect(full).toEqual({ kind: 'turn', firstTick: 500, tickCount: 8, records });
  });

  it('HASH / PING / PONG round-trip', () => {
    expect(decodeFrame(encodeHash(999, 0xdeadbeef))).toEqual({
      kind: 'hash',
      tick: 999,
      hash: 0xdeadbeef,
    });
    expect(decodeFrame(encodePing(123456))).toEqual({ kind: 'ping', clientTimeMs: 123456 });
    expect(decodeFrame(encodePong(123456, 654321, 4242))).toEqual({
      kind: 'pong',
      clientTimeEcho: 123456,
      serverTimeMs: 654321,
      serverClosedTick: 4242,
    });
  });

  it('rejects unknown frame types', () => {
    expect(() => decodeFrame(new Uint8Array([0x7f]))).toThrow(/unknown frame/);
  });
});
