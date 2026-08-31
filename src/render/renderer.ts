import * as THREE from 'three';
import {DEFAULT_MAP_SIZE, gridFor} from '../shared/grid';
import {CameraRig, type ViewBounds, type ViewFrame} from './cameraRig';
import {background, fog, groundBounce, skyLight} from './palette';

/** How many frames a fence may hold the loop before it is written off as
 * one that will never signal. Four is longer than any real frame and short
 * enough that a driver misbehaving costs a stutter rather than a freeze. */
const STALL_FRAMES = 4;

/**
 * Where the sun stands, as the offset from the ground it lights.
 *
 * The hand-picked (-28, 55, 18) of the old world-centred rig, kept exactly:
 * for a directional light this vector is the whole of what reaches a
 * surface, so the valley is lit at the same angle it always was. Only its
 * length has stopped mattering — the position is nothing but the shadow
 * camera's origin, and that now slides along this line to follow the view.
 */
const SUN_DIR = new THREE.Vector3(-28, 55, 18).normalize();

/** The shadow camera's two lateral axes, in world space — the basis three
 * builds for it out of SUN_DIR and a Y-up. Constant, because SUN_DIR is,
 * and needed here to snap the box to its own texel grid. */
const SUN_RIGHT = new THREE.Vector3(0, 1, 0).cross(SUN_DIR).normalize();
const SUN_UP = SUN_DIR.clone().cross(SUN_RIGHT).normalize();

/** How far up its own ray the shadow camera sits, and how deep a slab it
 * keeps around the ground plane. Far enough out and deep enough that the
 * highest crag still falls between near and far, tight enough that the
 * depth buffer is not spent on empty sky. */
const SUN_DISTANCE = 160;
const SHADOW_DEPTH = 90;

/**
 * How far past the framed ground the shadow box reaches.
 *
 * The sun stands about 59° up, so a caster throws its shadow some 0.6 of
 * its height to the side: a tree just off the left edge still darkens
 * ground the player can see, and a box cut exactly to the frame would drop
 * it — a shadow winking out at the screen edge, which is the one artifact
 * of this that would be read as a bug. Eight units clears the tallest
 * thing that casts.
 */
const SHADOW_PAD = 8;

/**
 * The step the box's half-extent is rounded up to.
 *
 * Zoom is a smooth gesture and the frame's half-extent follows it
 * continuously. Resizing the box every frame would rescale its texel grid
 * every frame, and the snapping below — which only holds the grid still
 * for a *fixed* box — could not answer for it. Rounding to a step means a
 * zoom resizes the box a handful of times instead of on every frame.
 */
const SHADOW_HALF_STEP = 4;

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
  /** The shadow map's edge in texels — what the snapping is quantised to. */
  #shadowMapSize: number;
  /** Half-extent of the box the whole world would need: the ceiling the
   * view-fitted box is clamped to, and the box itself for a caller
   * rendering through a camera of its own. */
  #worldHalf = 0;
  /** What the box is currently aimed at, to leave it alone when the frame
   * has not moved a whole texel. */
  #shadowHalf = 0;
  #shadowAt = new THREE.Vector3(NaN, NaN, NaN);
  #frame: ViewFrame = {cx: 0, cz: 0, rx: 0, rz: 0, ext: 0};
  #bounds: ViewBounds = {minX: 0, maxX: 0, minZ: 0, maxZ: 0};
  #centreScratch = new THREE.Vector3();

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
    this.#shadowMapSize = coarse ? 1024 : 2048;
    sun.shadow.mapSize.set(this.#shadowMapSize, this.#shadowMapSize);
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
    const mid = grid / 2;
    // The box that would hold the whole valley: the ceiling on the fitted
    // one, and what a caller drawing through its own camera gets.
    this.#worldHalf = play * 0.75;
    this.#aimSun(this.#centreScratch.set(mid, 0, mid), this.#worldHalf);
    this.rig.setPlayBounds(mid - play / 2, mid + play / 2);
  }

  /**
   * Point the sun's shadow box at a patch of ground.
   *
   * The light itself does not move — SUN_DIR is the whole of what shading
   * reads, and it is fixed. What moves is the box: an orthographic camera
   * standing off along that ray, covering `half` either side of `centre`.
   */
  #aimSun(centre: THREE.Vector3, half: number): void {
    const sun = this.#sun;
    sun.target.position.copy(centre);
    sun.position.copy(centre).addScaledVector(SUN_DIR, SUN_DISTANCE);
    const cam = sun.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = SUN_DISTANCE - SHADOW_DEPTH;
    cam.far = SUN_DISTANCE + SHADOW_DEPTH;
    cam.updateProjectionMatrix();
    this.#shadowHalf = half;
    this.#shadowAt.copy(centre);
  }

  /**
   * Cut the shadow box down to the ground the camera is actually framing.
   *
   * It used to hold the whole valley — a 144-unit box over a 96-unit
   * playfield — which meant every caster on the map was drawn into the
   * shadow map on every frame, wherever the player was looking, and the
   * map's texels were spread so thin over it that the shadows were soft by
   * accident. A frame shows about 53 units of ground. Fitting the box to
   * that is the same two-thirds saving on the shadow pass that chunking
   * bought the main one (ScatterMesh: off-screen instances only cull if
   * some camera rejects them, and the shadow camera is a camera), and it
   * hands the same 1024 or 2048 texels to a quarter of the ground, which
   * is a crisper shadow rather than a cheaper-looking one.
   *
   * The catch is that a box which follows the camera drags its texel grid
   * along under the geometry, and shadow edges crawl and shimmer as it
   * goes. So the box is only ever placed on whole texels of its own grid:
   * it steps rather than slides, and the edges hold still.
   */
  #fitShadowToView(): void {
    // Both of these are centred on the camera's target, so they differ
    // only in extent, and the box takes whichever reaches further.
    // viewFrame's is the one that holds still as the camera turns — a box
    // that resized on every degree of yaw would rebuild its texel grid
    // just as often — but it is a rotation-invariant average rather than a
    // cover, and a tall enough viewport (a phone held upright) frames
    // ground past it. viewBounds is the honest cover, and only sets the
    // size on the shapes where it has to.
    const frame = this.rig.viewFrame(0, this.#frame);
    const bounds = this.rig.viewBounds(0, this.#bounds);
    const reach = Math.max(
      frame.ext,
      (bounds.maxX - bounds.minX) / 2,
      (bounds.maxZ - bounds.minZ) / 2,
    );
    const half = Math.min(
      this.#worldHalf,
      Math.ceil((reach + SHADOW_PAD) / SHADOW_HALF_STEP) * SHADOW_HALF_STEP,
    );
    // Snap the centre to the box's own texel grid: project it onto the
    // shadow camera's two lateral axes and round each to a whole texel.
    const texel = (2 * half) / this.#shadowMapSize;
    const cx = frame.cx;
    const cz = frame.cz;
    const u = Math.round((cx * SUN_RIGHT.x + cz * SUN_RIGHT.z) / texel) * texel;
    const v = Math.round((cx * SUN_UP.x + cz * SUN_UP.z) / texel) * texel;
    // The third axis is depth along the sun's own ray, and sliding the box
    // down it shows nothing — so rather than carry the frame's continuous
    // position into it, solve it for the ground plane from the snapped
    // pair. That makes the centre a pure function of two quantised
    // numbers, which is the whole of what lets the early return below ever
    // fire: carrying the raw depth moved the centre on every frame of a
    // pan, so the box was re-aimed and its projection rebuilt every frame
    // while its texel grid stood perfectly still. (SUN_RIGHT lies flat by
    // construction — a cross product with Y has no Y of its own — so only
    // SUN_UP's rise has to be cancelled.)
    const w = -(SUN_UP.y * v) / SUN_DIR.y;
    const centre = this.#centreScratch
      .set(0, 0, 0)
      .addScaledVector(SUN_RIGHT, u)
      .addScaledVector(SUN_UP, v)
      .addScaledVector(SUN_DIR, w);
    // A frame that has not moved a whole texel leaves the box — and its
    // projection matrix — exactly as they were.
    if (half === this.#shadowHalf && centre.equals(this.#shadowAt)) return;
    this.#aimSun(centre, half);
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
    // A caller looking through a lens of its own (the start screen's
    // backdrop) is not framing the rig's ground, so it keeps the box that
    // holds the whole world.
    if (camera === undefined) this.#fitShadowToView();
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
