import {describe, expect, it} from 'vitest';
import {
  type Flight,
  type LedgerPlan,
  cubicBezier,
  flightAt,
  flightKeyframes,
} from './ledgerMorph.ts';

describe('cubicBezier', () => {
  it('pins the ends and is monotonic for an ease-out curve', () => {
    const ease = cubicBezier(0.2, 0.8, 0.2, 1);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    let last = 0;
    for (let i = 1; i <= 20; i++) {
      const v = ease(i / 20);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
    // Front-loaded: well past half way by a quarter of the time.
    expect(ease(0.25)).toBeGreaterThan(0.5);
  });

  it('is the identity for the linear curve', () => {
    const linear = cubicBezier(0, 0, 1, 1);
    for (const t of [0.1, 0.33, 0.5, 0.9]) expect(linear(t)).toBeCloseTo(t, 6);
  });
});

// The strip at y 20..50, x 400..900; the sheet grows to 300..1000 and
// down to y 250, so its bottom edge travels 200.
const PLAN: LedgerPlan = {
  drop: 200,
  from: {left: 400, right: 900},
  to: {left: 300, right: 1000},
  flights: [],
};
// A good on the strip at (500, 30) whose row rests at (320, 110): the row
// reaches the strip's line when the sheet is 1 - 80/200 = 0.6 open.
const WOOD: Flight = {
  name: 'ledger-icon-wood',
  strip: {x: 500, y: 30},
  row: {x: 320, y: 110},
  width: 14,
};

describe('flightAt', () => {
  it('starts on the strip and rests in its row', () => {
    expect(flightAt(WOOD, PLAN, 0)).toMatchObject({x: 500, y: 30});
    expect(flightAt(WOOD, PLAN, 1)).toMatchObject({x: 320, y: 110});
  });

  it('crosses on the strip line until its row comes to meet it', () => {
    const halfway = flightAt(WOOD, PLAN, 0.3);
    expect(halfway.y).toBe(30);
    expect(halfway.x).toBeCloseTo(500 - 180 * 0.5);
    // Arrived in its column just as the row reaches the line…
    expect(flightAt(WOOD, PLAN, 0.6)).toMatchObject({x: 320, y: 30});
    // …and from there goes down with the row.
    const riding = flightAt(WOOD, PLAN, 0.8);
    expect(riding.x).toBe(320);
    expect(riding.y).toBeCloseTo(110 - 200 * 0.2);
  });

  it('is clipped by the widening box, never pushed', () => {
    // At 0.6 open the box's left side is at 340; the icon at 320 is
    // 20px outside it.
    const p = flightAt(WOOD, PLAN, 0.6);
    expect(p.clipLeft).toBeCloseTo(20);
    expect(p.clipRight).toBe(0);
    expect(flightAt(WOOD, PLAN, 1).clipLeft).toBe(0);
  });
});

describe('flightKeyframes', () => {
  it('runs forwards to open and backwards to close', () => {
    const open = flightKeyframes(WOOD, PLAN, true, 8);
    const close = flightKeyframes(WOOD, PLAN, false, 8);
    expect(open).toHaveLength(9);
    expect(open[0]).toMatchObject({
      offset: 0,
      transform: 'translate(500px, 30px)',
    });
    expect(open[8]).toMatchObject({
      offset: 1,
      transform: 'translate(320px, 110px)',
    });
    expect(close.at(0)?.transform).toBe(open.at(-1)?.transform);
    expect(close.at(-1)?.transform).toBe(open.at(0)?.transform);
  });
});
