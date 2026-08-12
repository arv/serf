import { describe, expect, it } from 'vitest';
import { HiddenSync, WAKE_GAP_MS } from './hiddenSync';

/** A sink that records every state it is told. */
function recordingSink(): { calls: boolean[]; sink: (hidden: boolean) => void } {
  const calls: boolean[] = [];
  return { calls, sink: (hidden) => calls.push(hidden) };
}

describe('HiddenSync', () => {
  it('tells a new sink the current state at once', () => {
    const { calls, sink } = recordingSink();
    new HiddenSync(true).add(sink);
    expect(calls).toEqual([true]);
  });

  it('fans a transition out to every sink, changes only', () => {
    const sync = new HiddenSync(false);
    const a = recordingSink();
    const b = recordingSink();
    sync.add(a.sink);
    sync.add(b.sink);
    sync.set(false); // no change — silence
    sync.set(true);
    sync.set(true); // repeat — silence
    sync.set(false);
    expect(a.calls).toEqual([false, true, false]);
    expect(b.calls).toEqual([false, true, false]);
  });

  it('wakes on a rAF gap when the visible event went missing', () => {
    const sync = new HiddenSync(false);
    const { calls, sink } = recordingSink();
    sync.add(sink);
    sync.frame(0);
    sync.frame(16);
    sync.set(true); // page hid; the return event will be dropped
    // First callback back after a long absence: the gap alone must wake.
    sync.frame(16 + 30_000);
    expect(calls).toEqual([false, true, false]);
    // And the frames that follow are ordinary — no repeat wakes.
    sync.frame(16 + 30_016);
    expect(calls).toEqual([false, true, false]);
  });

  it('does not mistake visible jank for a return', () => {
    const sync = new HiddenSync(false);
    const { calls, sink } = recordingSink();
    sync.add(sink);
    sync.frame(0);
    sync.frame(WAKE_GAP_MS); // a stall exactly at the threshold: not a gap
    expect(calls).toEqual([false]);
  });

  it('never wakes off the very first frame', () => {
    // Boot with the page hidden: the first rAF callback has no predecessor,
    // so its timestamp alone must not read as a gap.
    const sync = new HiddenSync(true);
    const { calls, sink } = recordingSink();
    sync.add(sink);
    sync.frame(60_000);
    expect(calls).toEqual([true]);
    // The next frame is proof of visibility only through its gap — and
    // 16ms after the first is no gap. (visibilitychange or a later real
    // gap does the waking here.)
    sync.frame(60_016);
    expect(calls).toEqual([true]);
  });
});
