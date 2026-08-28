import {describe, expect, it} from 'vitest';
import {
  FramePacer,
  MOBILE_FPS_CAP,
  MOBILE_INTERACT_FPS_CAP,
} from './framePacer';

/** Run rAF timestamps at `hz` for one second, count frames the pacer keeps. */
function keptPerSecond(pacer: FramePacer, hz: number, boost = false): number {
  const step = 1000 / hz;
  let kept = 0;
  for (let i = 0; i * step < 1000; i++) {
    if (pacer.due(i * step, boost)) kept++;
  }
  return kept;
}

describe('FramePacer', () => {
  it('uncapped keeps every frame', () => {
    expect(keptPerSecond(new FramePacer(null), 90)).toBe(90);
  });

  it('runs the very first frame', () => {
    expect(new FramePacer(MOBILE_FPS_CAP).due(0)).toBe(true);
  });

  it.each([60, 90, 120])('holds the cap on a %d Hz display', hz => {
    const kept = keptPerSecond(new FramePacer(MOBILE_FPS_CAP), hz);
    // The cap divides all three rates evenly, so it should land exactly —
    // ±1 for the fencepost at the second's edge.
    expect(Math.abs(kept - MOBILE_FPS_CAP)).toBeLessThanOrEqual(1);
  });

  it('rides through rAF timestamp jitter without slipping frames', () => {
    // 90 Hz with each callback up to ±2ms off the grid; a naive
    // elapsed >= interval check slips to ~27 fps under this.
    const pacer = new FramePacer(MOBILE_FPS_CAP);
    const step = 1000 / 90;
    let kept = 0;
    for (let i = 0; i * step < 1000; i++) {
      const jitter = 2 * Math.sin(i * 12.9898); // deterministic pseudo-noise
      if (pacer.due(i * step + jitter)) kept++;
    }
    expect(Math.abs(kept - MOBILE_FPS_CAP)).toBeLessThanOrEqual(2);
  });

  it('has no boost to give unless it was given one', () => {
    // The one-argument constructor is a plain cap either way it is asked.
    expect(
      keptPerSecond(new FramePacer(MOBILE_FPS_CAP), 120, true),
    ).toBeLessThanOrEqual(MOBILE_FPS_CAP + 1);
  });

  it('lifts the cap for the frames a gesture asks for', () => {
    const pacer = new FramePacer(MOBILE_FPS_CAP, MOBILE_INTERACT_FPS_CAP);
    expect(
      Math.abs(keptPerSecond(pacer, 120, true) - MOBILE_INTERACT_FPS_CAP),
    ).toBeLessThanOrEqual(1);
  });

  it('boosts a 90 Hz panel to a steady 45 — the rate 60 comes out to there', () => {
    const pacer = new FramePacer(MOBILE_FPS_CAP, MOBILE_INTERACT_FPS_CAP);
    expect(Math.abs(keptPerSecond(pacer, 90, true) - 45)).toBeLessThanOrEqual(
      1,
    );
  });

  it('drops back to the resting cap the moment the gesture stops asking', () => {
    const pacer = new FramePacer(MOBILE_FPS_CAP, MOBILE_INTERACT_FPS_CAP);
    // Mid-swipe on a 120 Hz panel: every other frame.
    expect(pacer.due(0, true)).toBe(true);
    expect(pacer.due(8.3, true)).toBe(false);
    expect(pacer.due(16.6, true)).toBe(true);
    // Finger up. The next frame is 8.3ms along, which the resting cap
    // holds — and it keeps holding until a whole 30 Hz frame has passed.
    expect(pacer.due(25)).toBe(false);
    expect(pacer.due(33.3)).toBe(false);
    expect(pacer.due(50)).toBe(true);
  });

  it('an uncapped boost still writes down the frames it spends', () => {
    // The resting cap has to hold across the handover: a boost that kept
    // no mark would let a capped frame follow a boosted one immediately.
    const pacer = new FramePacer(MOBILE_FPS_CAP, null);
    expect(pacer.due(0, true)).toBe(true);
    expect(pacer.due(8.3, true)).toBe(true); // uncapped: every frame
    expect(pacer.due(16.6, true)).toBe(true);
    // Gesture over, 16.6ms after the last frame drawn — not a 30 Hz frame.
    expect(pacer.due(25)).toBe(false);
    expect(pacer.due(50)).toBe(true);
  });

  it('recovers cleanly after a long stall', () => {
    const pacer = new FramePacer(MOBILE_FPS_CAP);
    expect(pacer.due(0)).toBe(true);
    // Tab hidden for ten seconds: the first frame back is due immediately.
    expect(pacer.due(10_000)).toBe(true);
    // And the cadence resumes from there, not from the stale schedule.
    expect(pacer.due(10_000 + 11.1)).toBe(false);
    expect(pacer.due(10_000 + 33.3)).toBe(true);
  });
});
