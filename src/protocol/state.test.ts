import { describe, expect, it } from 'vitest';
import { TILE_COUNT } from '../shared/grid';
import { decodeState, encodeCmd, encodeHot, encodeInit, encodeStruct } from './state';
import type { UnitSnapshot } from './sabLayout';
import type { MapSnapshot } from './messages';

function fakeMap(): MapSnapshot {
  const map: MapSnapshot = {
    terrain: new Uint8Array(TILE_COUNT),
    resource: new Uint8Array(TILE_COUNT),
    blocked: new Uint8Array(TILE_COUNT),
    pathLevel: new Uint8Array(TILE_COUNT),
    buildingAt: new Int16Array(TILE_COUNT),
    height: new Float32Array(TILE_COUNT),
  };
  for (let i = 0; i < TILE_COUNT; i++) {
    map.terrain[i] = i % 7;
    map.resource[i] = i % 5;
    map.blocked[i] = i % 2;
    map.pathLevel[i] = i % 3;
    // Negative values prove the signedness survives (-1 = no building).
    map.buildingAt[i] = i % 11 === 0 ? -1 : i % 3000;
    map.height[i] = i * 0.015625; // exact in binary32
  }
  return map;
}

describe('state frames', () => {
  it('round-trips the init frame, map arrays and all', () => {
    const map = fakeMap();
    const frame = decodeState(encodeInit(42, 3, map, { buildings: [{ id: 1 }] }));
    expect(frame?.kind).toBe('init');
    if (frame?.kind !== 'init') return;
    expect(frame.tick).toBe(42);
    expect(frame.playerId).toBe(3);
    expect(frame.json).toEqual({ buildings: [{ id: 1 }] });
    expect(frame.map.terrain).toEqual(map.terrain);
    expect(frame.map.resource).toEqual(map.resource);
    expect(frame.map.blocked).toEqual(map.blocked);
    expect(frame.map.pathLevel).toEqual(map.pathLevel);
    expect(frame.map.buildingAt).toEqual(map.buildingAt);
    expect(frame.map.height).toEqual(map.height);
  });

  it('decodes an init frame that is not byte-aligned in its buffer', () => {
    // WebSocket payloads arrive as views into a larger pooled buffer, so the
    // decoder must never assume a zero (or aligned) byteOffset.
    const map = fakeMap();
    const encoded = encodeInit(1, 0, map, null);
    const padded = new Uint8Array(encoded.length + 3);
    padded.set(encoded, 3);
    const frame = decodeState(padded.subarray(3));
    expect(frame?.kind).toBe('init');
    if (frame?.kind !== 'init') return;
    expect(frame.map.buildingAt).toEqual(map.buildingAt);
    expect(frame.map.height).toEqual(map.height);
  });

  it('round-trips the hot frame', () => {
    const units: UnitSnapshot[] = [
      {
        id: 1,
        x: 12.5,
        y: 0.25,
        kind: 2,
        owner: 0,
        hpPct: 255,
        carrying: 3,
        action: 1,
        workKind: 4,
        profession: 2,
      },
      {
        id: 9999,
        x: 63.75,
        y: 31.5,
        kind: 6,
        owner: 255, // BANDIT rides the byte raw
        hpPct: 0,
        carrying: 0,
        action: 3,
        workKind: 0,
        profession: 0,
      },
    ];
    const frame = decodeState(encodeHot(7, units));
    expect(frame?.kind).toBe('hot');
    if (frame?.kind !== 'hot') return;
    expect(frame.tick).toBe(7);
    expect(frame.units).toEqual(units);
  });

  it('round-trips an empty hot frame', () => {
    const frame = decodeState(encodeHot(0, []));
    expect(frame?.kind).toBe('hot');
    if (frame?.kind !== 'hot') return;
    expect(frame.units).toEqual([]);
  });

  it('round-trips struct and cmd frames', () => {
    const struct = decodeState(encodeStruct(11, { buildings: [], jobs: [] }));
    expect(struct).toEqual({ kind: 'struct', tick: 11, json: { buildings: [], jobs: [] } });

    const cmd = decodeState(encodeCmd(5, [{ kind: 'hireSerf' }]));
    expect(cmd).toEqual({ kind: 'cmd', seq: 5, commands: [{ kind: 'hireSerf' }] });
  });

  it('returns null for tags it does not own', () => {
    // The lockstep protocol shares the socket; unknown tags fall through
    // rather than being treated as corruption.
    expect(decodeState(new Uint8Array([0x01, 0, 0, 0, 0]))).toBeNull();
  });
});
