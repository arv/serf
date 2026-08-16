import { describe, expect, it } from 'vitest';
import { createFullscreen, guardEsc, type FullscreenPort, type PrefStore } from './fullscreen';

/**
 * A browser that grants fullscreen, refuses it, or cannot do it at all —
 * plus a gesture the test decides the moment of. The real port's own
 * behavior (prefixes, going deaf while the page unloads) is DOM plumbing
 * and is not what these check; what they check is the part that survives a
 * navigation, which is the part that was hard.
 */
function fakePort(opts?: { supported?: boolean; refuse?: boolean; display?: boolean }): FullscreenPort & {
  /** Leave fullscreen the way Esc does: no button of ours involved. */
  leave(): void;
  /** The window starts or stops filling the screen for reasons of its own —
   * F11, or the platform reporting our own request through the same query. */
  setDisplay(on: boolean): void;
} {
  let on = false;
  // An installed app is launched full screen; the API says nothing about it.
  let display = opts?.display ?? false;
  const listeners: (() => void)[] = [];
  const displayListeners: (() => void)[] = [];
  const announce = (): void => listeners.forEach((fn) => fn());
  const announceDisplay = (): void => displayListeners.forEach((fn) => fn());
  // The platform reports Fullscreen API state through display-mode too, so
  // a fake that did not do the same would test a browser nobody ships.
  const enter = (next: boolean): void => {
    on = next;
    display = next || (opts?.display ?? false);
    announce();
    announceDisplay();
  };
  return {
    supported: opts?.supported ?? true,
    active: () => on,
    request: async () => {
      if (opts?.refuse) throw new Error('no transient activation');
      enter(true);
    },
    exit: async () => enter(false),
    onChange: (fn) => void listeners.push(fn),
    displayFullscreen: () => display,
    onDisplayChange: (fn) => void displayListeners.push(fn),
    leave: () => enter(false),
    setDisplay: (next) => {
      display = next;
      announceDisplay();
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

  it('keeps offering itself while it is the one holding the screen', async () => {
    // The manifest spec has `display-mode: fullscreen` answer true for the
    // Fullscreen API as well as for an install, so on an engine that
    // implements it literally a controller reading the query plainly would
    // hide the switch the instant it was used — clicked once and gone, with
    // only Esc for a way back. The fake answers that way on purpose.
    const port = fakePort();
    const fs = createFullscreen(port, fakeStore());

    expect(fs.offerable()).toBe(true);
    fs.toggle();
    await settle();

    expect(fs.active()).toBe(true);
    expect(fs.offerable()).toBe(true);

    port.leave();
    expect(fs.offerable()).toBe(true);
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

  describe('installed to a home screen', () => {
    it('offers nothing: the manifest already asked, and got it', () => {
      // display: fullscreen, honored — there is no browser chrome left to
      // trade away, and a switch reading "off" against a full screen is a
      // control that lies.
      const fs = createFullscreen(fakePort({ display: true }), fakeStore());

      expect(fs.supported).toBe(true); // the browser can; there is just no point
      expect(fs.offerable()).toBe(false);
    });

    it('spends no gesture restoring what the window already gives', () => {
      // The preference can easily be set — same player, same origin, in a
      // tab yesterday — and must not cash itself in here.
      const fs = createFullscreen(fakePort({ display: true }), fakeStore(true));
      const gestures = fakeGestures();

      fs.arm(gestures.source);

      expect(gestures.live()).toBe(false);
    });

    it('comes back when the window gives the screen up again', () => {
      // Not the installed app — the tab someone had already pressed F11 in
      // when the page loaded, and then pressed F11 out of.
      const port = fakePort({ display: true });
      const fs = createFullscreen(port, fakeStore());
      expect(fs.offerable()).toBe(false);

      port.setDisplay(false);

      expect(fs.offerable()).toBe(true);
    });
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

  describe('guardEsc', () => {
    /** A Chromium: a keyboard that lends its keys and takes them back. */
    function fakeKeyboardNav(opts?: { refuse?: boolean }): {
      nav: Navigator;
      locked: () => string[] | null;
    } {
      let locked: string[] | null = null;
      const nav = {
        keyboard: {
          lock: (keys?: string[]) => {
            if (opts?.refuse) return Promise.reject(new Error('policy'));
            locked = keys ?? [];
            return Promise.resolve();
          },
          unlock: () => {
            locked = null;
          },
        },
      };
      return { nav: nav as unknown as Navigator, locked: () => locked };
    }

    it('borrows exactly Esc, and gives it back on release', () => {
      const { nav, locked } = fakeKeyboardNav();

      const release = guardEsc(nav);
      expect(locked()).toEqual(['Escape']);

      release();
      expect(locked()).toBe(null);
    });

    it('does nothing where the platform has no keys to lend', () => {
      // Firefox, Safari: no navigator.keyboard at all. The release must be
      // as safe to call as the guard was to arm.
      const release = guardEsc({} as Navigator);
      expect(() => release()).not.toThrow();
    });

    it('swallows a lock the browser refuses', async () => {
      // An embedding policy can reject the promise after the call returns;
      // the refusal leaves Esc meaning what it always did, which is not an
      // error anyone can act on — it must not surface as one.
      const { nav, locked } = fakeKeyboardNav({ refuse: true });

      const release = guardEsc(nav);
      await settle();

      expect(locked()).toBe(null);
      release();
    });
  });
});
