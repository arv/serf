import { describe, expect, it } from 'vitest';
import { MovePredictor } from './predict';
import { DEFAULT_MAP_SIZE, tileCount, tileIdx } from '../shared/grid';
import { UNIT_DEFS } from '../sim/defs/units';
import { ACTION } from '../protocol/sabLayout';
import type { UnitSnapshot } from '../protocol/sabLayout';

const openMap = () => ({
  size: DEFAULT_MAP_SIZE,
  play: DEFAULT_MAP_SIZE,
  blocked: new Uint8Array(tileCount(DEFAULT_MAP_SIZE)),
  pathLevel: new Uint8Array(tileCount(DEFAULT_MAP_SIZE)),
});

function unit(id: number, x: number, y: number, owner = 0): UnitSnapshot {
  return {
    id,
    x,
    y,
    kind: UNIT_DEFS.serf.kindCode,
    owner,
    hpPct: 255,
    carrying: 0,
    action: ACTION.idle,
    workKind: 0,
    profession: 0,
  };
}

/** One server frame where nothing has moved — the dead window. */
const stillFrame = (u: UnitSnapshot): UnitSnapshot[] => [{ ...u }];

describe('move prediction', () => {
  it('starts the unit moving before the server has answered', () => {
    const p = new MovePredictor(openMap());
    const u = unit(1, 10.5, 10.5);
    p.order([1], 20, 10, new Map([[1, u]]));

    const frame = stillFrame(u);
    p.apply(frame, 0);

    // The server still says 10.5; we render it already under way.
    expect(frame[0]!.x).toBeGreaterThan(10.5);
    expect(frame[0]!.y).toBeCloseTo(10.5, 5);
  });

  it('predicts at the unit’s real speed, not faster', () => {
    const p = new MovePredictor(openMap());
    const u = unit(1, 10.5, 10.5);
    p.order([1], 30, 10, new Map([[1, u]]));

    const perTick = UNIT_DEFS.serf.speed / 20;
    const frame = stillFrame(u);
    p.apply(frame, 0);
    expect(frame[0]!.x - 10.5).toBeCloseTo(perTick, 4);
  });

  it('hands over as soon as the server picks the order up', () => {
    const p = new MovePredictor(openMap());
    const u = unit(1, 10.5, 10.5);
    p.order([1], 30, 10, new Map([[1, u]]));

    for (let i = 0; i < 3; i++) p.apply(stillFrame(u), 0);

    // Server begins moving it. From here we must track truth, not keep
    // running our own guess forward.
    let serverX = 10.5;
    let last = 0;
    for (let i = 0; i < 40; i++) {
      serverX += UNIT_DEFS.serf.speed / 20;
      const frame = [{ ...u, x: serverX }];
      p.apply(frame, 0);
      last = frame[0]!.x;
    }
    expect(last).toBeCloseTo(serverX, 2);
    expect(p.size).toBe(0); // settled and forgotten
  });

  it('smooths the handover instead of twitching backwards', () => {
    const p = new MovePredictor(openMap());
    const u = unit(1, 10.5, 10.5);
    p.order([1], 30, 10, new Map([[1, u]]));
    for (let i = 0; i < 5; i++) p.apply(stillFrame(u), 0);

    // The server finally moves it one tick's worth: our prediction is well
    // ahead. Rendered position must not jump back to the server's.
    const serverX = 10.5 + UNIT_DEFS.serf.speed / 20;
    const frame = [{ ...u, x: serverX }];
    p.apply(frame, 0);
    expect(frame[0]!.x).toBeGreaterThan(serverX);

    // ...and it converges rather than lingering.
    let x = frame[0]!.x;
    for (let i = 0; i < 20; i++) {
      const f = [{ ...u, x: serverX }];
      p.apply(f, 0);
      x = f[0]!.x;
    }
    expect(x).toBeCloseTo(serverX, 2);
  });

  it('gives up when the server never takes the order', () => {
    const p = new MovePredictor(openMap());
    const u = unit(1, 10.5, 10.5);
    p.order([1], 30, 10, new Map([[1, u]]));

    // Order refused: the server keeps reporting the unit where it was.
    let x = 0;
    for (let i = 0; i < 60; i++) {
      const frame = stillFrame(u);
      p.apply(frame, 0);
      x = frame[0]!.x;
    }
    // It must come back to where the server says it is, not drift forever.
    expect(x).toBeCloseTo(10.5, 2);
    expect(p.size).toBe(0);
  });

  it('never touches other players’ units', () => {
    const p = new MovePredictor(openMap());
    const mine = unit(1, 10.5, 10.5);
    const theirs = unit(2, 40.5, 40.5, 1);
    // Even if an order somehow named a rival's unit, it is not ours to move.
    p.order([1, 2], 20, 10, new Map([[1, mine], [2, theirs]]));

    const frame = [{ ...mine }, { ...theirs }];
    p.apply(frame, 0);
    expect(frame[1]!.x).toBe(40.5);
    expect(frame[1]!.y).toBe(40.5);
  });

  it('does not predict through walls', () => {
    const map = openMap();
    // A blocking wall across the unit's route.
    for (let y = 0; y < 64; y++) map.blocked[tileIdx(15, y, map.size)] = 1;
    const p = new MovePredictor(map);
    const u = unit(1, 10.5, 10.5);
    p.order([1], 20, 10, new Map([[1, u]]));

    for (let i = 0; i < 40; i++) p.apply(stillFrame(u), 0);
    const frame = stillFrame(u);
    p.apply(frame, 0);
    // findPath found no route, so nothing was predicted at all.
    expect(frame[0]!.x).toBeCloseTo(10.5, 5);
  });
});
