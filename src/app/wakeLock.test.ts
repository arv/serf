import {describe, expect, it, vi} from 'vitest';
import {
  createWakeLock,
  domWakeLockPort,
  type WakeLockPort,
  type WakeSentinel,
} from './wakeLock';

/**
 * A browser that grants screen locks, refuses them, or has never heard of
 * them — with the grant held open so a test can decide the moment it
 * lands. What the real port does (reading `navigator.wakeLock`, relaying
 * the release event) is three lines of plumbing; what is checked here is
 * the part the platform makes awkward — a lock that only a visible page may
 * hold, taken back at every hide, and asked for again on the way back.
 */
function fakePort(opts?: {
  supported?: boolean;
  refuse?: boolean;
}): WakeLockPort & {
  /** Locks handed out, oldest first, whether or not still held. */
  granted: {released: boolean; drop(): void}[];
  /** How many times the page has asked. */
  asks(): number;
  /** Settle the request in flight (grant or refusal, per `refuse`). */
  settle(): Promise<void>;
} {
  const granted: {released: boolean; drop(): void}[] = [];
  let asks = 0;
  let land: (() => void) | null = null;
  return {
    supported: opts?.supported ?? true,
    granted,
    asks: () => asks,
    request: () => {
      asks++;
      return new Promise<WakeSentinel>((resolve, reject) => {
        land = () => {
          land = null;
          if (opts?.refuse) {
            reject(new Error('battery saver'));
            return;
          }
          const listeners: (() => void)[] = [];
          const lock = {
            released: false,
            /** The browser takes it back on its own: a hide, or the OS. */
            drop: () => {
              lock.released = true;
              listeners.forEach(fn => fn());
            },
          };
          granted.push(lock);
          resolve({
            release: async () => {
              lock.released = true;
            },
            onRelease: fn => void listeners.push(fn),
          });
        };
      });
    },
    settle: async () => {
      land?.();
      // The .then and the .catch inside the controller are each a tick.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('domWakeLockPort', () => {
  it('reads a browser that has no API as unsupported', () => {
    expect(domWakeLockPort({} as Navigator).supported).toBe(false);
  });

  it('refuses a half-built API the same way, and says why', async () => {
    // A polyfill that defined the object and not the method. `supported`
    // already answered false, so the controller never gets here; a caller
    // that does gets the reason rather than "api.request is not a
    // function".
    const nav = {wakeLock: {}} as unknown as Navigator;
    const port = domWakeLockPort(nav);

    expect(port.supported).toBe(false);
    await expect(port.request()).rejects.toThrow('no Screen Wake Lock API');
  });
});

describe('wakeLock', () => {
  it('takes the screen when the page is visible and gives it back when hidden', async () => {
    const port = fakePort();
    const wake = createWakeLock(port);

    // Nothing is asked for at construction: only a visible page may hold
    // one, and the page's own visibility is what says so.
    expect(port.asks()).toBe(0);

    wake.setHidden(false);
    await port.settle();
    expect(wake.held()).toBe(true);

    wake.setHidden(true);
    expect(wake.held()).toBe(false);
    expect(port.granted[0]?.released).toBe(true);
  });

  it('asks again on the way back, because the lock does not return by itself', async () => {
    const port = fakePort();
    const wake = createWakeLock(port);
    wake.setHidden(false);
    await port.settle();

    // A hide is where the browser takes it back, event and all.
    port.granted[0]?.drop();
    wake.setHidden(true);
    wake.setHidden(false);
    await port.settle();

    expect(port.asks()).toBe(2);
    expect(wake.held()).toBe(true);
    expect(port.granted).toHaveLength(2);
  });

  it('holds one lock across a burst of visibility changes', async () => {
    const port = fakePort();
    const wake = createWakeLock(port);

    // Every one of these is a request the old code would have stacked up,
    // and each grant past the first would be a lock with no handle left.
    wake.setHidden(false);
    wake.setHidden(false);
    wake.setHidden(false);
    await port.settle();

    expect(port.asks()).toBe(1);
    expect(port.granted).toHaveLength(1);
  });

  it('lets go of a grant that lands after the page has gone', async () => {
    const port = fakePort();
    const wake = createWakeLock(port);
    wake.setHidden(false);
    // The match ends while the request is still in the air. Nobody else
    // will release this one — the page never hid.
    wake.dispose();
    await port.settle();

    expect(wake.held()).toBe(false);
    expect(port.granted[0]?.released).toBe(true);
  });

  it('stays down once the match is over', async () => {
    const port = fakePort();
    const wake = createWakeLock(port);
    wake.setHidden(false);
    await port.settle();
    wake.dispose();

    expect(wake.held()).toBe(false);
    expect(port.granted[0]?.released).toBe(true);

    // And stays down when spoken to again. A match's teardown takes this
    // apart before it takes the visibility listener off (they are pushed
    // in that order and run in reverse), so the sink outlives the screen
    // by a step; a return to visible landing in that step would otherwise
    // take a lock for a match that no longer exists — and nothing left
    // would ever release it.
    wake.setHidden(false);
    await port.settle();

    expect(port.asks()).toBe(1);
    expect(wake.held()).toBe(false);
  });

  it('survives a refusal, and does not narrate it twice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const port = fakePort({refuse: true});
      const wake = createWakeLock(port);

      // Battery saver is Chromium's standing refusal, and it stands for
      // hours: every return to visible asks again and is turned down again.
      wake.setHidden(false);
      await port.settle();
      wake.setHidden(true);
      wake.setHidden(false);
      await port.settle();

      expect(wake.held()).toBe(false);
      expect(port.asks()).toBe(2);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not re-ask when the OS reclaims a lock under a visible page', async () => {
    const port = fakePort();
    const wake = createWakeLock(port);
    wake.setHidden(false);
    await port.settle();

    // Battery saver switching on mid-match, say. Re-asking on the spot
    // would spin against an OS that has just said no; the next return to
    // visible is the one moment worth asking again.
    port.granted[0]?.drop();

    expect(wake.held()).toBe(false);
    expect(port.asks()).toBe(1);
  });

  it('asks nothing of a browser that cannot', async () => {
    const port = fakePort({supported: false});
    const wake = createWakeLock(port);

    wake.setHidden(false);
    await port.settle();
    wake.setHidden(true);
    wake.dispose();

    expect(port.asks()).toBe(0);
    expect(wake.held()).toBe(false);
  });
});
