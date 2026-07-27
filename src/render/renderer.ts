import * as THREE from 'three';
import { MAP_SIZE } from '../shared/grid';
import { palette } from './palette';
import { THEME } from './medieval';
import { CameraRig } from './cameraRig';

/** Medieval renders as bright stylized daylight; japan keeps the BR gloom. */
const DAY = THEME === 'medieval';

/**
 * Owns the WebGL context, scene, lights, and camera rig. Content (terrain,
 * scatter, entity visuals) is added to `scene` by the composition root.
 */
export class GameRenderer {
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  #webgl: THREE.WebGLRenderer;
  #lastTime = performance.now();

  constructor(canvas: HTMLCanvasElement) {
    this.#webgl = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.#webgl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Construction sites reveal their model with a clip plane.
    this.#webgl.localClippingEnabled = true;
    this.#webgl.shadowMap.enabled = true;
    this.#webgl.shadowMap.type = THREE.PCFSoftShadowMap;
    // ACES filmic gives the saturated, contrasty "game" grade the flat
    // Lambert colors lack on their own.
    this.#webgl.toneMapping = THREE.ACESFilmicToneMapping;
    this.#webgl.toneMappingExposure = DAY ? 1.32 : 1.18;

    this.scene.background = new THREE.Color(palette.background);
    // Daylight: distant pale haze. Japan: deep green Battle Realms gloom.
    this.scene.fog = DAY
      ? new THREE.Fog(palette.fog, 125, 270)
      : new THREE.Fog(palette.fog, 95, 190);
    this.rig = new CameraRig(canvas);

    const hemi = new THREE.HemisphereLight(palette.skyLight, palette.groundBounce, DAY ? 1.05 : 0.7);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(DAY ? 0xfff1cf : 0xffdfae, DAY ? 2.7 : 2.4);
    sun.position.set(MAP_SIZE / 2 - 28, 55, MAP_SIZE / 2 + 18);
    sun.target.position.set(MAP_SIZE / 2, 0, MAP_SIZE / 2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
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
    new ResizeObserver(resize).observe(canvas);
    window.addEventListener('resize', resize);
    resize();
  }

  /** Render one frame; returns dt (seconds) for anyone who needs it. */
  frame(): number {
    const now = performance.now();
    const dt = Math.min((now - this.#lastTime) / 1000, 0.25);
    this.#lastTime = now;
    this.rig.tick(dt);
    this.#webgl.render(this.scene, this.rig.camera);
    return dt;
  }
}
