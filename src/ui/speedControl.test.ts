import {beforeEach, describe, expect, it, vi} from 'vitest';

// speedControl reads the UI store, and the store reads the URL and the
// saved audio prefs the moment it is imported — hoisted for the same
// reason input/controls.test.ts hoists them: a beforeEach is far too late.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.location = {search: ''};
  g.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
});
import {
  REPLAY_GEAR,
  SPEED_GEARS,
  applySpeed,
  nudgeSpeed,
  speedGears,
  stepSpeed,
} from './speedControl';
import {resetMatchState, setReplayMode, setSpeed, speed} from './store';

/** A worker stand-in that only remembers what it was told to run at. */
function fakeHost(): {setSpeed: (s: number) => void; gears: number[]} {
  const host = {
    gears: [] as number[],
    setSpeed: (s: number) => void host.gears.push(s),
  };
  return host;
}

beforeEach(() => resetMatchState());

describe('the speed ladder', () => {
  it('gains a rung in a replay and loses it again', () => {
    expect(speedGears(false)).toEqual([...SPEED_GEARS]);
    expect(speedGears(true)).toEqual([...SPEED_GEARS, REPLAY_GEAR]);
  });

  it('stops at the ends rather than wrapping', () => {
    // − is how the village is held, so a + that wrapped round would be the
    // fast forward key pausing the game.
    expect(stepSpeed(0, -1, false)).toBe(0);
    expect(stepSpeed(3, 1, false)).toBe(3);
  });

  it('steps a rung at a time, into the replay gear and back', () => {
    expect(stepSpeed(0, 1, false)).toBe(1);
    expect(stepSpeed(1, 1, false)).toBe(3);
    expect(stepSpeed(3, 1, true)).toBe(REPLAY_GEAR);
    expect(stepSpeed(REPLAY_GEAR, -1, true)).toBe(3);
  });

  it('steps to the next rung past a gear the ladder does not hold', () => {
    // A replay's 8× carried into a skirmish ladder that stops at 3. The
    // rung below 8 is 3, not 1: counting by index used to land on 3 and
    // then step down again, skipping a gear on a single press of −.
    expect(stepSpeed(REPLAY_GEAR, -1, false)).toBe(3);
    // Nothing above it, so + stays on the top rung.
    expect(stepSpeed(REPLAY_GEAR, 1, false)).toBe(3);
  });
});

describe('the clock', () => {
  it('tells the worker and the HUD the same number', () => {
    const host = fakeHost();
    applySpeed(host, 3);
    expect(host.gears).toEqual([3]);
    expect(speed()).toBe(3);
  });

  it('holds the village on one press of −, and lets it go on +', () => {
    // The whole pause story: the bottom rung is the hold, so the pair that
    // walks the ladder is the pair that pauses — there is no third key.
    const host = fakeHost();
    nudgeSpeed(host, -1);
    expect(speed()).toBe(0);
    nudgeSpeed(host, 1);
    expect(speed()).toBe(1);
  });

  it('climbs out of a hold the HUD took, not just one a key took', () => {
    // The HUD's own speed clicks land here too (ui/mount.tsx), which is
    // why the keys read the clock rather than a memory of their own.
    const host = fakeHost();
    applySpeed(host, 0);
    nudgeSpeed(host, 1);
    expect(speed()).toBe(1);
  });

  it('walks a replay all the way down from its extra rung', () => {
    const host = fakeHost();
    setReplayMode(true);
    applySpeed(host, REPLAY_GEAR);
    nudgeSpeed(host, -1);
    expect(speed()).toBe(3);
    nudgeSpeed(host, -1);
    nudgeSpeed(host, -1);
    expect(speed()).toBe(0);
  });

  it('nudges from wherever the clock actually is', () => {
    const host = fakeHost();
    // Set behind this module's back, the way the mission briefing and the
    // end of a recording both pause the world.
    setSpeed(0);
    nudgeSpeed(host, 1);
    expect(speed()).toBe(1);
    nudgeSpeed(host, -1);
    expect(speed()).toBe(0);
  });
});
