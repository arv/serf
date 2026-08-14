import { describe, expect, it } from 'vitest';
import { createFullscreen, type FullscreenPort, type PrefStore } from './fullscreen';

/**
 * A browser that grants fullscreen, refuses it, or cannot do it at all —
 * plus a gesture the test decides the moment of. The real port's own
 * behavior (prefixes, going deaf while the page unloads) is DOM plumbing
 * and is not what these check; what they check is the part that survives a
 * navigation, which is the part that was hard.
 */
function fakePort(opts?: { supported?: boolean; refuse?: boolean }): FullscreenPort & {
  /** Leave fullscreen the way Esc does: no button of ours involved. */
  leave(): void;
} {
  let on = false;
  const listeners: (() => void)[] = [];
  const announce = (): void => listeners.forEach((fn) => fn());
  return {
    supported: opts?.supported ?? true,
    active: () => on,
    request: async () => {
      if (opts?.refuse) throw new Error('no transient activation');
      on = true;
      announce();
    },
    exit: async () => {
      on = false;
      announce();
    },
    onChange: (fn) => void listeners.push(fn),
    leave: () => {
      on = false;
      announce();
    },
  };
}

function fakeStore(initial = false): PrefStore & { value: boolean } {
  const store = {
    value: initial,
    read: () => store.value,
    write: (on: boolean) => {
      store.value = on;
    },
  };
  return store;
}

/** A gesture source the test fires by hand, counting its subscriptions. */
function fakeGestures(): { fire(): void; live(): boolean; source: (fire: () => void) => () => void } {
  let armed: (() => void) | null = null;
  return {
    fire: () => armed?.(),
    live: () => armed !== null,
    source: (fn) => {
      armed = fn;
      return () => {
        armed = null;
      };
    },
  };
}

/** request()/exit() resolve on a microtask; let them land. */
const settle = (): Promise<void> => Promise.resolve();

describe('fullscreen', () => {
  it('enters on a toggle and remembers the answer', async () => {
    const port = fakePort();
    const store = fakeStore();
    const fs = createFullscreen(port, store);

    expect(fs.active()).toBe(false);
    fs.toggle();
    await settle();

    expect(fs.active()).toBe(true);
    expect(store.value).toBe(true);
  });

  it('forgets it when the player leaves by any road', async () => {
    const port = fakePort();
    const store = fakeStore(true);
    const fs = createFullscreen(port, store);
    fs.set(true);
    await settle();

    // Esc, the browser's own control, the OS — none of them our button.
    port.leave();

    expect(fs.active()).toBe(false);
    expect(store.value).toBe(false);
  });

  it('remembers nothing when the browser refuses the request', async () => {
    const port = fakePort({ refuse: true });
    const store = fakeStore();
    const fs = createFullscreen(port, store);

    fs.toggle();
    await settle();

    expect(fs.active()).toBe(false);
    expect(store.value).toBe(false);
  });

  it('stands down entirely where fullscreen is unsupported', async () => {
    // iOS Safari on the phone: the preference may even be set (from a
    // desktop session, same account, synced storage) and must still not
    // leave a toggle claiming a state the page can never reach.
    const port = fakePort({ supported: false });
    const fs = createFullscreen(port, fakeStore(true));
    const gestures = fakeGestures();

    expect(fs.supported).toBe(false);
    expect(fs.wanted()).toBe(false);
    fs.toggle();
    await settle();
    fs.arm(gestures.source);

    expect(fs.active()).toBe(false);
    expect(gestures.live()).toBe(false);
  });

  describe('across the launch reload', () => {
    it('waits for a gesture, then restores what was remembered', async () => {
      // The page the match booted into: the preference crossed, the
      // fullscreen did not (unloading a document exits it).
      const port = fakePort();
      const store = fakeStore(true);
      const fs = createFullscreen(port, store);
      const gestures = fakeGestures();

      fs.arm(gestures.source);
      expect(fs.wanted()).toBe(true);
      expect(fs.active()).toBe(false); // nothing asked of the browser yet

      gestures.fire();
      await settle();

      expect(fs.active()).toBe(true);
    });

    it('disarms after the first gesture, so Esc still means Esc', async () => {
      const port = fakePort();
      const fs = createFullscreen(port, fakeStore(true));
      const gestures = fakeGestures();

      fs.arm(gestures.source);
      gestures.fire();
      await settle();
      expect(gestures.live()).toBe(false);

      port.leave();
      gestures.fire(); // the click that follows must not haul them back in
      await settle();

      expect(fs.active()).toBe(false);
    });

    it('asks for nothing when the preference is off', () => {
      const fs = createFullscreen(fakePort(), fakeStore(false));
      const gestures = fakeGestures();

      fs.arm(gestures.source);

      expect(gestures.live()).toBe(false);
    });

    it('asks for nothing when the page is full screen already', async () => {
      const port = fakePort();
      const fs = createFullscreen(port, fakeStore(true));
      const gestures = fakeGestures();
      fs.set(true);
      await settle();

      fs.arm(gestures.source);

      expect(gestures.live()).toBe(false);
    });
  });
});
