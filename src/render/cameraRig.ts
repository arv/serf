import * as THREE from 'three';
import { DEFAULT_MAP_SIZE } from '../shared/grid';
import { clamp } from '../shared/math';
import { EdgeScroll, edgeScrollEnabled } from '../input/edgeScroll';
import { foreignChord, typingInto } from '../input/typing';
import { capturePointer } from '../input/mouseCapture';

/**
 * The line the game looks down at boot: 30° to the grid. The full 45°
 * diamond of Settlers and Age of Empires put the minimap's frame on the
 * diagonal; square to the grid, Warcraft's way, reads as a flat elevation
 * at this pitch. Thirty keeps the buildings' two faces showing while the
 * frame on the chart leans rather than stands on its corner. The props
 * were placed to read from 45° and none needed moving for it. The player
 * may turn away from it — Shift+wheel, Insert/Delete or [ ], in YAW_STEP
 * turns — and two turns square the view to the grid, where the minimap's
 * frame sits axis-aligned. Exported so pan.test.ts can hear the default
 * line through the same basis the rig hands the audio layer (viewFrame).
 */
export const CAMERA_YAW = Math.PI / 6;
const YAW = CAMERA_YAW;
const PITCH = (35 * Math.PI) / 180;
const DISTANCE = 90;
const MIN_VIEW = 5;
/**
 * One turn of the camera: 15°, so six make a quarter turn and two bring
 * the default line square to the grid. Stepped rather than free because
 * the aligned angles are the ones worth landing on exactly — a wheel that
 * turned by raw delta would leave the view (and the minimap's frame) a
 * few degrees off square every time.
 */
const YAW_STEP = Math.PI / 12;
/** Wheel travel that buys one turn, in pixels: a notch of a mouse wheel,
 * a short two-finger drag on a trackpad. */
const WHEEL_PER_TURN = 100;
/**
 * What a wheel event's delta means, per deltaMode, in pixels.
 *
 * Only Chromium-on-a-mouse hands over anything like pixels. Firefox
 * reports lines — three of them to a notch, so raw deltas would want
 * thirty-odd notches for one turn — and a page-mode event (rare, but the
 * spec allows it) is one screenful. The zoom reads the same normalized
 * number, so it too stops being three-hundredths of its intended speed on
 * a Firefox mouse.
 *
 * Forty pixels to the line is the figure the scroll-normalizing libraries
 * settled on; a notch of three lines lands just past one turn, which is
 * what it should mean. Landing *past* the mark is safe because a turn
 * spends the whole bank rather than the price (see #turnByWheel).
 */
const WHEEL_LINE_PX = 40;
const WHEEL_PAGE_PX = 800;
/** WheelEvent.DOM_DELTA_LINE / _PAGE. Written out rather than read off the
 * constructor: the values are fixed by the spec, and naming the global
 * would make this line throw wherever WheelEvent is not defined. */
const DELTA_LINE = 1;
const DELTA_PAGE = 2;
/** Time constant of the turn's ease, seconds — quick enough that a run of
 * notches reads as one sweep, slow enough that a single turn is seen
 * happening rather than cut to. */
const YAW_EASE = 0.08;
/** A held turn key turns at this rate, radians per second — a quarter
 * turn a second, Warcraft's pace. The release settles on a step (see
 * #settleKeyTurn), so the keys land where the wheel lands. */
const KEY_TURN_RATE = Math.PI / 2;
/**
 * The turn keys and which way each turns (Delete's way is a wheel-down
 * notch's). Insert and Delete are Warcraft's pair; [ and ] are for the
 * keyboards that have neither — a Mac laptop's Delete is an fn chord and
 * its Insert does not exist. Keyed by code, the physical key, so the
 * bracket pair is the two keys right of P on any layout; the bare names
 * are the fallback for a source that leaves the code blank.
 *
 * A screen with other plans for these can decline the whole lot — see
 * setTurnEnabled.
 */
const TURN_KEYS = new Map<string, number>([
  ['Delete', 1],
  ['Insert', -1],
  ['BracketRight', 1],
  ['BracketLeft', -1],
  [']', 1],
  ['[', -1],
]);
/**
 * How much world the camera frames at boot, and why it is not one number.
 *
 * #viewHeight is a span in world units, and the frustum's width comes from
 * it times the aspect — so the size a castle is drawn at is the window's
 * height in pixels divided by this. A fixed 30 meant a 900px desktop drew
 * 30px to the world unit and a phone held sideways, 390px tall, drew 13:
 * the same village at less than half scale, adrift in a frame 67 units
 * wide because the aspect had spent all that width on fog.
 *
 * So the boot view is a number of pixels per world unit instead, and the
 * span is whatever the window makes of it. BOOT_VIEW is the ceiling, and
 * it is the old constant exactly: a desktop window is tall enough to hit
 * it, so nothing changes there. Everything shorter frames less world and
 * draws it at the size it was designed to be read at.
 *
 * The player's own zoom is untouched — this sets where they start, and
 * the wheel and the pinch go where they always went.
 */
const BOOT_PX_PER_UNIT = 30;
const BOOT_VIEW = 30;
/**
 * Zoom-out cap as a fraction of the playable side, whatever the map size.
 *
 * This number and the scenery ring's depth (marginFor, shared/grid.ts) are
 * one decision written in two places, and this is the half that decides
 * it. A frame's footprint on the ground is not its height: the 35° pitch
 * stretches it by 1/sin, so a view of 0.8 playable sides lay across 1.4 of
 * them, and once the pan allowance was added the far corner reached about
 * half a playable side past the boundary. The ring had to be that deep or
 * the corner found the end of the world — which is how the grid came to be
 * four times the area anyone could play on, three quarters of it ground
 * nobody could enter, most of that seen only in one corner of one zoom
 * level.
 *
 * At 0.5 the corner reaches about two fifths of a side out before the pan
 * clamp has its say — and VIEW_PAN_INSET below is what takes most of that
 * back, leaving the ring at under a third. What the cap costs is the far
 * end of the wheel: full zoom-out frames about 84 tiles of a 96-tile side
 * rather than 134, so the valley fills the frame at its widest instead of
 * sitting in the middle of a frame half again its size. The wheel opens 30
 * to 48 — a 1.6x range where the original pairing had 2.6x, and the
 * minimap is what carries the rest.
 */
const MAX_VIEW_FRACTION = 0.5;
/** Shore breathing room: how far past the box the pan target may reach at
 * the closest zooms, before the view's own footprint is what bounds it
 * (see #panRange). The scenery margin beyond is for looking at, not for
 * visiting. */
const PAN_MARGIN = 4;
/**
 * How much of the view's ground span counts against the pan range.
 *
 * This is the constant that buys the scenery ring, and it is worth being
 * plain about the trade. Whatever share of its own footprint the pan does
 * NOT charge, the frame is free to hang past the play square — and real
 * ground has to be there to fill it, which is what marginFor
 * (shared/grid.ts) is. Charge less and the pan stays loose while the ring
 * pays for it; charge more and the ring comes in while the pan stiffens at
 * the zoomed-out end.
 *
 * The footprint measure is the AABB around a rectangle the yaw has turned
 * (a diamond at 45°), so along either world axis it reports the far
 * corners — true, but only across a thin band. Charging the whole of it
 * would be the strictest reading and it is far too strict: past about 0.37
 * the play square's corner cannot be brought into frame at full zoom-out
 * at any angle, which is a valley you cannot look at the whole of.
 *
 * The binding limit arrives earlier than that cliff, and it is about the
 * DEFAULT angle rather than the best one. At full zoom-out on the default
 * line, two of the four corners are reachable and two are not — the frame
 * is a turned rectangle over a square map, so it favours one diagonal. At
 * 0.30 the largest valley loses even those two, and at 0.35 every valley
 * does: the player has to turn the camera square to the grid to look at
 * the edge of their own map. 0.28 is the last step that keeps them.
 *
 * So: near-free close in, tighter than it was at full zoom-out, the same
 * corners in frame on the default line as before, and a ring of 36 tiles
 * on the default valley where a quarter wanted 40. Both halves are pinned
 * in cameraRig.test.ts — one test says the frame never leaves the grid,
 * the other says the valley can still be looked at.
 */
const VIEW_PAN_INSET = 0.28;
/**
 * The keys that pan, and the screen-space direction each asks for.
 *
 * Arrows only. WASD panned here too until the letters were needed for
 * orders and the build chord — A cannot both pan left and attack-move, and
 * a square with its left corner missing is worse than no square. Nothing
 * lost a home: the arrows do this, the edge push does it without a key at
 * all, and a middle-drag does it faster than either.
 *
 * A table rather than the four ifs it replaces because #motionPending has
 * to read the same list, and two copies of it would drift.
 */
const PAN_KEYS: readonly (readonly [string, number, number])[] = [
  ['ArrowUp', 0, -1],
  ['ArrowDown', 0, 1],
  ['ArrowLeft', -1, 0],
  ['ArrowRight', 1, 0],
];

/**
 * How long the view still counts as under way after its last motion — see
 * CameraRig.driving. Touch deltas arrive in bursts and a finger paused
 * mid-swipe is still mid-swipe, so a strict "moved this very instant"
 * would drop the frame rate back to its resting cap between samples and
 * hand the gesture a stutter the cap on its own never had.
 */
const DRIVE_TAIL_MS = 200;

/** Scratch for #footprintExt, which runs per pan and per frame. */
const EXT = { x: 0, z: 0 };
/** Scratch for #apply, which runs on every pan, glide step and turn. */
const DIR = new THREE.Vector3();

/** Conservative world-space XZ rectangle of the visible ground. */
export interface ViewBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Where the frame sits on the ground, for code that places things by
 * screen position without projecting through the camera (the audio layer
 * pans by it): the look-at point, screen-right as a unit vector on the
 * ground, and a half-extent. See viewFrame.
 */
export interface ViewFrame {
  cx: number;
  cz: number;
  rx: number;
  rz: number;
  ext: number;
}

/**
 * The two ways this rig can look at the ground. 'game' is the classic
 * fixed isometric line every match uses. 'topDown' is the map editor's
 * plan view: straight down, north up — the whole map reads like a chart,
 * which is what authoring a symmetric map wants. Same target, same zoom,
 * same input handling; only the viewing line changes.
 */
export type ViewMode = 'game' | 'topDown';
/** A quarter turn: straight down. The lookAt up-vector is swapped to -Z in
 * this mode, so the parallel-vectors degeneracy never arises. */
const TOP_PITCH = Math.PI / 2;

/**
 * Classic isometric-style orthographic rig: fixed pitch, a yaw the player
 * can turn in steps, panning moves a ground-plane target, zoom scales the
 * frustum height.
 */
export class CameraRig {
  /**
   * Every listener this rig registers, on one signal. A match ends without
   * the document ending now, so all of them have to come off — the window
   * ones because nothing else would ever remove them, and the canvas ones
   * because a detached canvas is not necessarily a dead one: three keeps
   * GPU buffers in WeakMaps keyed by its own module-level geometries, which
   * live as long as the page does, and a canvas reachable through those
   * would drag this rig — and its renderer, scene and every geometry in it
   * — along behind it.
   */
  #off = new AbortController();
  readonly camera: THREE.OrthographicCamera;
  #canvas: HTMLCanvasElement;
  /** Playable-world bounds being viewed; setPlayBounds updates them when
   * the init frame announces the real ones. The camera is bounded to the
   * play square (Warcraft-style) — the scenery ring beyond is for looking
   * at, not for visiting. */
  #min = 0;
  #max = DEFAULT_MAP_SIZE;
  #target = new THREE.Vector3(DEFAULT_MAP_SIZE / 2, 0, DEFAULT_MAP_SIZE / 2);
  #viewHeight = BOOT_VIEW;
  /** Viewing line; the module constants are the game's fixed values, and
   * every construction starts there — setViewMode is the editor's door. */
  #pitch = PITCH;
  #yaw = YAW;
  /** How many YAW_STEPs the player has turned from the line the view mode
   * starts on; tick eases #yaw toward that angle. An integer, not an
   * accumulated angle, so a hundred turns still land exactly square. */
  #turns = 0;
  /** Wheel travel banked toward the next turn (see #turnByWheel). */
  #wheelAcc = 0;
  /** Whether this camera turns at all — see setTurnEnabled. */
  #turnEnabled = true;
  /** performance.now() at the camera's last motion — see driving. */
  #movedAt = -Infinity;
  /** The camera has moved since anyone last asked — see consumeMoved. */
  #moved = true;
  /** The turn direction the keys held last tick (-1, 0, 1), and the step
   * the press began on — what the release settles against. */
  #keyTurn = 0;
  #turnsAtPress = 0;
  /**
   * Turn-key presses no tick has yet seen held. Down and up inside one
   * frame — a quick tap on a slow frame — would otherwise turn nothing;
   * keyup turns each one a step instead.
   *
   * A set rather than the last key pressed, because opposite keys have to
   * cancel here the way they cancel everywhere else: with one slot, a
   * Delete and an Insert both pressed before a tick could run left only
   * the second, and the pair turned a step instead of nothing.
   */
  #unseen = new Set<string>();
  #maxViewFraction = MAX_VIEW_FRACTION;
  #keys = new Set<string>();
  #dragging = false;
  #interactive: boolean;
  #edge = new EdgeScroll();
  /** Touch pan/pinch gate: Controls closes it while a marquee drag owns
   * the finger, so the map holds still under the selection band. */
  touchPanEnabled = true;
  /** In-flight glideTo tween; null when the camera is at rest or the
   * player grabbed it back (any manual pan or focusOn cancels the glide). */
  #glide: { fromX: number; fromZ: number; toX: number; toZ: number; t: number; dur: number } | null =
    null;

  /**
   * `interactive: false` builds a rig nobody can drive — no key, wheel or
   * drag listeners at all. The start screen's backdrop needs that: its
   * listeners would otherwise be live under the menu, and typing a room
   * code into the form would pan the scene behind it.
   */
  constructor(canvas: HTMLCanvasElement, interactive = true) {
    this.#canvas = canvas;
    this.#interactive = interactive;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 400);
    this.#viewHeight = clamp(
      this.#canvas.clientHeight / BOOT_PX_PER_UNIT,
      MIN_VIEW,
      Math.min(BOOT_VIEW, this.#maxView()),
    );
    // ?zoom=6 boots close-in — handy for inspecting people and props.
    const zoom = Number(new URLSearchParams(location.search).get('zoom'));
    if (Number.isFinite(zoom) && zoom > 0) {
      this.#viewHeight = clamp(zoom, MIN_VIEW, this.#maxView());
    }
    this.resize();
    this.#apply();
    if (!interactive) return;

    const signal = this.#off.signal;
    // Keys are tracked by code — the physical key — because that is what
    // the bracket pair means: the two keys right of P, wherever a layout
    // puts the glyphs. The key name stands in only where the code is
    // blank, as synthetic and some assistive input paths leave it. (The
    // letter shortcuts in controls.ts take the opposite order, and are
    // right to: a player pressing B for Build wants the glyph they see.)
    const keyCode = (e: KeyboardEvent): string => e.code || e.key;
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      // A key going into a field is being typed, and a chord belongs to
      // the browser: ⌘[ is Back, and it must not also turn the camera.
      // Ctrl is foreign here too — unlike Controls, the rig binds nothing
      // to it. Only keydown is gated; keyup below has to stay
      // unconditional so a key held when focus moved into a field is
      // still let go of.
      if (foreignChord(e) || e.ctrlKey || typingInto(e.target)) return;
      const code = keyCode(e);
      this.#keys.add(code);
      if (this.#turnKey(code) !== 0) this.#unseen.add(code);
    }, { signal });
    window.addEventListener('keyup', (e) => {
      const code = keyCode(e);
      this.#keys.delete(code);
      if (!this.#unseen.delete(code)) return;
      if (this.#pitch !== TOP_PITCH) this.#turns += this.#turnKey(code);
    }, { signal });
    window.addEventListener('blur', () => {
      this.#keys.clear();
      this.#unseen.clear();
      this.#edge.clear();
    }, { signal });
    window.addEventListener('resize', () => this.resize(), { signal });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.#edge.clear();
    }, { signal });

    // --- Edge scroll ------------------------------------------------------
    // On the window rather than the canvas, because the HUD's own strips sit
    // inside the bands: a canvas listener would go dead wherever a control
    // opts back into pointer events, and the scroll would cut out over the
    // resource strip in the very corner it was crossing.
    window.addEventListener('pointermove', (e) => {
      // A finger has its own way to move the map, and turning the switch
      // off mid-match has to stop a push already under way.
      if (!edgeScrollEnabled() || e.pointerType !== 'mouse') {
        this.#edge.clear();
        return;
      }
      // A left-drag band is deliberately not blocked: it resolves against
      // live screen positions on release (controls.ts #selectInRect), so
      // dragging into an edge extends the selection past the view exactly
      // the way the genre does, and what the band covers on screen is what
      // it catches.
      const target = e.target;
      const blocked =
        this.#dragging || // a middle-drag is already panning
        (target instanceof Element && target.closest('#ui, #menu') !== null);
      this.#edge.moved(e.clientX, e.clientY, window.innerWidth, window.innerHeight, blocked);
    }, { signal });
    // A null relatedTarget is the pointer leaving the window altogether —
    // onto the menu bar, or off the display. Every other pointerout is just
    // a boundary between two elements of ours.
    window.addEventListener('pointerout', (e) => {
      if (e.relatedTarget === null) this.#edge.left();
    }, { signal });

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        // Deltas arrive in lines or pages as readily as in pixels; both
        // the turn and the zoom want one unit.
        const px =
          e.deltaMode === DELTA_LINE
            ? WHEEL_LINE_PX
            : e.deltaMode === DELTA_PAGE
              ? WHEEL_PAGE_PX
              : 1;
        if (e.shiftKey) {
          // Shift+wheel turns. Some platforms hand a shifted wheel over as
          // horizontal travel (Chromium on Windows and Linux, a few
          // trackpad drivers) — whichever axis carries the motion is it.
          const travel = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          this.#turnByWheel(travel * px);
          return;
        }
        this.#viewHeight = clamp(
          this.#viewHeight * Math.exp(e.deltaY * px * 0.0012),
          MIN_VIEW,
          this.#maxView(),
        );
        this.resize();
      },
      { passive: false, signal },
    );

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.#dragging = true;
        capturePointer(canvas, e);
      }
    }, { signal });
    canvas.addEventListener('pointerup', (e) => {
      if (e.button === 1) this.#dragging = false;
    }, { signal });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.#dragging) return;
      const worldPerPixel = this.#viewHeight / this.#canvas.clientHeight;
      this.#panScreen(-e.movementX * worldPerPixel, -e.movementY * worldPerPixel);
    }, { signal });

    // --- Touch: one finger drags the map, two fingers pinch to zoom ------
    // (There is no wheel, middle button, or keyboard on a phone.) Selection
    // and orders stay with Controls, which ignores multi-touch gestures.
    const touches = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;
    const spread = (): number => {
      const [a, b] = [...touches.values()];
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };
    canvas.addEventListener('touchstart', (e) => {
      for (const t of e.changedTouches) {
        touches.set(t.identifier, { x: t.clientX, y: t.clientY });
      }
      if (touches.size === 2) pinchDist = spread();
    }, { signal });
    canvas.addEventListener(
      'touchmove',
      (e) => {
        e.preventDefault(); // no browser scroll/zoom over the map
        if (!this.touchPanEnabled) {
          // A selection band owns this drag; just keep the anchors fresh so
          // reopening the gate mid-gesture doesn't lurch the camera.
          for (const t of e.changedTouches) {
            const prev = touches.get(t.identifier);
            if (prev) {
              prev.x = t.clientX;
              prev.y = t.clientY;
            }
          }
          return;
        }
        const worldPerPixel = this.#viewHeight / this.#canvas.clientHeight;
        // Pan by the average finger delta, so a pinch doesn't also lurch.
        let dx = 0;
        let dy = 0;
        let moved = 0;
        for (const t of e.changedTouches) {
          const prev = touches.get(t.identifier);
          if (!prev) continue;
          dx += t.clientX - prev.x;
          dy += t.clientY - prev.y;
          moved++;
          prev.x = t.clientX;
          prev.y = t.clientY;
        }
        if (moved > 0) {
          this.#panScreen((-dx / moved) * worldPerPixel, (-dy / moved) * worldPerPixel);
        }
        if (touches.size === 2) {
          const d = spread();
          if (pinchDist > 0 && d > 0) {
            this.#viewHeight = clamp(this.#viewHeight * (pinchDist / d), MIN_VIEW, this.#maxView());
            this.resize();
          }
          pinchDist = d;
        }
      },
      { passive: false, signal },
    );
    const endTouch = (e: TouchEvent): void => {
      for (const t of e.changedTouches) touches.delete(t.identifier);
      if (touches.size < 2) pinchDist = 0;
    };
    canvas.addEventListener('touchend', endTouch, { signal });
    canvas.addEventListener('touchcancel', endTouch, { signal });
  }

  /**
   * Let every listener go at once.
   *
   * Each closure captures `this`, and a rig is reachable from its
   * renderer, its scene, and every mesh, geometry and texture in it. A
   * page used to hold one match for its lifetime, so leaving them attached
   * cost nothing; now the menu comes back and another match follows, and
   * each match that had gone would still be held here in full — plus a
   * keydown feeding phantom pan keys to a camera nobody can see.
   */
  dispose(): void {
    this.#off.abort();
    this.#keys.clear();
  }

  #maxView(): number {
    return Math.round((this.#max - this.#min) * this.#maxViewFraction);
  }

  /**
   * Bank wheel travel (in pixels) and turn once it reaches WHEEL_PER_TURN,
   * so a mouse notch is one turn and a trackpad's stream of small deltas
   * adds up to the same. A reversal forgets what was banked: travel toward
   * one turn must not be spent on the opposite one.
   *
   * A turn empties the bank rather than paying WHEEL_PER_TURN out of it,
   * and one event can never buy two. Otherwise a notch worth more than the
   * price — 120 pixels on a Windows mouse, 120 more once Firefox's three
   * lines are normalized — would leave change behind every time, and every
   * fifth notch would spend the pile on a second turn the hand never asked
   * for. Overshoot is not travel the player means to bank; it is just how
   * coarsely their device counts.
   */
  #turnByWheel(delta: number): void {
    if (delta === 0 || !this.#turnEnabled) return;
    // The plan view is north-up by definition — a chart does not turn.
    if (this.#pitch === TOP_PITCH) return;
    if (Math.sign(delta) !== Math.sign(this.#wheelAcc)) this.#wheelAcc = 0;
    this.#wheelAcc += delta;
    if (Math.abs(this.#wheelAcc) < WHEEL_PER_TURN) return;
    this.#turns += Math.sign(this.#wheelAcc);
    this.#wheelAcc = 0;
  }

  /** The angle #turns names: the view mode's own line plus the steps. */
  #yawTarget(): number {
    return (this.#pitch === TOP_PITCH ? 0 : YAW) + this.#turns * YAW_STEP;
  }

  /** Which way the held turn keys are asking to turn this tick. Opposite
   * keys cancel, and the plan view no more turns for a key than for the
   * wheel. */
  #heldTurn(): number {
    if (this.#pitch === TOP_PITCH) return 0;
    let d = 0;
    for (const key of this.#keys) d += this.#turnKey(key);
    return Math.sign(d);
  }

  /** Whether any turn key is physically down, whatever they net to — what
   * tells a cancelled turn apart from a released one. */
  #turnKeyDown(): boolean {
    if (this.#pitch === TOP_PITCH) return false;
    for (const key of this.#keys) if (this.#turnKey(key) !== 0) return true;
    return false;
  }

  /** Which way this key turns the camera here, or 0 if it does not. */
  #turnKey(code: string): number {
    if (!this.#turnEnabled) return 0;
    return TURN_KEYS.get(code) ?? 0;
  }

  /**
   * Whether this camera turns at all. The map editor says no.
   *
   * Turning is a thing the view does under a hand that is pointing at
   * something, and the editor's hand is always pointing at something: a
   * brush cursor on the ground, a stroke being painted from the last
   * ground point to this one, a start marker held by a world-space
   * offset. Every one of those is derived from a pointer event and
   * recomputed only when the pointer moves, so a camera that turned under
   * a still hand would leave the preview off the cursor, streak the next
   * stroke segment from where the ground used to be, and slide a marker
   * being dragged. The match answers this with consumeMoved and one hover
   * scan; the editor would need it in three places, in a subsystem this
   * has no other business in.
   *
   * And it loses the editor nothing: turning has never been available
   * there, the view toggle is how that screen changes its angle, and the
   * brackets it binds to the brush radius stop meaning two things at once.
   *
   * A turn already eased goes on to its step; what stops is taking any
   * more. Held keys are let go of here so none can stick.
   */
  setTurnEnabled(on: boolean): void {
    this.#turnEnabled = on;
    if (on) return;
    for (const key of TURN_KEYS.keys()) {
      this.#keys.delete(key);
      this.#unseen.delete(key);
    }
    this.#wheelAcc = 0;
  }

  /** The step nearest the angle the camera is actually showing. */
  #nearestStep(): number {
    return Math.round((this.#yaw - (this.#pitch === TOP_PITCH ? 0 : YAW)) / YAW_STEP);
  }

  /**
   * A key has just been let go: land on a step. The nearest one to where
   * the hold left the camera — so a long turn stops where the eye says it
   * should, never swinging back past what it just watched go by.
   *
   * With one floor under it: a press is worth at least one step past the
   * one it began on, in the direction it went. That is what makes a tap a
   * step at all (three degrees rounds to nothing), and it is why the floor
   * is counted from #turnsAtPress rather than from the live angle — a tap
   * landed mid-way through a wheel turn's ease is still short of that
   * turn's target, and rounding where it stands would cancel the turn it
   * was meant to add to.
   */
  #settleKeyTurn(): void {
    const near = this.#nearestStep();
    const floor = this.#turnsAtPress + this.#keyTurn;
    this.#turns = this.#keyTurn > 0 ? Math.max(near, floor) : Math.min(near, floor);
  }

  /** Swap between the game's isometric line and the editor's plan view. */
  setViewMode(mode: ViewMode): void {
    this.#pitch = mode === 'topDown' ? TOP_PITCH : PITCH;
    this.#yaw = mode === 'topDown' ? 0 : YAW;
    this.#turns = 0;
    this.#wheelAcc = 0;
    this.#keyTurn = 0;
    this.#unseen.clear();
    // Looking straight down, +Y up is parallel to the view line; -Z as up
    // puts north at the top of the screen instead.
    this.camera.up.set(0, mode === 'topDown' ? 0 : 1, mode === 'topDown' ? -1 : 0);
    this.#apply();
  }

  /** Editor override: let more of the world fit in one frame than the
   * game's cap allows. The default fraction stays put for every match. */
  setMaxViewFraction(f: number): void {
    this.#maxViewFraction = f;
    this.#viewHeight = clamp(this.#viewHeight, MIN_VIEW, this.#maxView());
    this.resize();
  }

  /**
   * Half-extents, along world X and Z, of the AABB around the view
   * frustum's ground footprint (a parallelogram whose screen-vertical
   * extent stretches by 1/sin(pitch)). Screen right and screen "up" each
   * project onto world X/Z through the yaw basis (at 45° both weights are
   * SQRT1_2 and the two axes come out equal).
   *
   * Written into the caller's object — this runs per pan and per frame.
   */
  #footprintExt(out: { x: number; z: number }): { x: number; z: number } {
    const aspect = this.#canvas.clientWidth / Math.max(this.#canvas.clientHeight, 1);
    const halfH = this.#viewHeight / 2;
    const halfW = halfH * aspect;
    const halfG = halfH / Math.sin(this.#pitch);
    const c = Math.abs(Math.cos(this.#yaw));
    const s = Math.abs(Math.sin(this.#yaw));
    out.x = halfW * c + halfG * s;
    out.z = halfW * s + halfG * c;
    return out;
  }

  /**
   * How far the pan target may stray from the box's center along one
   * axis, given that axis's view half-extent: the box's half-span plus a
   * little shore allowance, less a share of what the view already covers.
   * Close in that is the whole box; as the view grows it tightens, until
   * at full zoom-out the map simply frames itself. Keeping the camera off
   * the scenery ring is the point — it is there to keep the world from
   * looking cut off, not to be scrolled to.
   *
   * The box is #min..#max, which is the play square in a match and the
   * whole grid in the editor (which paints the margin and must reach it).
   */
  #panRange(ext: number): number {
    const half = (this.#max - this.#min) / 2;
    return Math.max(0, half + PAN_MARGIN - 2 * ext * VIEW_PAN_INSET);
  }

  /**
   * Clamp one axis of a prospective pan target, ratcheted against where
   * the camera already is: focusOn centers border castles without asking,
   * and a target parked beyond the range is never yanked back for it —
   * it just cannot be pushed further out. So neither a focus nor a
   * zoom-out ever makes the next arrow key snap the view sideways.
   */
  #clampAxis(next: number, current: number, ext: number): number {
    const mid = (this.#min + this.#max) / 2;
    const bound = Math.max(this.#panRange(ext), Math.abs(current - mid));
    return clamp(next, mid - bound, mid + bound);
  }

  /**
   * The world's actual grid side, once known (the init frame carries it).
   * Recenters on the new middle and re-clamps the zoom — callers focus the
   * camera on their castle right after, so the recenter is just a sane
   * default for viewers with no home to look at.
   */
  setPlayBounds(min: number, max: number): void {
    this.#min = min;
    this.#max = max;
    this.#target.set((min + max) / 2, 0, (min + max) / 2);
    this.#viewHeight = clamp(this.#viewHeight, MIN_VIEW, this.#maxView());
    this.resize();
  }

  /** Per-frame: apply held pan keys. dt in seconds. */
  /** Point the camera at a spot on the ground, optionally reframing. */
  focusOn(x: number, z: number, viewHeight?: number): void {
    this.#glide = null;
    this.#target.set(x, 0, z);
    if (viewHeight !== undefined) {
      this.#viewHeight = clamp(viewHeight, MIN_VIEW, this.#maxView());
      this.resize(); // recomputes the frustum, then applies
      return;
    }
    this.#apply();
  }

  /** Glide the camera to a spot instead of snapping — the toast's "take me
   * there". Any manual pan or focusOn cancels the glide mid-flight. */
  glideTo(x: number, z: number, durationMs = 400): void {
    if (durationMs <= 0) {
      this.focusOn(x, z);
      return;
    }
    const ext = this.#footprintExt(EXT);
    this.#glide = {
      fromX: this.#target.x,
      fromZ: this.#target.z,
      toX: this.#clampAxis(x, this.#target.x, ext.x),
      toZ: this.#clampAxis(z, this.#target.z, ext.z),
      t: 0,
      dur: durationMs / 1000,
    };
  }

  tick(dt: number): void {
    // A press this tick finds still down is a hold, whatever it nets to
    // with the other keys — only a press no tick ever sees is a tap.
    for (const key of this.#unseen) if (this.#keys.has(key)) this.#unseen.delete(key);
    const held = this.#interactive ? this.#heldTurn() : 0;
    if (held !== 0) {
      // A held key turns freely, at its own pace; the step grid waits for
      // the release.
      //
      // A fresh press begins on the step the camera is bound for, which is
      // where the floor in #settleKeyTurn has to count from — mid-ease
      // that is the turn already under way, not the angle on screen. A
      // direction flip under the hand begins wherever the flip caught the
      // camera, which is off-grid, so the nearest step stands in: the leg
      // being walked is the one the release settles against, not one
      // abandoned before it.
      if (this.#keyTurn === 0) this.#turnsAtPress = this.#turns;
      else if (this.#keyTurn !== held) this.#turnsAtPress = this.#nearestStep();
      this.#yaw += held * KEY_TURN_RATE * dt;
      this.#apply();
      this.#keyTurn = held;
    } else if (this.#keyTurn !== 0 && this.#turnKeyDown()) {
      // Both keys down at once: a stop, not a release. Hold the camera
      // exactly where it is and keep the direction, so the step grid still
      // waits for the release the way the branch above promises. Settling
      // here would snap the view mid-hold and then resume free turning the
      // moment one key came up — a cancel that lurches, twice.
    } else {
      if (this.#keyTurn !== 0) this.#settleKeyTurn();
      this.#keyTurn = 0;
      const yawTarget = this.#yawTarget();
      if (this.#yaw !== yawTarget) {
        // Ease toward the target; the camera orbits its look-at point, so
        // the spot mid-screen stays put while the world swings round it.
        const d = yawTarget - this.#yaw;
        this.#yaw =
          Math.abs(d) < 1e-4 ? yawTarget : this.#yaw + d * (1 - Math.exp(-dt / YAW_EASE));
        this.#apply();
      }
    }
    const glide = this.#glide;
    if (glide) {
      glide.t = Math.min(glide.t + dt, glide.dur);
      const p = glide.t / glide.dur;
      // Ease-in-out cubic: gentle start, gentle landing.
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      this.#target.x = glide.fromX + (glide.toX - glide.fromX) * e;
      this.#target.z = glide.fromZ + (glide.toZ - glide.fromZ) * e;
      this.#apply();
      if (glide.t >= glide.dur) this.#glide = null;
    }
    if (!this.#interactive) return;
    const speed = this.#viewHeight * 0.9 * dt;
    let dx = 0;
    let dz = 0;
    for (const [code, kx, kz] of PAN_KEYS) {
      if (!this.#keys.has(code)) continue;
      dx += kx * speed;
      dz += kz * speed;
    }
    // Same units as a held key, so a corner pushing both axes travels at the
    // diagonal rate two held arrows already do rather than being normalized
    // apart.
    const push = this.#edge.tick(dt);
    if (push) {
      dx += push.x * speed;
      dz += push.z * speed;
    }
    if (dx !== 0 || dz !== 0) this.#panScreen(dx, dz);
  }

  /** Pan in screen space: x = right on screen, z = down on screen. */
  #panScreen(x: number, z: number): void {
    this.#glide = null;
    // Screen right in world space (yaw only), screen "up" projected on ground.
    const rx = Math.cos(this.#yaw);
    const rz = -Math.sin(this.#yaw);
    const fx = -Math.sin(this.#yaw);
    const fz = -Math.cos(this.#yaw);
    const ext = this.#footprintExt(EXT);
    this.#target.x = this.#clampAxis(this.#target.x + rx * x - fx * z, this.#target.x, ext.x);
    this.#target.z = this.#clampAxis(this.#target.z + rz * x - fz * z, this.#target.z, ext.z);
    this.#apply();
  }

  /**
   * World-space XZ corners of the ground the frame shows — the exact
   * rectangle, turned by the yaw, not the AABB viewBounds() wraps around
   * it (turned 45° the two differ by nearly half their area, and a minimap
   * drawing the AABB would claim the camera sees ground it doesn't; square
   * to the grid they coincide).
   * Order: screen top-left, top-right, bottom-right, bottom-left, packed
   * as x,z pairs into `out` — the minimap polls this every animation
   * frame to see whether the camera moved, so it allocates nothing.
   */
  viewQuad(out: Float64Array): Float64Array {
    const aspect = this.#canvas.clientWidth / Math.max(this.#canvas.clientHeight, 1);
    const halfW = (this.#viewHeight / 2) * aspect;
    // The screen's vertical half-span, stretched onto the ground plane —
    // the same 1/sin(pitch) #footprintExt uses.
    const halfG = this.#viewHeight / 2 / Math.sin(this.#pitch);
    // Screen right and screen up, projected on the ground (the yaw basis
    // #panScreen pans along).
    const rx = Math.cos(this.#yaw);
    const rz = -Math.sin(this.#yaw);
    const ux = -Math.sin(this.#yaw);
    const uz = -Math.cos(this.#yaw);
    const tx = this.#target.x;
    const tz = this.#target.z;
    out[0] = tx + ux * halfG - rx * halfW;
    out[1] = tz + uz * halfG - rz * halfW;
    out[2] = tx + ux * halfG + rx * halfW;
    out[3] = tz + uz * halfG + rz * halfW;
    out[4] = tx - ux * halfG + rx * halfW;
    out[5] = tz - uz * halfG + rz * halfW;
    out[6] = tx - ux * halfG - rx * halfW;
    out[7] = tz - uz * halfG - rz * halfW;
    return out;
  }

  /**
   * The frame's place on the ground for code that cannot afford to project
   * through the camera: centre, screen-right on the ground, and a
   * half-extent padded by `margin` exactly as viewBounds pads — the
   * off-screen allowance is part of what the audio layer was tuned to.
   *
   * The extent is the half-span of the square viewBounds becomes at 45°
   * (the line the audio was tuned on), and it is held at that value
   * whichever way the camera faces: the AABB of a footprint square to the
   * grid is the footprint itself, narrower along one axis and wider along
   * the other, and a loudness that swung with it would make a turn sound
   * like a zoom.
   *
   * Screen-up on the ground is screen-right turned a quarter: (rz, -rx).
   * Written into `out` — this runs per frame.
   */
  viewFrame(margin = 3, out: ViewFrame = { cx: 0, cz: 0, rx: 0, rz: 0, ext: 0 }): ViewFrame {
    const aspect = this.#canvas.clientWidth / Math.max(this.#canvas.clientHeight, 1);
    const halfH = this.#viewHeight / 2;
    const halfW = halfH * aspect;
    const halfG = halfH / Math.sin(this.#pitch);
    out.cx = this.#target.x;
    out.cz = this.#target.z;
    out.rx = Math.cos(this.#yaw);
    out.rz = -Math.sin(this.#yaw);
    out.ext = (halfW + halfG) * Math.SQRT1_2 + margin;
    return out;
  }

  /**
   * Conservative world-space XZ bounds of the visible ground, with margin.
   * Used to skip per-frame animation work for units nobody can see; the
   * margin also absorbs the screen shift terrain height introduces.
   */
  viewBounds(margin = 3, out: ViewBounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 }): ViewBounds {
    const ext = this.#footprintExt(EXT);
    out.minX = this.#target.x - ext.x - margin;
    out.maxX = this.#target.x + ext.x + margin;
    out.minZ = this.#target.z - ext.z - margin;
    out.maxZ = this.#target.z + ext.z + margin;
    return out;
  }

  resize(): void {
    const aspect = this.#canvas.clientWidth / Math.max(this.#canvas.clientHeight, 1);
    const halfH = this.#viewHeight / 2;
    const halfW = halfH * aspect;
    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.updateProjectionMatrix();
    this.#apply();
  }

  /**
   * Has the camera moved since this was last called? Asking clears it.
   *
   * For work that is deferred until something changes and would otherwise
   * wait on the wrong thing: the hover scan runs when the pointer moves,
   * which is the right trigger for a still camera and the wrong one for a
   * turning camera under a still hand. The ground under the cursor
   * changes either way.
   */
  consumeMoved(): boolean {
    const moved = this.#moved;
    this.#moved = false;
    return moved;
  }

  /**
   * Is the view under way — moving now, or a moment ago?
   *
   * Unlike consumeMoved this answers without spending anything, because
   * it is asked before the frame is committed to rather than during it:
   * the frame pacer asks (see MOBILE_INTERACT_FPS_CAP), and a phone that
   * draws the valley at 30 fps to spare its battery lifts that cap for as
   * long as the player is actually pushing the camera around. Nothing on
   * screen minds the resting rate until the ground itself is the thing
   * being dragged, and then the frame rate *is* how far behind the finger
   * the map runs.
   *
   * Every way the camera moves counts — a finger, a pinch, a middle-drag,
   * the arrow keys, the edge push, a turn, a glide. All of them are the
   * whole picture sliding, and all of them are watched while they happen.
   */
  driving(now: number): boolean {
    return this.#motionPending() || now - this.#movedAt < DRIVE_TAIL_MS;
  }

  /**
   * Motion the camera is committed to but has not applied yet.
   *
   * #movedAt on its own always answers a frame late at the start of a
   * movement, because of where driving is asked from: the pacer decides
   * whether this frame runs, and tick — where every deferred motion is
   * realized — runs inside the frame being decided about. A glide is the
   * plain case. glideTo files the ride and applies nothing until the tick
   * the pacer has not allowed yet, so the camera would open the ride on a
   * resting-cap frame: the one moment of a "take me there" a player is
   * certain to be watching. Held keys are the same shape, an easing yaw
   * likewise.
   *
   * The edge push is the one deferred source left out. It is mouse-only
   * (see the pointerType gate in the constructor), and a device with a
   * mouse is a device whose pacer is uncapped — there is no cap there for
   * it to lift. Its state is also private to EdgeScroll, and reaching for
   * it would mean a reader that exists for nothing.
   */
  #motionPending(): boolean {
    if (this.#glide !== null) return true;
    if (this.#yaw !== this.#yawTarget()) return true;
    // Both key paths in tick are gated on this, so this predicate is too.
    if (!this.#interactive) return false;
    if (this.#heldTurn() !== 0) return true;
    return PAN_KEYS.some(([code]) => this.#keys.has(code));
  }

  #apply(): void {
    this.#moved = true;
    this.#movedAt = performance.now();
    DIR.set(
      Math.cos(this.#pitch) * Math.sin(this.#yaw),
      Math.sin(this.#pitch),
      Math.cos(this.#pitch) * Math.cos(this.#yaw),
    );
    this.camera.position.copy(this.#target).addScaledVector(DIR, DISTANCE);
    this.camera.lookAt(this.#target);
    // lookAt moves the camera's position and quaternion and stops there;
    // the world matrix those feed is three's to rebuild, and it does that
    // inside render(). Everything that picks — a hover, an order, a
    // building being placed — projects through that matrix, and pointer
    // handlers run whenever the hand moves, not only between frames. Left
    // to render() it would answer for wherever the camera last *drew*,
    // which a pan makes stale and a turn makes wrong. Rebuild it here, at
    // the one place the camera ever moves, so a reader is never early.
    this.camera.updateMatrixWorld();
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
  }
}
