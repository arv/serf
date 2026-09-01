/**
 * The screen, kept awake while a match is on it.
 *
 * This game asks to be watched more than it asks to be touched: a player
 * who has placed the last of a bread chain sits and watches serfs walk it,
 * and on a phone or a laptop the display dims and locks under them a
 * minute later. The Screen Wake Lock API is the sanctioned way to say "not
 * yet" — and the only one; the old trick of looping a muted video is a
 * hack the engines have been closing for years.
 *
 * What the platform grants is narrower than it sounds, and the shape of
 * this module is that narrowness rather than any choice of ours:
 *
 * - Only a *visible* page may hold one. A request from a hidden document
 *   is refused, and a lock already held is taken back the moment the page
 *   hides — so there is no such thing as keeping the screen on for a game
 *   in a background tab, and nothing here tries.
 * - Which makes the return to visible the moment that matters: the lock
 *   does not come back on its own, and a page that only asked once would
 *   keep the screen awake until the first app switch and never again.
 *   `setHidden` is fed by the same HiddenSync the sim and the audio freeze
 *   on (app/hiddenSync.ts), so the ask rides the signal that survives the
 *   return-to-visible events mobile browsers drop.
 * - It is the screen's sleep that is deferred, nothing else. The OS still
 *   sleeps on its own lid and its own button, the battery still drains,
 *   and a player who walks away from a visible match is holding a screen
 *   on — which is exactly what they asked for by leaving it in front of
 *   them, and exactly what stops the moment they switch away.
 *
 * Held for a match (app/matchScreen.ts) and never for the menu: the menu is
 * a page someone reads and leaves, and a start screen that fought the
 * lock screen would be spending the battery of a game nobody started.
 *
 * A refusal is not an error to recover from. Firefox on Android, an
 * embedding whose permissions policy forbids it, an OS in battery saver
 * (Chromium refuses outright there, deliberately) — all answer the same
 * way, and the honest response is the one this had before the API existed:
 * the screen dims on its own schedule.
 */

/** The browser's wake lock machinery, behind a seam the tests can fake. */
export interface WakeLockPort {
  /** Does this browser have the API at all? */
  readonly supported: boolean;
  /**
   * Ask for a screen lock. Rejects when the browser was not in the mood —
   * a hidden document, a permissions policy, battery saver.
   */
  request(): Promise<WakeSentinel>;
}

/** One granted lock, held until somebody lets go. */
export interface WakeSentinel {
  release(): Promise<void>;
  /**
   * The browser let go by itself: the page hid, or the OS took the screen
   * back. Fires once; after it, this sentinel is spent and a new lock has
   * to be requested rather than this one resumed.
   */
  onRelease(fn: () => void): void;
}

export interface WakeLock {
  /** Is a lock held this instant? For the tests and the dev console. */
  held(): boolean;
  /**
   * The page hid, or came back. Nothing is asked for until the first
   * `setHidden(false)` — only a visible page may hold a lock, so the
   * page's own visibility is what starts this, not construction.
   */
  setHidden(hidden: boolean): void;
  /** The match is over; give the screen back. */
  dispose(): void;
}

export function createWakeLock(port: WakeLockPort): WakeLock {
  /** Do we want one right now: visible, and not torn down. */
  let want = false;
  let sentinel: WakeSentinel | null = null;
  /** A request is out. Without this a burst of visibility changes would
   * stack up grants, and every one past the first would be a lock nobody
   * holds a handle to — released only by the page hiding, if at all. */
  let asking = false;
  /** Refusals repeat (battery saver stays on for hours, and every return
   * to visible asks again). Say it once and stop narrating. */
  let warned = false;

  const acquire = (): void => {
    if (!port.supported || !want || sentinel !== null || asking) return;
    asking = true;
    void port
      .request()
      .then(granted => {
        asking = false;
        // The page hid, or the match ended, while the request was in the
        // air. The browser would take this one back at the hide anyway;
        // for the match-ended case nobody would, so let go by hand.
        if (!want) {
          void granted.release().catch(() => {});
          return;
        }
        sentinel = granted;
        granted.onRelease(() => {
          // Whoever took it — the hide below, the OS reclaiming it — this
          // handle is spent. Dropping the reference is all that happens
          // here: re-asking on the spot would spin against an OS that has
          // just said no, and the next return to visible is the one moment
          // worth asking again.
          if (sentinel === granted) sentinel = null;
        });
      })
      .catch((err: unknown) => {
        asking = false;
        if (warned) return;
        warned = true;
        console.warn('[wakeLock] refused:', err);
      });
  };

  const drop = (): void => {
    const held = sentinel;
    sentinel = null;
    // A release that rejects has still let go as far as this side is
    // concerned; there is no state left to repair.
    if (held) void held.release().catch(() => {});
  };

  /** One way. A disposed match must never take the screen back, whatever
   * is still holding a reference to this and calling into it. */
  let over = false;

  return {
    held: () => sentinel !== null,
    setHidden: hidden => {
      if (over) return;
      want = !hidden;
      if (want) acquire();
      else drop();
    },
    dispose: () => {
      over = true;
      want = false;
      drop();
    },
  };
}

/**
 * The real thing.
 *
 * `navigator.wakeLock` is typed as always present and is not: the API is a
 * secure-context one (so a plain-http build — the way this game gets onto a
 * phone over a LAN in development — has no `wakeLock` at all), and Firefox
 * on Android has never had it. Read through an optional view, which is what
 * every other caller of a not-quite-universal API here does.
 */
export function domWakeLockPort(nav: Navigator = navigator): WakeLockPort {
  const api = (nav as {wakeLock?: Navigator['wakeLock']}).wakeLock;
  return {
    supported: typeof api?.request === 'function',
    request: async () => {
      // The same question `supported` asks, asked again — a browser with a
      // `wakeLock` that cannot `request` is one this must not call into.
      // The controller never asks an unsupported port; a caller that does
      // anyway gets a rejection naming the reason, which is the road
      // refusals already take.
      if (typeof api?.request !== 'function')
        throw new Error('no Screen Wake Lock API');
      const granted = await api.request('screen');
      return {
        release: () => granted.release(),
        onRelease: fn => granted.addEventListener('release', fn),
      };
    },
  };
}
