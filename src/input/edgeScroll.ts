import { createSignal } from 'solid-js';

// Same escalation as ui/store.ts: the preference below is module-level
// state, and a hot swap would leave the start screen's switch writing one
// module's signal while the camera reads the other's.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}

/**
 * Edge scrolling: the map follows the pointer as it nears the screen's edge.
 *
 * The shape of the ramp below is decided by one platform detail. A full
 * screen window on macOS does not own its top pixels — touch y=0 and the
 * menu bar slides down over the game, taking the cursor with it. The
 * obvious ramp, nothing at the band's outer edge and full speed at the
 * screen's, trains the player into exactly that gesture every time they
 * scroll north. So this one reaches full speed at EDGE_FULL_PX and stays
 * there: past that point pushing further buys nothing, so nobody pushes,
 * and the bar mostly never comes. (Chrome and Safari drop their own
 * toolbar on the same hover, and the same clearance covers both.)
 *
 * When it comes anyway, the cursor is over the bar rather than the page:
 * the moves stop arriving and a pointerout turns up with a null
 * relatedTarget. Dropping the push there would stall the camera at the
 * exact moment it was being asked for hardest, so a push outlives the
 * pointer that left through it — for EDGE_LATCH_S, long enough to cover
 * the bar and far too short to strand the camera of a player who has gone
 * to another app.
 */

/** Where the push begins. */
export const EDGE_BAND_PX = 48;
/** Where it is already at full strength, comfortably clear of the handful
 * of pixels that summon the menu bar. */
export const EDGE_FULL_PX = 12;
/** How long a push survives the pointer that left through it, in seconds. */
export const EDGE_LATCH_S = 1.2;

/** A push in screen space, each component in -1..1: x is right and z is
 * down — the axes CameraRig pans along. */
export interface EdgePush {
  x: number;
  z: number;
}

/** 1 inside the full-speed zone, 0 at the band's outer edge, linear
 * between. A negative distance is a pointer past the edge entirely, which
 * is as far as it goes. */
function ramp(d: number): number {
  if (d <= EDGE_FULL_PX) return 1;
  if (d >= EDGE_BAND_PX) return 0;
  return (EDGE_BAND_PX - d) / (EDGE_BAND_PX - EDGE_FULL_PX);
}

/**
 * What a pointer at (x, y) in a w×h window is asking the camera for, or
 * null for a pointer with nothing to say.
 *
 * A window too small to hold two bands and a middle has no edges worth the
 * name: every position would sit inside both at once and the camera would
 * creep on whatever the two sides failed to cancel. That axis goes quiet
 * instead — a window narrower than 96px is a debugging curiosity, not a
 * thing to scroll.
 */
export function edgePush(x: number, y: number, w: number, h: number): EdgePush | null {
  const px = w > 2 * EDGE_BAND_PX ? ramp(w - 1 - x) - ramp(x) : 0;
  const pz = h > 2 * EDGE_BAND_PX ? ramp(h - 1 - y) - ramp(y) : 0;
  return px === 0 && pz === 0 ? null : { x: px, z: pz };
}

/**
 * The push in flight, and how long it outlives its pointer. Pure on
 * purpose — the DOM events that drive it are wired up by CameraRig, and
 * the part that was hard to get right is the part that is testable here.
 */
export class EdgeScroll {
  #push: EdgePush | null = null;
  /** null while the pointer is inside the window. A cursor parked in the
   * band sends no further moves, and anything on a timer would quietly
   * stop scrolling under a player who is still asking; only a pointer that
   * has actually gone away gets one. */
  #latch: number | null = null;

  /**
   * The pointer is at (x, y) in a w×h window. `blocked` covers the moments
   * the edge has no claim on the camera — a middle-drag already panning
   * it, a selection band owning the gesture, a HUD control under the
   * cursor that the player is reaching for rather than scrolling past.
   */
  moved(x: number, y: number, w: number, h: number, blocked = false): void {
    this.#push = blocked ? null : edgePush(x, y, w, h);
    this.#latch = null;
  }

  /** The pointer left the window: over the menu bar, or off the display. A
   * push already in flight keeps going; one that was not pushing does not
   * acquire a direction on the way out. */
  left(): void {
    if (this.#push) this.#latch = EDGE_LATCH_S;
  }

  /** Stop now — focus lost, tab hidden, the switch turned off. */
  clear(): void {
    this.#push = null;
    this.#latch = null;
  }

  /** Per-frame; dt in seconds. Returns the push to apply, or null. */
  tick(dt: number): EdgePush | null {
    if (this.#latch !== null) {
      this.#latch -= dt;
      if (this.#latch <= 0) this.clear();
    }
    return this.#push;
  }
}

/** How the preference travels between the menu's page and the match's —
 * launching a game is a navigation, same as the fullscreen switch. */
const PREF_KEY = 'serf-edge-scroll';

/** A fine pointer is the whole precondition. A finger drags the map
 * directly and cannot rest against an edge, so there is nothing the band
 * could add; the guard also lets this module be imported where there is no
 * window at all. */
function finePointer(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(any-pointer: fine)').matches;
}

/** Whether the start screen has any reason to show the switch. */
export function edgeScrollOffered(): boolean {
  return finePointer();
}

/** The stored answer, or null from a player who has not given one. Both
 * answers are written out: an absent key has to mean "never asked" rather
 * than "declined", or a deliberate off would not survive a reload. */
function storedPref(): boolean | null {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

// On where a mouse is driving — it is what the genre does, and the switch
// is one row under Full screen for anyone it annoys.
const [edgeScrollEnabled, setSignal] = createSignal(storedPref() ?? finePointer());
export { edgeScrollEnabled };

export function setEdgeScroll(on: boolean): void {
  setSignal(on);
  try {
    localStorage.setItem(PREF_KEY, on ? '1' : '0');
  } catch {
    /* no storage, no memory */
  }
}
