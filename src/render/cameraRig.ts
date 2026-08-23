import * as THREE from 'three';
import { DEFAULT_MAP_SIZE } from '../shared/grid';
import { clamp } from '../shared/math';
import { EdgeScroll, edgeScrollEnabled } from '../input/edgeScroll';

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
/** Zoom-out cap as a fraction of the map side — the whole island plus a
 * ring of open water frames at full zoom, whatever the map size (matches
 * the classic 52-on-64 feel). */
const MAX_VIEW_FRACTION = 0.8;
/** Shore breathing room: how far past the box the pan target may reach at
 * the closest zooms, before the view's own footprint is what bounds it
 * (see #panRange). The scenery margin beyond is for looking at, not for
 * visiting. */
const PAN_MARGIN = 4;
/**
 * How much of the view's ground span counts against the pan range.
 *
 * The footprint measure is the AABB around a rectangle the yaw has turned
 * (a diamond at 45°), so along either world axis it reports the far
 * corners — true, but only across a thin band, and charging the whole of
 * it would lock the camera at zooms that still show a third of the map. A
 * quarter is what keeps the map filling the frame at every zoom without
 * the pan going stiff: near-free close in, near-centered at full zoom-out.
 */
const VIEW_PAN_INSET = 0.25;
/** Scratch for #footprintExt, which runs per pan and per frame. */
const EXT = { x: 0, z: 0 };

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
  /** The turn direction the keys held last tick (-1, 0, 1), and the step
   * the press began on — what the release settles against. */
  #keyTurn = 0;
  #turnsAtPress = 0;
  /** A turn-key press no tick has yet seen held. Down and up inside one
   * frame — a quick tap on a slow frame — would otherwise turn nothing;
   * keyup turns it one step instead. */
  #unseenPress: string | null = null;
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
      const code = keyCode(e);
      this.#keys.add(code);
      if (TURN_KEYS.has(code)) this.#unseenPress = code;
    }, { signal });
    window.addEventListener('keyup', (e) => {
      const code = keyCode(e);
      this.#keys.delete(code);
      if (this.#unseenPress !== code) return;
      this.#unseenPress = null;
      if (this.#pitch !== TOP_PITCH) this.#turns += TURN_KEYS.get(code)!;
    }, { signal });
    window.addEventListener('blur', () => {
      this.#keys.clear();
      this.#unseenPress = null;
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
        canvas.setPointerCapture(e.pointerId);
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
    if (delta === 0) return;
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
    for (const key of this.#keys) d += TURN_KEYS.get(key) ?? 0;
    return Math.sign(d);
  }

  /** Whether any turn key is physically down, whatever they net to — what
   * tells a cancelled turn apart from a released one. */
  #turnKeyDown(): boolean {
    if (this.#pitch === TOP_PITCH) return false;
    for (const key of this.#keys) if (TURN_KEYS.has(key)) return true;
    return false;
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
    this.#unseenPress = null;
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
    if (this.#unseenPress !== null && this.#keys.has(this.#unseenPress)) this.#unseenPress = null;
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
    // Arrows only. WASD panned here too until the letters were needed for
    // orders and the build chord — A cannot both pan left and attack-move,
    // and a square with its left corner missing is worse than no square.
    // Nothing lost a home: the arrows do this, the edge push does it without
    // a key at all, and a middle-drag does it faster than either.
    if (this.#keys.has('ArrowUp')) dz -= speed;
    if (this.#keys.has('ArrowDown')) dz += speed;
    if (this.#keys.has('ArrowLeft')) dx -= speed;
    if (this.#keys.has('ArrowRight')) dx += speed;
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

  #apply(): void {
    const dir = new THREE.Vector3(
      Math.cos(this.#pitch) * Math.sin(this.#yaw),
      Math.sin(this.#pitch),
      Math.cos(this.#pitch) * Math.cos(this.#yaw),
    );
    this.camera.position.copy(this.#target).addScaledVector(dir, DISTANCE);
    this.camera.lookAt(this.#target);
  }
}
