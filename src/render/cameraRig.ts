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
/** Zoom-out cap as a fraction of the map side — the whole island plus a
 * ring of open water frames at full zoom, whatever the map size (matches
 * the classic 52-on-64 feel). */
const MAX_VIEW_FRACTION = 0.8;
/** Shore breathing room: how far past the play square the pan target may
 * reach at the closest zooms, before the view's own footprint is what
 * bounds it (see #panRange). The scenery margin beyond is for looking
 * at, not for visiting. */
const PAN_MARGIN = 4;

/** Conservative world-space XZ rectangle of the visible ground. */
export interface ViewBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

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
  #viewHeight = 30;
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
    return Math.round((this.#max - this.#min) * MAX_VIEW_FRACTION);
  }

  /** Half-extent, along each world axis, of the AABB around the view
   * frustum's ground footprint (a 45° parallelogram whose screen-vertical
   * extent stretches by 1/sin(pitch)). */
  #footprintExt(): number {
    const aspect = this.#canvas.clientWidth / Math.max(this.#canvas.clientHeight, 1);
    const halfH = this.#viewHeight / 2;
    // Both screen axes project onto world X/Z with |cos 45°| = |sin 45°|.
    return Math.SQRT1_2 * (halfH * aspect + halfH / Math.sin(PITCH));
  }

  /**
   * How far the pan target may stray from the play square's center: the
   * play half-span plus a little shore allowance, less half the view's
   * own ground footprint — so at least half of what is on screen is
   * always the playable map, never mostly the scenery ring (which exists
   * to keep the world from looking cut off, not to be scrolled to).
   * Close in that is nearly the whole square; zoomed all the way out the
   * island frames itself near-centered, Warcraft-style.
   */
  #panRange(): number {
    return Math.max(0, (this.#max - this.#min) / 2 + PAN_MARGIN - this.#footprintExt() / 2);
  }

  /**
   * Clamp one axis of a prospective pan target, ratcheted against where
   * the camera already is: focusOn centers border castles without asking,
   * and a target parked beyond the range is never yanked back for it —
   * it just cannot be pushed further out. So neither a focus nor a
   * zoom-out ever makes the next arrow key snap the view sideways.
   */
  #clampAxis(next: number, current: number): number {
    const mid = (this.#min + this.#max) / 2;
    const bound = Math.max(this.#panRange(), Math.abs(current - mid));
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
    this.#glide = {
      fromX: this.#target.x,
      fromZ: this.#target.z,
      toX: this.#clampAxis(x, this.#target.x),
      toZ: this.#clampAxis(z, this.#target.z),
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
    const rx = Math.cos(YAW);
    const rz = -Math.sin(YAW);
    const fx = -Math.sin(YAW);
    const fz = -Math.cos(YAW);
    this.#target.x = this.#clampAxis(this.#target.x + rx * x - fx * z, this.#target.x);
    this.#target.z = this.#clampAxis(this.#target.z + rz * x - fz * z, this.#target.z);
    this.#apply();
  }

  /**
   * Conservative world-space XZ bounds of the visible ground, with margin.
   * Used to skip per-frame animation work for units nobody can see; the
   * margin also absorbs the screen shift terrain height introduces.
   */
  viewBounds(margin = 3, out: ViewBounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 }): ViewBounds {
    const ext = this.#footprintExt() + margin;
    out.minX = this.#target.x - ext;
    out.maxX = this.#target.x + ext;
    out.minZ = this.#target.z - ext;
    out.maxZ = this.#target.z + ext;
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
      Math.cos(PITCH) * Math.sin(YAW),
      Math.sin(PITCH),
      Math.cos(PITCH) * Math.cos(YAW),
    );
    this.camera.position.copy(this.#target).addScaledVector(dir, DISTANCE);
    this.camera.lookAt(this.#target);
  }
}
