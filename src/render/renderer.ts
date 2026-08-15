import * as THREE from 'three';
import { MAP_SIZE } from '../shared/grid';
import { palette } from './palette';
import { CameraRig } from './cameraRig';

/**
 * Owns the WebGL context, scene, lights, and camera rig. Content (terrain,
 * scatter, entity visuals) is added to `scene` by the composition root.
 */
export class GameRenderer {
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  #webgl: THREE.WebGLRenderer;
  #lastTime = performance.now();
  #observer: ResizeObserver;
  #onWindowResize: () => void;

  constructor(canvas: HTMLCanvasElement, interactive = true) {
    // Phones and tablets render the same scene on a far smaller GPU: trade
    // resolution and shadow crispness for framerate. Desktop is unchanged.
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    this.#webgl = new THREE.WebGLRenderer({ canvas, antialias: !coarse });
    this.#webgl.setPixelRatio(Math.min(window.devicePixelRatio, coarse ? 1.5 : 2));
    // Construction sites reveal their model with a clip plane.
    this.#webgl.localClippingEnabled = true;
    this.#webgl.shadowMap.enabled = true;
    this.#webgl.shadowMap.type = THREE.PCFSoftShadowMap;
    // ACES filmic gives the saturated, contrasty "game" grade the flat
    // Lambert colors lack on their own.
    this.#webgl.toneMapping = THREE.ACESFilmicToneMapping;
    this.#webgl.toneMappingExposure = 1.32;

    this.scene.background = new THREE.Color(palette.background);
    // Bright stylized daylight: distant pale haze.
    this.scene.fog = new THREE.Fog(palette.fog, 125, 270);
    this.rig = new CameraRig(canvas, interactive);

    const hemi = new THREE.HemisphereLight(palette.skyLight, palette.groundBounce, 1.05);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff1cf, 2.7);
    sun.position.set(MAP_SIZE / 2 - 28, 55, MAP_SIZE / 2 + 18);
    sun.target.position.set(MAP_SIZE / 2, 0, MAP_SIZE / 2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(coarse ? 1024 : 2048, coarse ? 1024 : 2048);
    const half = MAP_SIZE * 0.75;
    sun.shadow.camera.left = -half;
    sun.shadow.camera.right = half;
    sun.shadow.camera.top = half;
    sun.shadow.camera.bottom = -half;
    sun.shadow.camera.near = 5;
    sun.shadow.camera.far = 160;
    sun.shadow.bias = -0.0004;
    this.scene.add(sun, sun.target);

    // ResizeObserver over a window listener: it fires whenever the canvas
    // box actually changes — including viewport changes that never dispatch
    // a window resize event (devtools panes, embedded previews).
    const resize = (): void => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w > 0 && h > 0) {
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
  dispose(): void {
    this.#observer.disconnect();
    window.removeEventListener('resize', this.#onWindowResize);
    this.rig.dispose();
    this.#webgl.dispose();
    this.#webgl.forceContextLoss();
  }

  /**
   * Render one frame; returns dt (seconds) for anyone who needs it.
   *
   * `camera` overrides the rig — the start screen's backdrop looks at the
   * same scene through a perspective lens from ground level, which the
   * orthographic rig cannot express.
   */
  frame(camera?: THREE.Camera): number {
    const now = performance.now();
    const dt = Math.min((now - this.#lastTime) / 1000, 0.25);
    this.#lastTime = now;
    this.rig.tick(dt);
    this.#webgl.render(this.scene, camera ?? this.rig.camera);
    return dt;
  }
}
