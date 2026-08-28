import { domGestures, fullscreen } from '../ui/fullscreen';

// Same escalation as ui/store.ts: the installed capture below is
// module-level state, and a hot swap would strand it — a locked pointer, a
// drawn cursor and a window full of listeners owned by a module nothing
// left alive can reach to take them down.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}

/**
 * Mouse capture: the pointer stops belonging to the desktop and starts
 * belonging to the game.
 *
 * Full screen does not hand a page the screen's edges. On macOS the top
 * few pixels stay the menu bar's however full the screen is: push the
 * cursor into them and the bar slides down over the map, taking the cursor
 * with it — which is exactly the gesture edge scrolling asks for, every
 * time the camera goes north. edgeScroll.ts shapes its ramp around that
 * (full speed twelve pixels in, so nobody has any reason to push further)
 * and latches the push when the cursor leaves anyway. Both are mitigations
 * for a cursor we do not own.
 *
 * The Pointer Lock API is the one way to own it. Locked, the mouse stops
 * reporting a position and starts reporting movement: there is no cursor
 * to lose to the menu bar, none to strand on a second display, and no
 * click that lands on another window. What it costs is everything the
 * position was doing for us. Nothing hovers, nothing is under anything,
 * every event arrives at the lock target with coordinates that mean
 * nothing, and the arrow the player steers has to be drawn by us.
 *
 * So this module keeps the position itself, and puts it back into the
 * stream the rest of the game already reads. A locked event is caught at
 * the window in the capture phase, stopped there, and re-dispatched at
 * whatever `elementFromPoint` finds under the drawn arrow with clientX and
 * clientY rewritten — plus the boundary events (over/out, enter/leave)
 * that a moving cursor would have produced and a locked one never does.
 * Downstream, picking, the HUD's buttons, the tooltips and the edge scroll
 * all read the same fields off the same event types as ever and never
 * learn the difference.
 *
 * Two seams are not free, and both are handled rather than hidden:
 *
 * - `:hover` is the browser's own, and no synthetic event sets it. Every
 *   hover rule in the document is mirrored onto a `.vhover` class this
 *   module puts on the hovered chain, so the HUD lights up under the drawn
 *   cursor the way it does under the real one. (See hoverAlias and #mirror.)
 * - A synthetic press does not drive a native control the way a real one
 *   does. The only such control in a match is the menu's volume slider,
 *   and it gets driven from the virtual position directly.
 *
 * Two rates matter, and they are not the same rate. A locked pointer is
 * not coalesced to the frame the way a loose one is: measured on Chrome
 * 151 / macOS, one gesture that produced 297 pointermoves unlocked
 * produced 719 locked — the mouse's own rate, and a gaming mouse reports
 * far faster still (controls.ts says the same thing about its hover scan).
 * Relaying every one of those would hand the game two and a half times the
 * events it was written for, each one costing a hit test that flushes
 * layout — main-thread work that lands as the very lag the drawn cursor is
 * trying not to have. So the expensive half is coalesced back to the frame
 * the way the platform would have, while the cheap half is not.
 *
 * Latency is the one thing a drawn cursor cannot simply match. The real
 * one is composited by the window server the instant the mouse moves and
 * never waits for a page; ours is a DOM element that waits for the main
 * thread, and on the frame where the renderer is busy it waits longer. So
 * the two halves of a move are split. Position and sprite ride on
 * `pointerrawupdate`, which the engine delivers at the device's own rate,
 * unthrottled and ahead of the frame-aligned `pointermove` — and the
 * handler does nothing but a compositor-only transform. Everything
 * expensive — the hit test, the boundary events, the class churn, the
 * relay to the page — stays on `pointermove`, where the game wanted it
 * anyway, and runs after the cursor has already been put where it belongs.
 * (Where there is no raw update — Safari, Firefox — `pointermove` steers
 * as before; the flag below is set by the first one that arrives rather
 * than by sniffing for support.)
 *
 * None of which is the largest term. A drawn cursor is only as fresh as
 * the frame carrying it, and the frame was arriving six deep in the
 * compositor's queue until GameRenderer.gpuReady started pacing the render
 * loop against a GPU fence — 124ms of it, against 0.06ms of renderer work.
 * The cursor is what made that visible: your hand is a reference the game
 * never had before.
 *
 * Sensitivity is not one of the seams. A locked mouse reports the same
 * accelerated movement the desktop was moving the real cursor by, so
 * driving the drawn one from it one-for-one keeps the player's own
 * tracking speed and acceleration curve exactly — there is no sensitivity
 * setting here because there is nothing for one to correct. The one thing
 * that does need correcting is a unit mismatch under HiDPI and page zoom,
 * and that is measured off the real cursor before the lock (see
 * #calibrate) rather than guessed at.
 *
 * There is no switch for this. Full screen is the switch: asking for the
 * whole screen is asking to play with the whole screen, and the pointer
 * staying inside it — along with the edges that pan the map — is what that
 * means (see edgeScroll.ts, which now hangs off the same question). Both
 * used to have a row of their own, and the row was a way of asking the
 * player to diagnose a platform detail on our behalf.
 *
 * Esc is the other platform question, and it is already answered: the
 * browser exits a pointer lock on Esc the way it exits fullscreen, and
 * ui/fullscreen.ts's guardEsc — held for the whole match — borrows the key
 * through the Keyboard Lock API wherever the engine has one. Where it does
 * not (Firefox, Safari), Esc releases the pointer, and that release is
 * taken at face value: a player who let the mouse go is not dragged back
 * on their next click.
 */

/** The class a hovered element wears while the pointer is ours. */
const VHOVER = 'vhover';

/**
 * How long the owed move may wait when no frame comes to collect it.
 *
 * The frame is the right moment for it — see #owe — but it cannot be the
 * only moment. Measured on a software-rendered headless run at 1.4 frames
 * a second, a purely frame-bound relay delivered nothing to the game for
 * the better part of a second while the cursor went on moving normally: a
 * renderer having a bad frame must not also stop the game hearing about
 * the mouse. Thirty-two milliseconds is two frames of grace, so on any
 * machine keeping up it never fires at all.
 */
const STALL_MS = 32;

/**
 * ?capture=window takes the lock in a window, without waiting for full
 * screen — a development aid, and the only practical way to work on this
 * module. Everything below is reachable in earnest only through a
 * fullscreen the browser grants from a gesture and drops on a reload,
 * which is a poor place to debug from; the switch, meanwhile, still means
 * what it says.
 */
const FORCED =
  typeof location !== 'undefined' &&
  new URLSearchParams(location.search).get('capture') === 'window';

/**
 * The game has the screen: everything that used to be a switch of its own
 * hangs off this one question. Full screen answers it; so does the
 * development flag above, which exists so that working on any of it does
 * not mean working through a fullscreen the browser drops on every reload.
 *
 * edgeScroll.ts asks it too, and asks it from here rather than from
 * fullscreen.ts on purpose: the edges are safe to give the pointer only
 * because the pointer is ours, so the two want one answer between them and
 * this is the module that knows whether it can be given.
 */
export function immersive(): boolean {
  return FORCED || fullscreen().active();
}

/**
 * A movement's worth of travel, clamped to the window. The clamp is the
 * whole feature — no arithmetic here ever puts the drawn cursor where the
 * menu bar lives, because there is nowhere outside the window to put it.
 */
export function slide(pos: number, delta: number, extent: number): number {
  return Math.min(Math.max(pos + delta, 0), Math.max(extent - 1, 0));
}

/**
 * The first entry of `a` that also appears in `b`, or null. Both are
 * inclusive ancestor chains, innermost first, so this is the nearest
 * common ancestor — what a boundary crossing pivots on, and what the DOM
 * gives a click whose press and release landed on different elements.
 */
export function commonAncestor<T>(a: readonly T[], b: readonly T[]): T | null {
  for (const node of a) if (b.includes(node)) return node;
  return null;
}

/**
 * Which elements a cursor stepping from the `prev` chain to the `next` one
 * has left and which it has entered — everything below the common
 * ancestor, on each side. `left` is innermost first and `entered`
 * outermost first, which is the order the two events want dispatching in.
 */
export function boundary<T>(prev: readonly T[], next: readonly T[]): { left: T[]; entered: T[] } {
  const pivot = commonAncestor(prev, next);
  const upto = (chain: readonly T[]): T[] => {
    const end = pivot === null ? chain.length : chain.indexOf(pivot);
    return chain.slice(0, end === -1 ? chain.length : end);
  };
  return { left: upto(prev), entered: upto(next).reverse() };
}

/**
 * The same selector, hovering on our terms instead of the browser's, or
 * null for a selector with no hover in it. `:not(:hover)` inverts to
 * `:not(.vhover)` on the same substitution, which is the right answer for
 * the neutralizers the HUD uses on touch screens.
 *
 * A selector list keeps only the branches that hover. The HUD writes rules
 * like `#ui button.active, #ui button.active:hover:not(:disabled)`, and
 * copying such a list whole would carry the first branch along with the
 * second — restating a resting style at the end of the document, where it
 * outranks every equally specific rule that was meant to follow it.
 */
export function hoverAlias(selector: string): string | null {
  if (!selector.includes(':hover')) return null;
  const hovering = splitList(selector).filter((branch) => branch.includes(':hover'));
  if (hovering.length === 0) return null;
  return hovering.join(', ').replaceAll(':hover', `.${VHOVER}`);
}

/**
 * A selector list split on its top-level commas — the ones between
 * branches, not the ones inside `:is(a, b)` or `[attr="x,y"]`.
 */
function splitList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (quote !== '') {
      if (ch === quote && selector[i - 1] !== '\\') quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(selector.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(selector.slice(start).trim());
  return parts.filter((p) => p !== '');
}

/**
 * The drawn cursor, in the three shapes a match asks for through `cursor:`
 * — the arrow, the hand over anything clickable, and the crosshair over
 * the minimap. (`grab` and `grabbing` exist too, in the docs area, which is
 * not a match and never captured; a fourth shape would be one entry here.)
 *
 * Drawn to read as the system's rather than as the game's: white body,
 * black outline, the platform's own proportions, and the shadow that
 * separates every one of them from what it is over. It cannot be the real
 * cursor — a locked pointer has none, and nothing hands out the bitmap —
 * so the next best thing is a cursor nobody looks at twice. The game's own
 * palette was tried here first and was the wrong instinct: a cream arrow
 * with a brown edge reads as a game object, and a game object is something
 * the eye keeps checking instead of pointing with.
 *
 * Each entry carries its hotspot — the pixel that is actually the pointer,
 * and what the sprite is offset by so its tip sits where the hit test
 * samples.
 */
const SHAPES: Record<string, { hot: [number, number]; svg: string }> = {
  default: {
    hot: [1, 1],
    svg: `<svg width="14" height="21" viewBox="0 0 14 21" fill="none">
      <path d="M1 1 1 16.7 4.9 13.1 7.4 19.7 10 18.6 7.6 12.3 12.1 12.1Z"
        fill="#fff" stroke="#000" stroke-width="1.1" stroke-linejoin="round"/></svg>`,
  },
  pointer: {
    hot: [8, 1],
    svg: `<svg width="19" height="23" viewBox="0 0 19 23" fill="none">
      <path d="M7 12.6V3.9a1.55 1.55 0 0 1 3.1 0v4.9a1.5 1.5 0 0 1 3 0v1a1.5 1.5 0 0 1 3 0v5.4
        c0 3.4-2.2 5.8-5.6 5.8-2.9 0-4.5-1.2-5.6-3.2l-2.2-3.9a1.5 1.5 0 0 1 2.5-1.7l1.8 2.5"
        fill="#fff" stroke="#000" stroke-width="1.1" stroke-linejoin="round" stroke-linecap="round"/></svg>`,
  },
  crosshair: {
    hot: [8.5, 8.5],
    svg: `<svg width="17" height="17" viewBox="0 0 17 17" fill="none">
      <path d="M8.5 0.5v6M8.5 10.5v6M0.5 8.5h6M10.5 8.5h6" stroke="#fff" stroke-width="2.4"/>
      <path d="M8.5 0.5v6M8.5 10.5v6M0.5 8.5h6M10.5 8.5h6" stroke="#000" stroke-width="1"/></svg>`,
  },
};

/** Events that carry a position and have to be re-aimed. */
const RELAYED = [
  'pointermove',
  'pointerdown',
  'pointerup',
  'mousemove',
  'mousedown',
  'mouseup',
  'click',
  'auxclick',
  'dblclick',
  'contextmenu',
  'wheel',
] as const;

/** Boundary events, which a locked pointer produces none of that mean
 * anything: whatever the engine sends is about the lock target, not about
 * where the player is looking. Eaten here and reissued below. */
const EATEN = [
  'pointerover',
  'pointerout',
  'pointerenter',
  'pointerleave',
  'mouseover',
  'mouseout',
  'mouseenter',
  'mouseleave',
] as const;

/** The inclusive ancestor chain of an element, innermost first. */
function chainOf(el: Element | null): Element[] {
  const chain: Element[] = [];
  for (let node = el; node !== null; node = node.parentElement) chain.push(node);
  return chain;
}

/** What the browser would have shown here, as one of the three shapes. */
function shapeAt(el: Element | null): string {
  if (el === null) return 'default';
  const named = getComputedStyle(el).cursor;
  return named in SHAPES ? named : 'default';
}

/**
 * One live capture: the lock, the drawn cursor, and the event plumbing
 * that connects the two. Built by installMouseCapture for the life of a
 * match; nothing here outlives the world it steers.
 */
class MouseCapture {
  readonly #doc: Document;
  readonly #root: HTMLElement;
  readonly #off = new AbortController();
  readonly #cursor: HTMLDivElement;
  readonly #sheet: HTMLStyleElement;
  readonly #mirrored = new WeakSet<CSSStyleSheet>();
  /** How many stylesheets the last mirror pass saw — a panel mounting
   * brings its own, and this is how we notice cheaply. */
  #sheetCount = -1;
  /** The virtual position: where the player believes the pointer is. */
  #x = 0;
  #y = 0;
  /**
   * Reported movement per pixel of real travel — the player's own mouse
   * settings, measured rather than assumed. See #calibrate.
   */
  #gain = 1;
  #travelled = 0;
  #reported = 0;
  #shape = '';
  /** The hovered chain, innermost first, and where the last press landed. */
  #chain: Element[] = [];
  #pressed: Element[] = [];
  /** An element that took the pointer with setPointerCapture during a
   * press (the rig's middle-drag does), and the slider being dragged. */
  #held: Element | null = null;
  #slider: HTMLInputElement | null = null;
  /** The move that is owed to the page: the last event to stand as its
   * template, the travel to report on it, when the last one went out, and
   * the timer that pays the tail if the mouse stops. Same shape as
   * controls.ts's once-a-frame hover scan, and for the same reason. */
  #pending: MouseEvent | null = null;
  #owedX = 0;
  #owedY = 0;
  #frame: number | null = null;
  #timer: number | null = null;
  /** The window's size, read on resize instead of per event. The raw
   * stream runs at the mouse's rate — a thousand a second on some — and
   * nothing on that path should be touching the DOM to ask a question
   * whose answer changes twice a session. */
  #w = 0;
  #h = 0;

  /** Set by the first pointerrawupdate to arrive. From then on the raw
   * stream steers the cursor and pointermove stops touching the position,
   * or the same travel would be counted twice. */
  #fast = false;
  /** Chromium reports one bogus movement immediately after a lock — the
   * jump from wherever the cursor was to wherever it warped it. Nobody
   * asked for that travel, so the first one after engaging is dropped. */
  #settling = false;
  /** The player let the lock go (Esc, or the browser did it for them).
   * Honored until they ask again, so a click is never a way back into
   * something they just left. */
  #declined = false;
  #disarm: (() => void) | null = null;
  #on = false;

  constructor(doc: Document) {
    this.#doc = doc;
    this.#root = doc.documentElement;
    // Where the drawn cursor stands if it is never told otherwise — a
    // player who reached full screen by keyboard alone has given us no
    // position to inherit, and the corner is the one place a cursor must
    // not appear in a game that scrolls from its edges.
    this.#measure();
    this.#x = this.#w / 2;
    this.#y = this.#h / 2;

    this.#cursor = doc.createElement('div');
    this.#cursor.setAttribute('aria-hidden', 'true');
    // Fixed, unhittable, and above the HUD's whole z scale. It cannot
    // outrank the top layer a tooltip's popover lives in by number alone,
    // so it is a popover itself — see #promote.
    this.#cursor.style.cssText =
      'position:fixed; left:0; top:0; margin:0; padding:0; border:0; background:transparent;' +
      ' pointer-events:none; display:none; will-change:transform; overflow:visible;' +
      ' filter:drop-shadow(0 1px 2px rgba(0,0,0,0.45)); z-index:2147483647;';
    this.#cursor.popover = 'manual';
    doc.body.appendChild(this.#cursor);

    this.#sheet = doc.createElement('style');

    const signal = this.#off.signal;
    for (const type of RELAYED) {
      doc.defaultView?.addEventListener(type, this.#onRaw, {
        capture: true,
        passive: false,
        signal,
      });
    }
    // Ahead of the frame: see the note on latency at the top.
    doc.defaultView?.addEventListener('pointerrawupdate', this.#onFast, {
      capture: true,
      signal,
    });
    for (const type of EATEN) {
      doc.defaultView?.addEventListener(type, this.#onEaten, { capture: true, signal });
    }
    // Where the drawn cursor starts: exactly where the real one stopped.
    // This listener never fires while locked — the interceptor above takes
    // those first — so what it holds is always the last honest position.
    doc.defaultView?.addEventListener(
      'pointermove',
      (e) => {
        if (!e.isTrusted || e.pointerType !== 'mouse') return;
        this.#calibrate(e);
        this.#x = e.clientX;
        this.#y = e.clientY;
      },
      { signal },
    );
    doc.defaultView?.addEventListener('resize', () => this.#measure(), { signal });
    doc.addEventListener('pointerlockchange', () => this.#lockChanged(), { signal });
    // A refusal — no transient activation, or a browser still cooling down
    // from the last Esc. Wait for a gesture and ask again on that.
    doc.addEventListener('pointerlockerror', () => this.#arm(), { signal });
    // The state this follows is fullscreen's, read through the module that
    // owns it; only the timing comes from the events, and prefixed engines
    // announce it under the older name.
    for (const type of ['fullscreenchange', 'webkitfullscreenchange']) {
      doc.addEventListener(
        type,
        () => {
          // Leaving full screen ends the argument: whatever the player did
          // to the lock last time is forgotten, and re-entering offers it
          // again from scratch.
          if (!fullscreen().active()) this.#declined = false;
          this.sync();
        },
        { signal },
      );
    }
    // A tooltip going up (or any popover) enters the top layer above
    // everything already in it, the drawn cursor included. Toggles do not
    // bubble, so this listens where every event passes: the capture phase
    // at the document.
    doc.addEventListener(
      'toggle',
      (e) => {
        if (this.#on && e.target !== this.#cursor) this.#promote();
      },
      { capture: true, signal },
    );
  }

  /** Live: is the pointer ours this instant? */
  get engaged(): boolean {
    return this.#on;
  }

  /**
   * Aim the rest of this gesture at `el`, whatever the drawn cursor goes
   * on to stand over — the capture the platform would have granted, kept
   * here instead because it will not grant one while it is locked. See
   * capturePointer, the only caller.
   */
  hold(el: Element): void {
    this.#held = el;
  }

  /** Take the lock, or give it up — whichever the screen, the platform and
   * the player's last word between them ask for. */
  sync(): void {
    const want = capturable() && !this.#declined && immersive();
    if (want === this.#on) return;
    if (want) this.#request();
    else this.#doc.exitPointerLock();
  }

  /** The player asked again — by the switch, which is also the gesture the
   * browser wants the request to come from. */
  rearm(): void {
    this.#declined = false;
    this.sync();
  }

  #request(): void {
    let asked: unknown;
    try {
      // Adjusted movement on purpose: the drawn cursor has to travel the
      // way the desktop's does, acceleration and all, or it will feel like
      // a different mouse than the one the player owns.
      asked = this.#root.requestPointerLock();
    } catch {
      // A refusal thrown rather than returned. It still has to arm, or the
      // capture is over before the player has done anything: this is the
      // path a launch into an already-full screen takes, where the request
      // goes out with no gesture behind it and the answer is always no.
      this.#arm();
      return;
    }
    // Chromium rejects a promise; Safari returns nothing and reports the
    // refusal through pointerlockerror instead. Both roads lead to #arm.
    if (asked instanceof Promise) void asked.catch(() => this.#arm());
  }

  /** Ask again on the next thing the browser would call a gesture. */
  #arm(): void {
    if (this.#disarm !== null || this.#on) return;
    this.#disarm = domGestures(this.#doc.defaultView ?? window)(() => {
      this.#disarm?.();
      this.#disarm = null;
      this.sync();
    });
  }

  /** The lock changed hands, in either direction and for any reason. */
  #lockChanged(): void {
    const locked = this.#doc.pointerLockElement === this.#root;
    if (locked === this.#on) return;
    this.#on = locked;
    if (locked) {
      this.#disarm?.();
      this.#disarm = null;
      this.#settling = true;
      this.#fast = false;
      this.#measure();
      this.#mirror();
      // Painted here rather than left to the first hover pass, which only
      // repaints when the shape under the cursor changes: without this the
      // very first frame of a capture draws nothing at all.
      this.#shape = 'default';
      this.#cursor.innerHTML = SHAPES.default!.svg;
      this.#place();
      this.#cursor.style.display = 'block';
      this.#promote();
      this.#hover();
    } else if (immersive()) {
      // Released without us asking, and the two reasons want opposite
      // answers. With the page still focused it was Esc or the browser's
      // own control — the player asking for their cursor back, and they
      // do not get dragged into another lock on their next click. Without
      // focus it was the platform: every engine drops the lock when the
      // window goes to the background, and a player who came back from
      // another app did not mean to give anything up, so the capture
      // waits for the gesture that returns and takes itself up again.
      if (this.#doc.hasFocus()) this.#declined = true;
      else this.#arm();
      this.#lapse();
    } else {
      this.#lapse();
    }
  }

  /** Put everything the drawn cursor was holding back down: the hover it
   * was standing in (a tooltip left up would never come down again), the
   * press it was in the middle of, the sprite itself. */
  #lapse(): void {
    this.#unschedule();
    this.#pending = null;
    this.#owedX = 0;
    this.#owedY = 0;
    this.#held = null;
    this.#slider = null;
    this.#pressed = [];
    this.#cross([], null);
    this.#cursor.style.display = 'none';
    try {
      this.#cursor.hidePopover();
    } catch {
      /* never shown */
    }
  }

  /** Drop both pending collections of the owed move. */
  #unschedule(): void {
    const view = this.#doc.defaultView ?? window;
    if (this.#frame !== null) {
      view.cancelAnimationFrame(this.#frame);
      this.#frame = null;
    }
    if (this.#timer !== null) {
      view.clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /** Back to the front of the top layer, above whatever just joined it.
   * Two attempts rather than one: hiding a popover that is not showing
   * throws, and that throw must not take the showing with it. */
  #promote(): void {
    try {
      this.#cursor.hidePopover();
    } catch {
      /* was not up */
    }
    try {
      this.#cursor.showPopover();
    } catch {
      // No popover here: the z-index still puts the cursor above
      // everything except the top layer a tooltip rides in.
    }
  }

  // --- The event plumbing ------------------------------------------------

  #onEaten = (e: Event): void => {
    if (this.#on && e.isTrusted) e.stopImmediatePropagation();
  };

  /**
   * The low-latency half of a move: advance the position, move the sprite,
   * and nothing else. No hit test, no dispatch, no class work — this
   * handler is on the path between the player's hand and the next frame,
   * and everything it does is one compositor-only transform.
   */
  #onFast = (e: Event): void => {
    if (!this.#on || !e.isTrusted || !ours(e)) return;
    e.stopImmediatePropagation();
    this.#fast = true;
    this.#step((e as PointerEvent).movementX, (e as PointerEvent).movementY);
  };

  #onRaw = (e: Event): void => {
    if (!this.#on || !e.isTrusted || !ours(e)) return;
    // Ours now: nothing downstream may see the version with the lock
    // target's meaningless position on it.
    e.stopImmediatePropagation();
    this.#relay(e as MouseEvent);
  };

  #relay(raw: MouseEvent): void {
    // Everything that is not a move happens where the move already has:
    // a press arriving before the frame's move went out would land on last
    // frame's hover, and a click would resolve against it.
    if (raw.type !== 'pointermove' && raw.type !== 'mousemove') this.#flush();
    switch (raw.type) {
      case 'pointermove': {
        // Where the cursor is has already been settled by the raw stream
        // wherever the engine has one; what is left is the half that costs
        // something, and it is owed to the next frame rather than done
        // here. Movement accumulates so nothing is lost by the wait.
        if (!this.#fast) this.#step(raw.movementX, raw.movementY);
        this.#owe(raw);
        break;
      }
      case 'mousemove':
        // The compatibility twin of the event above, carrying the same
        // motion; the flush emits both from the one template.
        break;
      case 'pointerdown': {
        const target = this.#aim();
        // Cleared before the press rather than after it: a listener that
        // takes the pointer does so through capturePointer, which writes
        // straight to #held, and reading the answer back afterwards must
        // not overwrite what the press itself just asked for.
        this.#held = null;
        this.#send(raw, 'pointerdown', target);
        // Whoever took the pointer during that press keeps it until the
        // release, exactly as the platform would have given it to them —
        // the rig's middle-drag pan asks for this, and without it the pan
        // would stall the moment the cursor crossed a HUD strip.
        if (this.#held === null && target !== null && held(target, raw)) this.#held = target;
        break;
      }
      case 'pointerup': {
        const target = this.#held ?? this.#aim();
        this.#held = null;
        this.#send(raw, 'pointerup', target);
        break;
      }
      case 'mousedown': {
        const target = this.#aim();
        this.#pressed = this.#chain.slice();
        this.#send(raw, 'mousedown', target);
        this.#focus(target);
        this.#grip(target, raw);
        break;
      }
      case 'mouseup': {
        this.#send(raw, 'mouseup', this.#held ?? this.#aim());
        this.#slide(raw, true);
        this.#slider = null;
        break;
      }
      case 'click':
      case 'auxclick':
      case 'dblclick': {
        // A click belongs to the nearest ancestor of both ends of the
        // press, which is the DOM's own rule and the reason a button
        // pressed on its label and released on its border still fires.
        const target = commonAncestor(this.#pressed, this.#chain) ?? this.#aim();
        this.#send(raw, raw.type, target);
        break;
      }
      case 'contextmenu':
      case 'wheel':
        this.#send(raw, raw.type, this.#aim());
        break;
    }
  }

  /**
   * Put the move on the tab, and let the next frame collect it.
   *
   * The frame is where this work belongs, and not only to spread it out.
   * The hit test forces layout, and forcing it from the input handler
   * forces it twice: once for us, and again for the frame proper after the
   * HUD has mutated behind us. Asked for here, our callback lands after
   * the renderer's — its next-frame callback was registered at the end of
   * the last one, before this event existed — so the layout we force is
   * the one the frame was going to do anyway.
   *
   * The timer beside it is the watchdog, for the frame that does not come.
   */
  #owe(raw: MouseEvent): void {
    this.#pending = raw;
    this.#schedule();
  }

  /** Ask the next frame — or the watchdog, if none comes — to flush. */
  #schedule(): void {
    if (this.#frame !== null) return;
    const view = this.#doc.defaultView ?? window;
    this.#frame = view.requestAnimationFrame(() => {
      this.#frame = null;
      this.#flush();
    });
    this.#timer ??= view.setTimeout(() => {
      this.#timer = null;
      this.#flush();
    }, STALL_MS);
  }

  /**
   * Pay it: one hit test, and one move of each kind carrying everything
   * that has arrived since the last frame. The template is the last real
   * event, which is only read for its modifier keys and buttons — the
   * position and the travel are ours.
   */
  #flush(): void {
    this.#unschedule();
    const template = this.#pending;
    if (template === null) return;
    this.#pending = null;
    const travel = { x: this.#owedX, y: this.#owedY };
    this.#owedX = 0;
    this.#owedY = 0;
    this.#hover();
    const target = this.#held ?? this.#aim();
    this.#send(template, 'pointermove', target, travel);
    this.#send(template, 'mousemove', target, travel);
    this.#drag();
  }

  /** Where the drawn cursor points, refreshed only when it has moved. */
  #aim(): Element | null {
    return this.#chain[0] ?? null;
  }

  /** Move the cursor and draw it there. Called from both streams, so the
   * lock's one bogus opening movement is dropped here rather than at
   * either call site. */
  #step(dx: number, dy: number): void {
    if (this.#settling) {
      this.#settling = false;
      return;
    }
    const travelX = dx / this.#gain;
    const travelY = dy / this.#gain;
    this.#x = slide(this.#x, travelX, this.#w);
    this.#y = slide(this.#y, travelY, this.#h);
    // Summed here, where the travel is applied, rather than read back off
    // the pointermove that arrives beside it. The position rides the raw
    // stream, and summing a second engine account of the same gesture for
    // the relay would leave the rig's middle-drag pan free to disagree with
    // the cursor that is dragging it. (Travel past the window's edge still
    // counts: the cursor stops there, the hand has not, and a pan that
    // stalled at the edge would be a worse answer than one that follows.)
    this.#owedX += travelX;
    this.#owedY += travelY;
    this.#place();
  }

  /** The window's size, taken once rather than per move. */
  #measure(): void {
    const view = this.#doc.defaultView ?? window;
    this.#w = view.innerWidth;
    this.#h = view.innerHeight;
  }

  /**
   * Learn what the engine's movement numbers are worth here, from the one
   * situation where both answers are visible at once: an unlocked mouse,
   * whose clientX travel is the desktop's own accelerated cursor and whose
   * movementX is what the lock will report for the same motion.
   *
   * The player's tracking speed and acceleration are already inside both,
   * which is the point — the drawn cursor is driven by exactly the numbers
   * the real one is, so it inherits their mouse settings whole rather than
   * imposing a sensitivity of ours. What the ratio catches is the unit
   * mismatch underneath: an engine that measures movement in device pixels
   * while clientX counts CSS pixels would send the cursor across a Retina
   * screen at twice the speed the same hand movement gives every other
   * application. Chrome does not — measured at exactly 1.000 on macOS at
   * devicePixelRatio 2, slow sweeps and fast alike — so on the machine
   * this was written for the correction is a no-op, and is kept only as a
   * floor under the engine that gets it wrong.
   *
   * Measured over accumulated travel rather than per event (a single
   * event's numbers are too small and too rounded to divide), from samples
   * small enough to be real motion — a warp, or a cursor held against the
   * side of the screen while the mouse keeps moving, would report travel
   * that never happened — and clamped, because a wrong correction is worse
   * than none.
   */
  #calibrate(e: PointerEvent): void {
    if (this.#travelled > 400) return; // settled; the answer will not change
    const dx = e.clientX - this.#x;
    const dy = e.clientY - this.#y;
    const travel = Math.hypot(dx, dy);
    const reported = Math.hypot(e.movementX, e.movementY);
    if (travel < 1 || travel > 200 || reported < 1 || reported > 800) return;
    this.#travelled += travel;
    this.#reported += reported;
    if (this.#travelled < 40) return;
    const ratio = this.#reported / this.#travelled;
    // Anything near 1 is 1. Chrome 151 on macOS at devicePixelRatio 2
    // measures 1.000 flat — the movement numbers are CSS pixels, the
    // mismatch this guards against is not there, and the correction has
    // nothing to do. Left in for the engine that does report device
    // pixels, but snapped rather than applied, because a measurement that
    // drifts a few percent off unity would otherwise cost the player a few
    // percent of their mouse for no reason at all.
    this.#gain = Math.abs(ratio - 1) < 0.1 ? 1 : Math.min(Math.max(ratio, 0.25), 4);
  }

  #place(): void {
    const shape = SHAPES[this.#shape] ?? SHAPES.default!;
    const [hx, hy] = shape.hot;
    // translate3d, not translate: the z keeps the sprite on its own
    // compositor layer, so moving it is a composite rather than a paint.
    this.#cursor.style.transform = `translate3d(${this.#x - hx}px, ${this.#y - hy}px, 0)`;
  }

  /** Recompute what the cursor is over, and tell the page about it in the
   * events a real crossing would have produced. */
  #hover(): void {
    // A panel that mounted since the last pass brought its own stylesheet
    // with its own hover rules. Cheap to notice, and this is the moment it
    // matters — the hover about to be handed out is the first that could
    // want them.
    if (this.#doc.styleSheets.length !== this.#sheetCount) this.#mirror();
    if (this.#held !== null) return; // a captured pointer crosses nothing
    const under = this.#doc.elementFromPoint(this.#x, this.#y);
    if (under === this.#aim()) return;
    this.#cross(chainOf(under), under);
  }

  /** Step the hover from the chain we are standing in to `next`. */
  #cross(next: Element[], under: Element | null): void {
    const prev = this.#chain;
    const from = prev[0] ?? null;
    const { left, entered } = boundary(prev, next);
    this.#chain = next;
    for (const el of left) el.classList.remove(VHOVER);
    for (const el of entered) el.classList.add(VHOVER);
    if (from !== null) {
      this.#boundary('pointerout', from, under, true);
      this.#boundary('mouseout', from, under, true);
      for (const el of left) {
        this.#boundary('pointerleave', el, under, false);
        this.#boundary('mouseleave', el, under, false);
      }
    }
    if (under !== null) {
      this.#boundary('pointerover', under, from, true);
      this.#boundary('mouseover', under, from, true);
      for (const el of entered) {
        this.#boundary('pointerenter', el, from, false);
        this.#boundary('mouseenter', el, from, false);
      }
    }
    const shape = shapeAt(under);
    if (shape !== this.#shape) {
      this.#shape = shape;
      this.#cursor.innerHTML = (SHAPES[shape] ?? SHAPES.default!).svg;
      this.#place();
    }
  }

  #boundary(type: string, target: Element, related: Element | null, bubbles: boolean): void {
    const init: PointerEventInit = {
      bubbles,
      cancelable: false,
      composed: true,
      clientX: this.#x,
      clientY: this.#y,
      relatedTarget: related,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      view: this.#doc.defaultView,
    };
    target.dispatchEvent(
      type.startsWith('pointer') ? new PointerEvent(type, init) : new MouseEvent(type, init),
    );
  }

  /**
   * The same event, aimed where the player is looking. A refusal travels
   * back the other way: the real event is still live and still cancelable
   * at this point, and the wheel over the map is the one that needs it —
   * unprevented, the browser zooms the page instead of the camera.
   */
  #send(
    raw: MouseEvent,
    type: string,
    target: Element | null,
    travel?: { x: number; y: number },
  ): void {
    if (target === null) return;
    const init: PointerEventInit & WheelEventInit = {
      bubbles: true,
      cancelable: raw.cancelable,
      composed: true,
      view: this.#doc.defaultView,
      detail: raw.detail,
      clientX: this.#x,
      clientY: this.#y,
      screenX: this.#x + (this.#doc.defaultView?.screenX ?? 0),
      screenY: this.#y + (this.#doc.defaultView?.screenY ?? 0),
      button: raw.button,
      buttons: raw.buttons,
      ctrlKey: raw.ctrlKey,
      shiftKey: raw.shiftKey,
      altKey: raw.altKey,
      metaKey: raw.metaKey,
      // In the same units as the position above, which is not the units
      // the engine reported them in: the rig's middle-drag pans by
      // movementX, and a drag that travelled a different distance from the
      // cursor dragging it would slide the map out from under the hand.
      // `travel` arrives already converted — it is the sum of what the
      // cursor moved — so only a lone event's own numbers need the gain.
      movementX: travel?.x ?? raw.movementX / this.#gain,
      movementY: travel?.y ?? raw.movementY / this.#gain,
      pointerId: raw instanceof PointerEvent ? raw.pointerId : 1,
      pointerType: 'mouse',
      isPrimary: true,
    };
    let event: Event;
    if (raw instanceof WheelEvent) {
      event = new WheelEvent(type, {
        ...init,
        deltaX: raw.deltaX,
        deltaY: raw.deltaY,
        deltaZ: raw.deltaZ,
        deltaMode: raw.deltaMode,
      });
    } else if (type.startsWith('pointer')) {
      event = new PointerEvent(type, init);
    } else {
      event = new MouseEvent(type, init);
    }
    if (!target.dispatchEvent(event)) raw.preventDefault();
  }

  /** What a real press does to focus, which a synthetic one does not: the
   * control under the cursor takes it, and a press on the map takes it off
   * whatever was holding it. */
  #focus(target: Element | null): void {
    const focusable = target?.closest<HTMLElement>(
      'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
    );
    if (focusable) focusable.focus();
    else if (this.#doc.activeElement instanceof HTMLElement) this.#doc.activeElement.blur();
  }

  /** Range inputs are dragged by the engine, not by their events, and the
   * engine will not do it for a synthetic press. The match has exactly one
   * — the menu's volume slider — so it is driven from here instead. */
  #grip(target: Element | null, raw: MouseEvent): void {
    const input = target?.closest<HTMLInputElement>('input[type="range"]') ?? null;
    this.#slider = input !== null && !input.disabled && raw.button === 0 ? input : null;
    this.#slide(raw, false);
  }

  #drag(): void {
    if (this.#slider !== null) this.#slide(null, false);
  }

  #slide(raw: MouseEvent | null, settle: boolean): void {
    const input = this.#slider;
    if (input === null) return;
    if (raw !== null && raw.button !== 0 && !settle) return;
    const box = input.getBoundingClientRect();
    if (box.width <= 0) return;
    const min = Number(input.min === '' ? 0 : input.min);
    const max = Number(input.max === '' ? 100 : input.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return;
    // Horizontal only: a vertical range is a writing-mode away and this
    // game has none.
    const along = Math.min(Math.max((this.#x - box.left) / box.width, 0), 1);
    const raw01 = min + along * (max - min);
    const step = input.step === 'any' ? 0 : Number(input.step === '' ? 1 : input.step);
    const value = step > 0 ? min + Math.round((raw01 - min) / step) * step : raw01;
    const next = String(Math.min(Math.max(value, min), max));
    if (next !== input.value) {
      input.value = next;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (settle) input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // --- Hover, mirrored ---------------------------------------------------

  /**
   * Copy every `:hover` rule in the document onto `.vhover`, so the class
   * this module hangs on the hovered chain styles it the way the browser's
   * own state would have. New sheets only; the ones already copied are
   * remembered, and the copy is re-appended last so a tie between two
   * equally specific rules goes to ours.
   */
  #mirror(): void {
    this.#sheetCount = this.#doc.styleSheets.length;
    const out: string[] = [];
    for (const sheet of this.#doc.styleSheets) {
      if (sheet === this.#sheet.sheet || this.#mirrored.has(sheet)) continue;
      this.#mirrored.add(sheet);
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // another origin's; not ours to read
      }
      collect(rules, out);
    }
    if (out.length === 0) return;
    this.#sheet.textContent = (this.#sheet.textContent ?? '') + out.join('\n');
    this.#doc.body.appendChild(this.#sheet);
  }

  dispose(): void {
    if (this.#on) this.#doc.exitPointerLock();
    this.#disarm?.();
    this.#off.abort();
    this.#lapse();
    this.#cursor.remove();
    this.#sheet.remove();
    this.#on = false;
  }
}

/**
 * Is an event of this shape the locked mouse's? Two things reach these
 * listeners that look like it and are not.
 *
 * A touch or a pen carries coordinates of its own and must keep them: a
 * laptop screen is still a screen while a mouse is locked. `pointerType`
 * is null here for the plain MouseEvents (mousemove, mouseup, wheel),
 * which have no device to name and are always the mouse's.
 *
 * An activation from the keyboard — Enter or Space on a focused button —
 * arrives as a click with no pointer behind it, and re-aiming that at the
 * drawn cursor would send it wherever the cursor happens to be rather than
 * to the button the player focused. `detail` separates the two: zero for
 * an activation, a click count for a press.
 *
 * The test is spelled as "everything but those two" rather than as
 * `pointerType === 'mouse'`, and that is the whole point of it. A locked
 * pointer has no position, and Chromium fires its click as a PointerEvent
 * with the pointerType left blank — so asking for 'mouse' relayed every
 * press and dropped every click. The clicks went on to the lock target
 * with the position the cursor had when it was captured, which is `html`
 * and a coordinate from minutes ago: nothing in the HUD was ever under
 * them, and the whole interface went dead while still lighting up under
 * the drawn cursor. Anything that changes this line wants a look at that
 * failure first.
 */
export function relayable(type: string, pointerType: string | null, detail: number): boolean {
  if (pointerType === 'touch' || pointerType === 'pen') return false;
  const activation = type === 'click' || type === 'auxclick' || type === 'dblclick';
  return !activation || detail !== 0;
}

/** The same question, asked of a real event. */
function ours(e: Event): boolean {
  const pointerType = e instanceof PointerEvent ? e.pointerType : null;
  return relayable(e.type, pointerType, (e as MouseEvent).detail);
}

/** Did a listener claim the pointer for the rest of this press? */
function held(target: Element, raw: MouseEvent): boolean {
  const id = raw instanceof PointerEvent ? raw.pointerId : 1;
  try {
    return target.hasPointerCapture(id);
  } catch {
    return false;
  }
}

/** Every hover rule in `rules`, rewritten, with the conditions it sits
 * under kept around it. */
function collect(rules: CSSRuleList, out: string[]): void {
  for (const rule of rules) {
    if (rule instanceof CSSStyleRule) {
      const alias = hoverAlias(rule.selectorText);
      if (alias !== null) out.push(`${alias}{${rule.style.cssText}}`);
    } else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
      const inner: string[] = [];
      collect(rule.cssRules, inner);
      if (inner.length > 0) {
        const at = rule instanceof CSSMediaRule ? '@media' : '@supports';
        out.push(`${at} ${rule.conditionText}{${inner.join('')}}`);
      }
    }
  }
}

// --- Where it applies -----------------------------------------------------

/**
 * Is taking the pointer on the table at all? A fine pointer and an engine
 * that can lock one. A finger has nothing to capture, and the guards also
 * let this module be imported where there is no window at all.
 */
function capturable(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (!('requestPointerLock' in document.documentElement)) return false;
  return window.matchMedia?.('(any-pointer: fine)').matches ?? false;
}

let live: MouseCapture | null = null;

/**
 * Take the pointer for the length of a gesture: aim everything that
 * follows at `el`, wherever the pointer wanders, until the button comes
 * back up.
 *
 * `Element.setPointerCapture` is the platform's own answer, and it cannot
 * be the only one here. Blink throws InvalidStateError from it for as long
 * as a pointer lock is engaged — whoever asks, and whether the event is
 * the browser's or one of ours — so every drag that reached for a capture
 * lost the rest of its handler to the throw the moment full screen started
 * capturing the mouse. The selection band was the visible half of that:
 * `display = 'block'` sits on the line after the capture, so the lasso
 * stopped being drawn while the selection it made went on working.
 *
 * Locked, the capture is this module's to keep — #held is the same
 * redirection by hand, and the relay already aims a held gesture's moves
 * and its release at the holder. Unlocked, the platform still does it, and
 * a refusal is swallowed: a capture is what a drag would like, never what
 * it needs, and no drag should end because one was declined.
 */
export function capturePointer(el: Element, e: PointerEvent): void {
  // A finger or a pen on the same machine keeps its own coordinates and is
  // none of this module's business (see `relayable`), so it is left to ask
  // the platform even while the mouse is ours.
  if (live?.engaged === true && e.pointerType !== 'touch' && e.pointerType !== 'pen') {
    live.hold(el);
    return;
  }
  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    /* no capture to be had; the gesture goes on without one */
  }
}

/**
 * Wire capture up for a match; the returned function takes it all down
 * again. One at a time — the second install would be a second drawn cursor
 * fighting the first for the same lock.
 */
export function installMouseCapture(doc: Document = document): () => void {
  live?.dispose();
  const capture = new MouseCapture(doc);
  live = capture;
  capture.sync();
  return () => {
    if (live === capture) live = null;
    capture.dispose();
  };
}
