import * as THREE from 'three';
import { MAP_SIZE } from '../shared/grid';
import { clamp } from '../shared/math';

const YAW = Math.PI / 4; // fixed 45° — models only need to read from one angle
const PITCH = (35 * Math.PI) / 180;
const DISTANCE = 90;
const MIN_VIEW = 5;
const MAX_VIEW = 52;
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
  #target = new THREE.Vector3(MAP_SIZE / 2, 0, MAP_SIZE / 2);
  #viewHeight = 30;
  #keys = new Set<string>();
  #dragging = false;
  #interactive: boolean;
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
      this.#viewHeight = clamp(zoom, MIN_VIEW, MAX_VIEW);
    }
    this.resize();
    this.#apply();
    if (!interactive) return;

    const signal = this.#off.signal;
    window.addEventListener('keydown', (e) => {
      if (!e.repeat) this.#keys.add(e.code);
    }, { signal });
    window.addEventListener('keyup', (e) => this.#keys.delete(e.code), { signal });
    window.addEventListener('blur', () => this.#keys.clear(), { signal });
    window.addEventListener('resize', () => this.resize(), { signal });

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.#viewHeight = clamp(
          this.#viewHeight * Math.exp(e.deltaY * 0.0012),
          MIN_VIEW,
          MAX_VIEW,
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
            this.#viewHeight = clamp(this.#viewHeight * (pinchDist / d), MIN_VIEW, MAX_VIEW);
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

  /** Per-frame: apply held pan keys. dt in seconds. */
  /** Point the camera at a spot on the ground, optionally reframing. */
  focusOn(x: number, z: number, viewHeight?: number): void {
    this.#glide = null;
    this.#target.set(x, 0, z);
    if (viewHeight !== undefined) {
      this.#viewHeight = clamp(viewHeight, MIN_VIEW, MAX_VIEW);
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
      toX: clamp(x, -PAN_MARGIN, MAP_SIZE + PAN_MARGIN),
      toZ: clamp(z, -PAN_MARGIN, MAP_SIZE + PAN_MARGIN),
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
    if (this.#keys.has('KeyW') || this.#keys.has('ArrowUp')) dz -= speed;
    if (this.#keys.has('KeyS') || this.#keys.has('ArrowDown')) dz += speed;
    if (this.#keys.has('KeyA') || this.#keys.has('ArrowLeft')) dx -= speed;
    if (this.#keys.has('KeyD') || this.#keys.has('ArrowRight')) dx += speed;
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
    this.#target.x = clamp(this.#target.x + rx * x - fx * z, -PAN_MARGIN, MAP_SIZE + PAN_MARGIN);
    this.#target.z = clamp(this.#target.z + rz * x - fz * z, -PAN_MARGIN, MAP_SIZE + PAN_MARGIN);
    this.#apply();
  }

  /**
   * Conservative world-space XZ bounds of the visible ground, with margin —
   * the axis-aligned box around the ortho frustum's ground footprint (a 45°
   * parallelogram whose screen-vertical extent stretches by 1/sin(pitch)).
   * Used to skip per-frame animation work for units nobody can see; the
   * margin also absorbs the screen shift terrain height introduces.
   */
  viewBounds(margin = 3, out: ViewBounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 }): ViewBounds {
    const aspect = this.#canvas.clientWidth / Math.max(this.#canvas.clientHeight, 1);
    const halfH = this.#viewHeight / 2;
    const halfW = halfH * aspect;
    const halfG = halfH / Math.sin(PITCH);
    // Both screen axes project onto world X/Z with |cos 45°| = |sin 45°|.
    const ext = Math.SQRT1_2 * (halfW + halfG) + margin;
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
