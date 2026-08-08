import { describe, expect, it } from 'vitest';
import { FramePacer, MOBILE_FPS_CAP } from './framePacer';

/** Run rAF timestamps at `hz` for one second, count frames the pacer keeps. */
function keptPerSecond(pacer: FramePacer, hz: number): number {
  const step = 1000 / hz;
  let kept = 0;
  for (let i = 0; i * step < 1000; i++) {
    if (pacer.due(i * step)) kept++;
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

  it.each([60, 90, 120])('holds the cap on a %d Hz display', (hz) => {
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
