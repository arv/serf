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
  togglePause,
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
    // + must never be the key that pauses, and − never the one that bolts.
    expect(stepSpeed(0, -1, false)).toBe(0);
    expect(stepSpeed(3, 1, false)).toBe(3);
  });

  it('steps a rung at a time, into the replay gear and back', () => {
    expect(stepSpeed(0, 1, false)).toBe(1);
    expect(stepSpeed(1, 1, false)).toBe(3);
    expect(stepSpeed(3, 1, true)).toBe(REPLAY_GEAR);
    expect(stepSpeed(REPLAY_GEAR, -1, true)).toBe(3);
  });

  it('steps a gear the ladder no longer holds from where it would sit', () => {
    // A replay paused at 8× whose window becomes a skirmish: refusing to
    // move would be the one answer with no way out.
    expect(stepSpeed(REPLAY_GEAR, -1, false)).toBe(1);
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

  it('comes back off a pause at the gear it was watching at', () => {
    const host = fakeHost();
    applySpeed(host, 3);
    togglePause(host);
    expect(speed()).toBe(0);
    togglePause(host);
    expect(speed()).toBe(3);
  });

  it('remembers a gear the buttons set, not just one a key set', () => {
    // The HUD's own speed clicks land here too (ui/mount.tsx), which is
    // the whole reason the memory lives in this module.
    const host = fakeHost();
    applySpeed(host, 3);
    applySpeed(host, 0);
    togglePause(host);
    expect(speed()).toBe(3);
  });

  it('resumes at walking pace when the remembered gear is gone', () => {
    const host = fakeHost();
    setReplayMode(true);
    applySpeed(host, REPLAY_GEAR);
    togglePause(host);
    // The replay ends and a skirmish takes the same signals: 8× is not a
    // gear this ladder holds any more.
    setReplayMode(false);
    togglePause(host);
    expect(speed()).toBe(1);
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
