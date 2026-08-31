import {describe, expect, it} from 'vitest';
import {DEFAULT_MAP_SIZE, tileCount} from '../shared/grid';
import * as CommandKind from '../sim/commandKindEnum.ts';
import type {MapSnapshot} from './messages';
import type {UnitSnapshot} from './sabLayout';
import {
  decodeState,
  encodeCmd,
  encodeHot,
  encodeInit,
  encodePing,
  encodePong,
  encodeStruct,
} from './state';

const TILES = tileCount(DEFAULT_MAP_SIZE);

function fakeMap(): MapSnapshot {
  const map: MapSnapshot = {
    size: DEFAULT_MAP_SIZE,
    play: DEFAULT_MAP_SIZE,
    terrain: new Uint8Array(TILES),
    resource: new Uint8Array(TILES),
    blocked: new Uint8Array(TILES),
    pathLevel: new Uint8Array(TILES),
    buildingAt: new Int16Array(TILES),
    height: new Float32Array(TILES),
  };
  for (let i = 0; i < TILES; i++) {
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
    const explored = new Uint8Array(TILES).map((_, i) => (i % 4 === 0 ? 1 : 0));
    const frame = decodeState(
      encodeInit(42, 3, map, explored, {buildings: [{id: 1}]}),
    );
    expect(frame?.kind).toBe('init');
    if (frame?.kind !== 'init') return;
    expect(frame.tick).toBe(42);
    expect(frame.playerId).toBe(3);
    expect(frame.json).toEqual({buildings: [{id: 1}]});
    expect(frame.map.terrain).toEqual(map.terrain);
    expect(frame.map.resource).toEqual(map.resource);
    expect(frame.map.blocked).toEqual(map.blocked);
    expect(frame.map.pathLevel).toEqual(map.pathLevel);
    expect(frame.map.buildingAt).toEqual(map.buildingAt);
    expect(frame.map.height).toEqual(map.height);
    expect(frame.explored).toEqual(explored);
  });

  it('decodes an init frame that is not byte-aligned in its buffer', () => {
    // WebSocket payloads arrive as views into a larger pooled buffer, so the
    // decoder must never assume a zero (or aligned) byteOffset.
    const map = fakeMap();
    const encoded = encodeInit(1, 0, map, new Uint8Array(TILES), null);
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
        maxHp: 120, // armoured: above the kind's number
        carrying: 3,
        action: 1,
        workKind: 4,
        profession: 2,
        facing: 64,
        targetDist: 40,
      },
      {
        id: 9999,
        x: 63.75,
        y: 31.5,
        kind: 6,
        owner: 255, // BANDIT rides the byte raw
        hpPct: 0,
        maxHp: 45,
        carrying: 0,
        action: 3,
        workKind: 0,
        profession: 0,
        facing: 0,
        targetDist: 0,
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
    const struct = decodeState(encodeStruct(11, {buildings: [], jobs: []}));
    expect(struct).toEqual({
      kind: 'struct',
      tick: 11,
      json: {buildings: [], jobs: []},
    });

    const cmd = decodeState(encodeCmd(5, [{kind: CommandKind.hireSerf}]));
    expect(cmd).toEqual({
      kind: 'cmd',
      seq: 5,
      commands: [{kind: CommandKind.hireSerf}],
    });
  });

  it('round-trips the clock probe', () => {
    expect(decodeState(encodePing(123456))).toEqual({
      kind: 'ping',
      clientTimeMs: 123456,
    });
    expect(decodeState(encodePong(123456, 999))).toEqual({
      kind: 'pong',
      clientTimeEcho: 123456,
      serverTimeMs: 999,
    });
  });

  it('returns null for tags it does not own', () => {
    expect(decodeState(new Uint8Array([0x7f, 0, 0, 0, 0]))).toBeNull();
  });

  it('drops a corrupt init frame instead of allocating for it', () => {
    const good = encodeInit(1, 0, fakeMap(), new Uint8Array(TILES), null);

    // An impossible map size (the u16 at offset 10 maxed out) must not
    // reach the tile-array allocations.
    const oversize = good.slice();
    new DataView(oversize.buffer).setUint16(10, 0xffff, true);
    expect(decodeState(oversize)).toBeNull();

    // A frame that claims more map than it carries is refused, not read
    // off the end of the buffer.
    expect(decodeState(good.subarray(0, good.length - 1000))).toBeNull();
  });
});
