import * as THREE from 'three';
import {worldToScreen} from '../input/picking';
import type {HeightField} from '../render/heightField';
import {pushToast} from '../ui/store';

/** Strikes within this many tiles of an existing hotspot merge into it —
 * one raid reads as one alert, not a toast per swing. */
const CLUSTER_RADIUS_SQ = 8 * 8;
/** A hotspot lives this long past its last strike... */
const TTL_MS = 5000;
/** ...and spends the final stretch fading out. */
const FADE_MS = 1500;
/** An ongoing hotspot may toast again, but only this often. */
const RETOAST_MS = 25000;
/** Cap concurrent hotspots; the stalest one yields when a fresh fight opens. */
const MAX_HOTSPOTS = 8;
/** On-screen test: inside the canvas rect inset by this many pixels. */
const SCREEN_INSET = 24;
/** Haze blobs hug the screen edge this far in from it. */
const EDGE_PAD = 10;
const BLOB_SIZE = 360;

interface Hotspot {
  x: number;
  y: number;
  building: boolean;
  lastHitAt: number;
  toastAt: number;
}

/**
 * Turns the sim's per-strike damage events into player-facing alerts:
 * strikes cluster into short-lived hotspots, each drawn as a red haze at
 * the screen edge toward the fight when it's off-screen, an expanding
 * ground ring at the victim when it's on-screen, and announced by a
 * clickable toast that pans the camera there. All state is transient
 * client-side memory — the deterministic sim only ever emits events.
 */
export class DamageAlerts {
  #scene: THREE.Scene;
  #heights: HeightField;
  #camera: THREE.Camera;
  #canvas: HTMLCanvasElement;
  #hotspots: Hotspot[] = [];

  // Edge-haze DOM: a fixed full-screen layer above the canvas and grade
  // divs, below #ui (by DOM order — all fixed siblings), holding pooled
  // gradient blobs clamped to the screen edge.
  #hazeLayer: HTMLDivElement;
  #blobs: HTMLDivElement[] = [];

  // On-screen pulse rings, pooled like SelectionFx. Each mesh owns its
  // material: rings fade with their hotspot, so opacity is per-ring.
  #rings: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];
  #ringGeometry = new THREE.RingGeometry(0.5, 0.62, 32);

  // Scratch for the per-hotspot projection — no per-frame allocation.
  #screen = {x: 0, y: 0};

  constructor(opts: {
    scene: THREE.Scene;
    heights: HeightField;
    camera: THREE.Camera;
    canvas: HTMLCanvasElement;
  }) {
    this.#scene = opts.scene;
    this.#heights = opts.heights;
    this.#camera = opts.camera;
    this.#canvas = opts.canvas;
    this.#ringGeometry.rotateX(-Math.PI / 2);
    this.#hazeLayer = document.createElement('div');
    this.#hazeLayer.id = 'damage-haze';
    this.#hazeLayer.style.cssText =
      'position: fixed; inset: 0; pointer-events: none;';
    const ui = document.getElementById('ui');
    document.body.insertBefore(this.#hazeLayer, ui);
  }

  /** Feed one sim damage event, already filtered to the local player. */
  report(e: {x: number; y: number; building: boolean}): void {
    const now = performance.now();
    let nearest: Hotspot | undefined;
    let nearestSq = CLUSTER_RADIUS_SQ;
    for (const h of this.#hotspots) {
      const dx = h.x - e.x;
      const dy = h.y - e.y;
      const sq = dx * dx + dy * dy;
      if (sq <= nearestSq) {
        nearestSq = sq;
        nearest = h;
      }
    }
    if (nearest) {
      // Follow the fight: the marker tracks the newest strike.
      nearest.x = e.x;
      nearest.y = e.y;
      nearest.building ||= e.building;
      nearest.lastHitAt = now;
      if (now - nearest.toastAt > RETOAST_MS) {
        nearest.toastAt = now;
        this.#toast(nearest);
      }
      return;
    }
    const spot: Hotspot = {
      x: e.x,
      y: e.y,
      building: e.building,
      lastHitAt: now,
      toastAt: now,
    };
    if (this.#hotspots.length >= MAX_HOTSPOTS) {
      let stalest = 0;
      for (let i = 1; i < this.#hotspots.length; i++) {
        if (this.#hotspots[i]!.lastHitAt < this.#hotspots[stalest]!.lastHitAt)
          stalest = i;
      }
      this.#hotspots.splice(stalest, 1);
    }
    this.#hotspots.push(spot);
    this.#toast(spot);
  }

  #toast(h: Hotspot): void {
    pushToast(
      h.building
        ? 'Your village is under attack!'
        : 'Your serfs are under attack!',
      {
        x: h.x,
        y: h.y,
      },
    );
  }

  /** Once per render frame. */
  update(now: number): void {
    let blobsUsed = 0;
    let ringsUsed = 0;
    const w = this.#canvas.clientWidth;
    const hgt = this.#canvas.clientHeight;
    for (let i = this.#hotspots.length - 1; i >= 0; i--) {
      const h = this.#hotspots[i]!;
      const age = now - h.lastHitAt;
      if (age > TTL_MS) {
        this.#hotspots.splice(i, 1);
        continue;
      }
      const alpha = Math.min(1, (TTL_MS - age) / FADE_MS);
      const ground = this.#heights.at(h.x, h.y);
      const p = worldToScreen(
        this.#camera,
        this.#canvas,
        h.x,
        ground,
        h.y,
        this.#screen,
      );
      const onScreen =
        p.x >= SCREEN_INSET &&
        p.x <= w - SCREEN_INSET &&
        p.y >= SCREEN_INSET &&
        p.y <= hgt - SCREEN_INSET;
      if (onScreen) this.#ring(ringsUsed++, h, ground, now, alpha);
      else this.#blob(blobsUsed++, p, w, hgt, now, alpha);
    }
    for (let i = blobsUsed; i < this.#blobs.length; i++)
      this.#blobs[i]!.style.display = 'none';
    for (let i = ringsUsed; i < this.#rings.length; i++)
      this.#rings[i]!.visible = false;
  }

  /** An expanding red ring on the ground at the fight. */
  #ring(
    index: number,
    h: Hotspot,
    ground: number,
    now: number,
    alpha: number,
  ): void {
    let ring = this.#rings[index];
    if (!ring) {
      ring = new THREE.Mesh(
        this.#ringGeometry,
        new THREE.MeshBasicMaterial({
          color: 0xc0392b,
          side: THREE.DoubleSide,
          transparent: true,
          depthWrite: false,
        }),
      );
      this.#rings.push(ring);
      this.#scene.add(ring);
    }
    const phase = (now % 900) / 900;
    ring.visible = true;
    ring.position.set(h.x, ground + 0.06, h.y);
    ring.scale.setScalar(1 + 2.2 * phase);
    ring.material.opacity = 0.8 * (1 - phase) * alpha;
  }

  /** A red haze blob clamped to the screen edge, toward the fight. */
  #blob(
    index: number,
    p: {x: number; y: number},
    w: number,
    hgt: number,
    now: number,
    alpha: number,
  ): void {
    let blob = this.#blobs[index];
    if (!blob) {
      blob = document.createElement('div');
      blob.style.cssText =
        `position: absolute; width: ${BLOB_SIZE}px; height: ${BLOB_SIZE}px; ` +
        'background: radial-gradient(closest-side, rgba(205, 45, 30, 0.55), ' +
        'rgba(205, 45, 30, 0.18) 55%, transparent 72%); will-change: transform, opacity;';
      this.#blobs.push(blob);
      this.#hazeLayer.appendChild(blob);
    }
    // Walk from the screen center toward the projection until an edge
    // (inset by EDGE_PAD) stops us — that's where the haze sits. The ortho
    // camera keeps far off-screen projections proportional, so the
    // direction is exact.
    const cx = w / 2;
    const cy = hgt / 2;
    const dx = p.x - cx;
    const dy = p.y - cy;
    let t = 1;
    if (Math.abs(dx) > 1e-3) t = Math.min(t, (cx - EDGE_PAD) / Math.abs(dx));
    if (Math.abs(dy) > 1e-3) t = Math.min(t, (cy - EDGE_PAD) / Math.abs(dy));
    const bx = cx + dx * t - BLOB_SIZE / 2;
    const by = cy + dy * t - BLOB_SIZE / 2;
    blob.style.display = 'block';
    blob.style.transform = `translate3d(${bx}px, ${by}px, 0)`;
    // A slow throb so the haze reads as "happening now", not a stain.
    blob.style.opacity = String(alpha * (0.7 + 0.3 * Math.sin(now / 140)));
  }

  /** Nothing left to defend — the match is over, or the local seat has
   * fallen and spectates: drop everything, hide every pooled visual. */
  clear(): void {
    this.#hotspots.length = 0;
    for (const blob of this.#blobs) blob.style.display = 'none';
    for (const ring of this.#rings) ring.visible = false;
  }

  /**
   * Match gone: take the haze layer off the page with it. The rings live in
   * the scene and go when its context does, but this layer is a child of
   * document.body — outside the canvas, outside #ui, outside anything the
   * next screen replaces — so without this every match would leave one
   * behind, each still holding its pooled blobs.
   */
  dispose(): void {
    this.clear();
    this.#hazeLayer.remove();
  }
}
