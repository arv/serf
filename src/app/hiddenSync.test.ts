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

  it('wakes on the second callback after a short hide the gap cannot see', () => {
    // App switch briefer than WAKE_GAP_MS, return event dropped: the gap
    // on the first frame back is under the threshold, so the callbacks
    // continuing at all must do the waking — by the second one.
    const sync = new HiddenSync(false);
    const { calls, sink } = recordingSink();
    sync.add(sink);
    sync.frame(0);
    sync.frame(16);
    sync.set(true); // page hid for half a second; the return event is dropped
    sync.frame(16 + 500);
    expect(calls).toEqual([false, true]); // one frame back is not yet proof
    sync.frame(16 + 516);
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

  it('is not fooled by one stray callback racing the hide', () => {
    // A callback already queued when the page hides may still run after
    // the event. Alone it must not restart the sim on a page going dark —
    // rAF stops after it, so no second callback ever arrives.
    const sync = new HiddenSync(false);
    const { calls, sink } = recordingSink();
    sync.add(sink);
    sync.frame(0);
    sync.frame(16);
    sync.set(true);
    sync.frame(32); // the straggler
    expect(calls).toEqual([false, true]);
  });

  it('wakes a boot whose initial hidden reading was stale', () => {
    // Told hidden from birth, yet rAF ticks — callbacks only run on a
    // visible page, so by the second one the reading is known wrong. The
    // first alone stays inconclusive: no predecessor for a gap, and one
    // callback could be the stray above.
    const sync = new HiddenSync(true);
    const { calls, sink } = recordingSink();
    sync.add(sink);
    sync.frame(60_000);
    expect(calls).toEqual([true]);
    sync.frame(60_016);
    expect(calls).toEqual([true, false]);
  });
});
