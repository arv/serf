import * as THREE from 'three';
import { DEFAULT_MAP_SIZE } from '../shared/grid';
import { clamp } from '../shared/math';
import { EdgeScroll, edgeScrollEnabled } from '../input/edgeScroll';

/** Fixed 45° — models only need to read from one angle. Exported because
 * audio/pan.ts hard-codes the screen basis this yaw induces (a subtraction,
 * no trig); its test pins the two together so they cannot drift apart. */
export const CAMERA_YAW = Math.PI / 4;
const YAW = CAMERA_YAW;
const PITCH = (35 * Math.PI) / 180;
const DISTANCE = 90;
const MIN_VIEW = 5;
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
 * The footprint measure is the AABB around a diamond the yaw has turned
 * 45°, so along either world axis it reports the diamond's far corners —
 * true, but only across a thin band, and charging the whole of it would
 * lock the camera at zooms that still show a third of the map. A quarter
 * is what keeps the map filling the frame at every zoom without the pan
 * going stiff: near-free close in, near-centered at full zoom-out.
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
 * Classic isometric-style orthographic rig: fixed yaw/pitch, panning moves a
 * ground-plane target, zoom scales the frustum height.
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
    window.addEventListener('keydown', (e) => {
      if (!e.repeat) this.#keys.add(e.code);
    }, { signal });
    window.addEventListener('keyup', (e) => this.#keys.delete(e.code), { signal });
    window.addEventListener('blur', () => {
      this.#keys.clear();
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
        this.#viewHeight = clamp(
          this.#viewHeight * Math.exp(e.deltaY * 0.0012),
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

  /** Swap between the game's isometric line and the editor's plan view. */
  setViewMode(mode: ViewMode): void {
    this.#pitch = mode === 'topDown' ? TOP_PITCH : PITCH;
    this.#yaw = mode === 'topDown' ? 0 : YAW;
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
   * project onto world X/Z through the yaw basis; at the game's 45° both
   * weights are SQRT1_2 and the two axes come out equal.
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
   * parallelogram, not the AABB viewBounds() wraps around it (under the
   * fixed 45° yaw the two differ by nearly half their area, and a minimap
   * drawing the AABB would claim the camera sees ground it doesn't).
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
