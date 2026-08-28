import * as THREE from 'three';
import {DEFAULT_MAP_SIZE, gridFor} from '../shared/grid';
import {CameraRig} from './cameraRig';
import {background, fog, groundBounce, skyLight} from './palette';

/** How many frames a fence may hold the loop before it is written off as
 * one that will never signal. Four is longer than any real frame and short
 * enough that a driver misbehaving costs a stutter rather than a freeze. */
const STALL_FRAMES = 4;

/**
 * Owns the WebGL context, scene, lights, and camera rig. Content (terrain,
 * scatter, entity visuals) is added to `scene` by the composition root.
 */
export class GameRenderer {
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  #webgl: THREE.WebGLRenderer;
  #sun: THREE.DirectionalLight;
  #lastTime = performance.now();
  /** The GPU's receipt for the last frame drawn, or null when nothing is in
   * flight. See gpuReady. */
  #fence: WebGLSync | null = null;
  #stalls = 0;
  #observer: ResizeObserver;
  #onWindowResize: () => void;

  constructor(canvas: HTMLCanvasElement, interactive = true) {
    // Phones and tablets render the same scene on a far smaller GPU: trade
    // resolution and shadow crispness for framerate. Desktop is unchanged.
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    this.#webgl = new THREE.WebGLRenderer({canvas, antialias: !coarse});
    this.#webgl.setPixelRatio(
      Math.min(window.devicePixelRatio, coarse ? 1.5 : 2),
    );
    // Construction sites reveal their model with a clip plane.
    this.#webgl.localClippingEnabled = true;
    this.#webgl.shadowMap.enabled = true;
    this.#webgl.shadowMap.type = THREE.PCFSoftShadowMap;
    // ACES filmic gives the saturated, contrasty "game" grade the flat
    // Lambert colors lack on their own.
    this.#webgl.toneMapping = THREE.ACESFilmicToneMapping;
    this.#webgl.toneMappingExposure = 1.32;

    this.scene.background = new THREE.Color(background);
    this.rig = new CameraRig(canvas, interactive);

    const hemi = new THREE.HemisphereLight(skyLight, groundBounce, 1.05);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff1cf, 2.7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(coarse ? 1024 : 2048, coarse ? 1024 : 2048);
    sun.shadow.camera.near = 5;
    sun.shadow.bias = -0.0004;
    this.scene.add(sun, sun.target);
    this.#sun = sun;
    this.setWorldExtent(DEFAULT_MAP_SIZE, gridFor(DEFAULT_MAP_SIZE));

    // ResizeObserver over a window listener: it fires whenever the canvas
    // box actually changes — including viewport changes that never dispatch
    // a window resize event (devtools panes, embedded previews). Both are
    // kept and both fire for an ordinary window drag, so the handler skips
    // sizes it has already applied: setSize reallocates the drawing buffer
    // even for the width it has, and during a drag that ran twice per
    // event, ~20ms apiece — enough to drop frames the whole way down.
    let appliedW = 0;
    let appliedH = 0;
    const resize = (): void => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w > 0 && h > 0 && (w !== appliedW || h !== appliedH)) {
        appliedW = w;
        appliedH = h;
        this.#webgl.setSize(w, h, false);
        this.rig.resize();
      }
    };
    this.#observer = new ResizeObserver(resize);
    this.#observer.observe(canvas);
    this.#onWindowResize = resize;
    window.addEventListener('resize', resize);
    resize();
  }

  /**
   * Size the world-extent-dependent pieces — fog band, sun placement, and
   * the shadow camera's box — to the map actually being shown. Called with
   * the default at construction and again when the init frame announces the
   * real size (the rig learns it in the same breath). The formulas
   * reproduce the classic hand-tuned values at 64 (fog 124/268 ≈ 125/270,
   * shadow far 164 ≈ 160) and scale up from there.
   */
  setWorldExtent(play: number, grid = gridFor(play)): void {
    // Everything scales with the PLAYABLE span (the world the camera can
    // frame), centered on the grid's middle — which is the play square's
    // middle too, the margin being symmetric. Bright stylized daylight:
    // distant pale haze that swallows the far scenery before the grid
    // runs out.
    this.scene.fog = new THREE.Fog(fog, play + 60, play * 2 + 140);
    const sun = this.#sun;
    const mid = grid / 2;
    sun.position.set(mid - 28, 55, mid + 18);
    sun.target.position.set(mid, 0, mid);
    const half = play * 0.75;
    sun.shadow.camera.left = -half;
    sun.shadow.camera.right = half;
    sun.shadow.camera.top = half;
    sun.shadow.camera.bottom = -half;
    sun.shadow.camera.far = grid + 100;
    sun.shadow.camera.updateProjectionMatrix();
    this.rig.setPlayBounds(mid - play / 2, mid + play / 2);
  }

  /**
   * Give the GPU back. The menu backdrop needs this so that handing over to
   * a match can drop the whole context rather than share one — a canvas
   * cannot hand out a second WebGL context, and a renderer that has
   * released its own cannot be revived — and so does every match, now that
   * one ends without the document ending with it.
   *
   * The rig goes too. Its listeners are on the window rather than the
   * canvas, so nothing else would ever take them off, and each one holds
   * the rig — and through it this renderer, the scene, and every geometry
   * and texture the match uploaded.
   */
  /** Draw-call / triangle counters for the last rendered frame. Read by
   * the DEV console handle and the screenshot tooling. */
  get info(): THREE.WebGLRenderer['info'] {
    return this.#webgl.info;
  }

  dispose(): void {
    if (this.#fence !== null) {
      this.#gl()?.deleteSync(this.#fence);
      this.#fence = null;
    }
    this.#observer.disconnect();
    window.removeEventListener('resize', this.#onWindowResize);
    this.rig.dispose();
    this.#webgl.dispose();
    this.#webgl.forceContextLoss();
  }

  /**
   * Advance the camera and return the frame's dt (seconds).
   *
   * Split from the draw because half the frame reads the camera before
   * anything is drawn — where the view falls on the ground (culling, the
   * audio's stereo basis), and which way the screen faces (the billboards
   * that have to sit parallel to it). Ticking last meant every one of
   * them answered for the camera of the frame before, and the picture
   * went out under the new one. A pan could hide that; a turn cannot.
   *
   * Call this first, then read the camera, then render.
   */
  update(): number {
    const now = performance.now();
    const dt = Math.min((now - this.#lastTime) / 1000, 0.25);
    this.#lastTime = now;
    this.rig.tick(dt);
    return dt;
  }

  /**
   * Draw the scene as the camera now stands.
   *
   * `camera` overrides the rig — the start screen's backdrop looks at the
   * same scene through a perspective lens from ground level, which the
   * orthographic rig cannot express.
   */
  render(camera?: THREE.Camera): void {
    this.#webgl.render(this.scene, camera ?? this.rig.camera);
    this.#mark();
  }

  /**
   * Has the GPU finished the last frame we gave it?
   *
   * Asked before a frame is built, and the answer is the difference between
   * a game that responds and one that does not. Left to itself the loop
   * hands the compositor a frame every refresh whether or not the last one
   * has been drawn, and on macOS the pipeline behind it will happily accept
   * six before it starts pushing back. Everything still arrives at a steady
   * sixty — and everything the player sees is six frames old. Measured on
   * this scene: 124ms from the frame beginning to the pixels appearing,
   * with the renderer's own callback taking 0.06ms of it. Nothing was slow;
   * it was queued.
   *
   * A fence is the receipt. Drop a marker in the command stream after the
   * draw, and refuse to build another frame until the GPU has passed it: at
   * most one frame in flight, the queue empty behind it, and the same sixty
   * frames a second arriving 100ms sooner. (Measured after: 24ms at the
   * ninetieth percentile, against 157ms before.)
   *
   * Skipping costs nothing — every update in the loop is time-based, so
   * play continues at full speed and is simply drawn when the GPU is ready
   * to draw it, which is the frame rate it was managing anyway.
   *
   * Two ways out, because a fence that never signals would stop the game
   * dead: WebGL1 has none of this and answers true forever, and a fence
   * that has held us for STALL_FRAMES is abandoned rather than believed.
   */
  gpuReady(): boolean {
    if (this.#fence === null) return true;
    const gl = this.#gl();
    if (gl === null) return true;
    if (gl.clientWaitSync(this.#fence, 0, 0) !== gl.TIMEOUT_EXPIRED) {
      gl.deleteSync(this.#fence);
      this.#fence = null;
      this.#stalls = 0;
      return true;
    }
    if (++this.#stalls < STALL_FRAMES) return false;
    // Long enough. Whatever the driver is doing with that fence, the game
    // is not waiting on it any further.
    gl.deleteSync(this.#fence);
    this.#fence = null;
    this.#stalls = 0;
    return true;
  }

  /** The context, when it is one that can hold a fence at all. */
  #gl(): WebGL2RenderingContext | null {
    const gl = this.#webgl.getContext() as
      | WebGLRenderingContext
      | WebGL2RenderingContext;
    return 'fenceSync' in gl ? (gl as WebGL2RenderingContext) : null;
  }

  /** Leave the receipt, and push the commands out so the GPU can start on
   * them rather than waiting for the queue to fill. */
  #mark(): void {
    const gl = this.#gl();
    if (gl === null) return;
    if (this.#fence !== null) gl.deleteSync(this.#fence);
    this.#fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
  }

  /**
   * Advance and draw in one call, for a caller with nothing in between —
   * the menu backdrop, which reads no camera of its own.
   */
  frame(camera?: THREE.Camera): number {
    const dt = this.update();
    this.render(camera);
    return dt;
  }
}
