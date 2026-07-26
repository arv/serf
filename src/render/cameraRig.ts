import * as THREE from 'three';
import { MAP_SIZE } from '../shared/grid';
import { clamp } from '../shared/math';

const YAW = Math.PI / 4; // fixed 45° — models only need to read from one angle
const PITCH = (35 * Math.PI) / 180;
const DISTANCE = 90;
const MIN_VIEW = 5;
const MAX_VIEW = 52;
const PAN_MARGIN = 4;

/**
 * Classic isometric-style orthographic rig: fixed yaw/pitch, panning moves a
 * ground-plane target, zoom scales the frustum height.
 */
export class CameraRig {
  readonly camera: THREE.OrthographicCamera;
  #canvas: HTMLCanvasElement;
  #target = new THREE.Vector3(MAP_SIZE / 2, 0, MAP_SIZE / 2);
  #viewHeight = 30;
  #keys = new Set<string>();
  #dragging = false;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 400);
    // ?zoom=6 boots close-in — handy for inspecting people and props.
    const zoom = Number(new URLSearchParams(location.search).get('zoom'));
    if (Number.isFinite(zoom) && zoom > 0) {
      this.#viewHeight = clamp(zoom, MIN_VIEW, MAX_VIEW);
    }
    this.resize();
    this.#apply();

    window.addEventListener('keydown', (e) => {
      if (!e.repeat) this.#keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.#keys.delete(e.code));
    window.addEventListener('blur', () => this.#keys.clear());

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
      { passive: false },
    );

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.#dragging = true;
        canvas.setPointerCapture(e.pointerId);
      }
    });
    canvas.addEventListener('pointerup', (e) => {
      if (e.button === 1) this.#dragging = false;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.#dragging) return;
      const worldPerPixel = this.#viewHeight / this.#canvas.clientHeight;
      this.#panScreen(-e.movementX * worldPerPixel, -e.movementY * worldPerPixel);
    });

    window.addEventListener('resize', () => this.resize());
  }

  /** Per-frame: apply held pan keys. dt in seconds. */
  tick(dt: number): void {
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
    // Screen right in world space (yaw only), screen "up" projected on ground.
    const rx = Math.cos(YAW);
    const rz = -Math.sin(YAW);
    const fx = -Math.sin(YAW);
    const fz = -Math.cos(YAW);
    this.#target.x = clamp(this.#target.x + rx * x - fx * z, -PAN_MARGIN, MAP_SIZE + PAN_MARGIN);
    this.#target.z = clamp(this.#target.z + rz * x - fz * z, -PAN_MARGIN, MAP_SIZE + PAN_MARGIN);
    this.#apply();
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
