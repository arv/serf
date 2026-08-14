import { createSignal, type Accessor } from 'solid-js';

// Same escalation as ui/store.ts: the signals below are module-level state,
// and a hot swap would leave components reading the old module's while the
// listeners write the new one's.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}

/**
 * Full screen, as far as the platform allows.
 *
 * It cannot be forced, and that is not a gap in this module. Every engine
 * grants fullscreen only from inside a user gesture — a click, a tap, a
 * keypress — so a page that asks on load is refused, and a page that asks
 * again on a timer is refused again. What can be built is the honest
 * version: offer it, and remember the answer.
 *
 * Remembering is the whole difficulty, because a single-player launch is a
 * navigation (StartMenu writes location.search) and unloading a document
 * fully exits fullscreen. So the preference outlives the page in
 * localStorage while the fullscreen itself does not, and the match on the
 * far side re-enters on the player's first click or keypress — the earliest
 * moment the browser will take the request. That first gesture is the
 * "prompt": nothing is asked of the player they were not already going to
 * do.
 *
 * The preference follows reality rather than intent. Esc, the browser's own
 * control and the OS all leave fullscreen without touching our buttons, and
 * a player who left that way has answered the question — the next launch
 * must not drag them back in.
 */

/** The browser's fullscreen machinery, behind a seam the tests can fake. */
export interface FullscreenPort {
  /** Can this browser put an element full screen at all? iOS Safari on the
   * phone cannot: there, fullscreen belongs to video elements and to
   * home-screen installs (the manifest asks for it), never to a page. */
  readonly supported: boolean;
  /** Is it full screen right now? */
  active(): boolean;
  /** Ask. Rejects when the browser was not in the mood — no transient
   * activation, an embedding that forbids it, a permissions policy. */
  request(): Promise<void>;
  exit(): Promise<void>;
  /** Enter and exit both, however they came about. */
  onChange(fn: () => void): void;
}

/** Where the answer is kept between visits. */
export interface PrefStore {
  read(): boolean;
  write(on: boolean): void;
}

/**
 * Subscribes a listener to "the player just did something the browser would
 * accept a fullscreen request from"; the returned function unsubscribes.
 */
export type GestureSource = (fire: () => void) => () => void;

export interface Fullscreen {
  readonly supported: boolean;
  /** Live: is the page full screen this instant? */
  readonly active: Accessor<boolean>;
  /** Live: the remembered answer — true across a launch's reload, while
   * `active` waits for the gesture that makes it true again. */
  readonly wanted: Accessor<boolean>;
  /** Call from a click or a keypress; anywhere else the browser refuses. */
  toggle(): void;
  set(on: boolean): void;
  /**
   * Restore a remembered fullscreen on the first gesture of this page. A
   * no-op when the preference is off, when the browser cannot, or when the
   * page is full screen already — and it disarms itself the moment it
   * fires, so a player who then leaves with Esc stays left.
   */
  arm(gestures: GestureSource): void;
}

export function createFullscreen(port: FullscreenPort, store: PrefStore): Fullscreen {
  const [active, setActive] = createSignal(port.supported && port.active());
  const [wanted, setWanted] = createSignal(port.supported && store.read());

  port.onChange(() => {
    const now = port.active();
    setActive(now);
    // Reality is the answer, whoever gave it: our button, Esc, or the
    // browser's own chrome. (The DOM port stays quiet while the page is
    // unloading, so the exit a navigation causes is not mistaken for one
    // the player asked for — that would forget the preference on the way
    // into the very match it was set for.)
    setWanted(now);
    store.write(now);
  });

  const set = (on: boolean): void => {
    if (!port.supported || on === port.active()) return;
    // Nothing is written here: the change event above is what records the
    // outcome, so a request the browser refuses leaves no trace of a
    // fullscreen that never happened.
    void (on ? port.request() : port.exit()).catch((err: unknown) => {
      console.warn('[fullscreen] refused:', err);
    });
  };

  return {
    supported: port.supported,
    active,
    wanted,
    set,
    toggle: () => set(!port.active()),
    arm: (gestures) => {
      if (!port.supported || !wanted() || port.active()) return;
      let off: (() => void) | null = null;
      let fired = false;
      const fire = (): void => {
        if (fired) return;
        fired = true;
        off?.();
        off = null;
        set(true);
      };
      off = gestures(fire);
      // A source that fired during subscription had nothing to unsubscribe
      // from yet; hand its handle straight back.
      if (fired) {
        off();
        off = null;
      }
    },
  };
}

/** Safari's prefixed spelling, still the only one on some iPads. */
interface PrefixedDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
}
interface PrefixedElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

/** The real thing: `target` full screen, changes read off `doc`. */
export function domFullscreenPort(target: HTMLElement, doc: Document): FullscreenPort {
  const el = target as PrefixedElement;
  const d = doc as PrefixedDocument;
  const canRequest =
    typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function';
  const allowed = doc.fullscreenEnabled || d.webkitFullscreenEnabled || false;

  // A page on its way out loses fullscreen as part of being unloaded, and
  // that exit says nothing about what the player wants — the launch they
  // just clicked is the reason for it. Go deaf at pagehide, and while the
  // tab is not on screen at all.
  let leaving = false;
  window.addEventListener('pagehide', () => {
    leaving = true;
  });
  window.addEventListener('pageshow', () => {
    leaving = false;
  });

  return {
    supported: canRequest && allowed,
    active: () => (doc.fullscreenElement ?? d.webkitFullscreenElement ?? null) !== null,
    request: async () => {
      if (el.requestFullscreen) await el.requestFullscreen();
      else await el.webkitRequestFullscreen?.();
    },
    exit: async () => {
      if (doc.exitFullscreen) await doc.exitFullscreen();
      else await d.webkitExitFullscreen?.();
    },
    onChange: (fn) => {
      const relay = (): void => {
        if (!leaving && !doc.hidden) fn();
      };
      doc.addEventListener('fullscreenchange', relay);
      doc.addEventListener('webkitfullscreenchange', relay);
    },
  };
}

/** One localStorage flag. A storage that throws (Safari's private mode used
 * to) costs the memory of the choice, never the choice itself. */
export function storedPref(key: string): PrefStore {
  return {
    read: () => {
      try {
        return localStorage.getItem(key) === '1';
      } catch {
        return false;
      }
    },
    write: (on) => {
      try {
        if (on) localStorage.setItem(key, '1');
        else localStorage.removeItem(key);
      } catch {
        /* no storage, no memory */
      }
    },
  };
}

/**
 * The first gesture the browser would honor a request from. Escape is left
 * out on purpose: it is the key that means "get me out of here", and a page
 * that answered it by going full screen would be trapping the player with
 * the one key they reached for to escape.
 */
export function domGestures(target: EventTarget): GestureSource {
  return (fire) => {
    const onPointer = (e: Event): void => {
      if (e.isTrusted) fire();
    };
    const onKey = (e: Event): void => {
      const key = (e as KeyboardEvent).key;
      if (e.isTrusted && key !== 'Escape' && key !== 'Unidentified') fire();
    };
    const off = (): void => {
      target.removeEventListener('pointerdown', onPointer);
      target.removeEventListener('keydown', onKey);
    };
    target.addEventListener('pointerdown', onPointer);
    target.addEventListener('keydown', onKey);
    return off;
  };
}

/** How the preference travels between the menu's page and the match's. */
const PREF_KEY = 'serf-fullscreen';

let instance: Fullscreen | null = null;

/**
 * The page's one Fullscreen. Built on first use rather than at import, so
 * the module can be imported (and tested) where there is no document.
 */
export function fullscreen(): Fullscreen {
  instance ??= createFullscreen(
    // documentElement, not the canvas: the HUD, the menu and the grade
    // layers are all siblings of it, and a fullscreen canvas would take the
    // world full screen and leave the game's buttons behind on the page.
    domFullscreenPort(document.documentElement, document),
    storedPref(PREF_KEY),
  );
  return instance;
}

/** Called once at boot, before either the menu or a match goes up. */
export function armFullscreen(): void {
  fullscreen().arm(domGestures(window));
}
