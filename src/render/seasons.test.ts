import {describe, expect, it} from 'vitest';
import {GROW_FROM, SOW_FROM} from '../sim/defs/balance';
import {cropAt} from './seasons';

describe("the field's look through the year", () => {
  it('stands full and gold through the harvest', () => {
    expect(cropAt(0)).toEqual({wheat: 1, shoots: 1});
    expect(cropAt(SOW_FROM / 2)).toEqual({wheat: 1, shoots: 1});
  });

  it('is down by the time the sowing starts, and stays down till the thaw', () => {
    const late = cropAt(SOW_FROM - 0.01);
    expect(late.wheat).toBeGreaterThan(0);
    expect(late.wheat).toBeLessThan(1);
    expect(cropAt(SOW_FROM)).toEqual({wheat: 0, shoots: 0});
    expect(cropAt((SOW_FROM + GROW_FROM) / 2)).toEqual({wheat: 0, shoots: 0});
    expect(cropAt(GROW_FROM)).toEqual({wheat: 0, shoots: 0});
  });

  it('comes up green with the thaw, then gold around the green', () => {
    // Green first: the shoots are up while the gold has not started.
    const early = cropAt(GROW_FROM + 0.03);
    expect(early.shoots).toBeGreaterThan(0.5);
    expect(early.wheat).toBe(0);
    // Ripening: the gold is coming up through a green crop already full.
    const ripening = cropAt(0.97);
    expect(ripening.shoots).toBe(1);
    expect(ripening.wheat).toBeGreaterThan(0);
    expect(ripening.wheat).toBeLessThan(1);
    // And ripe as the year turns into the harvest, with no jump across it.
    expect(cropAt(0.99999).wheat).toBeCloseTo(1, 3);
  });
});
