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

  constructor(canvas: HTMLCanvasElement) {
    this.#webgl = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.#webgl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.#webgl.shadowMap.enabled = true;
    this.#webgl.shadowMap.type = THREE.PCFSoftShadowMap;
    // ACES filmic gives the saturated, contrasty "game" grade the flat
    // Lambert colors lack on their own.
    this.#webgl.toneMapping = THREE.ACESFilmicToneMapping;
    this.#webgl.toneMappingExposure = 1.18;

    this.scene.background = new THREE.Color(palette.background);
    // Deep green haze pulls the map edges into darkness, Battle Realms style.
    this.scene.fog = new THREE.Fog(palette.fog, 95, 190);
    this.rig = new CameraRig(canvas);

    const hemi = new THREE.HemisphereLight(palette.skyLight, palette.groundBounce, 0.7);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xffdfae, 2.4);
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

    const resize = (): void => {
      this.#webgl.setSize(canvas.clientWidth, canvas.clientHeight, false);
      this.rig.resize();
    };
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
