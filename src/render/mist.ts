import * as THREE from 'three';
import {tileCount, tileX, tileY} from '../shared/grid';
import {hash2} from '../shared/math';
import {WATER_LEVEL, type MapView} from '../sim/map';
import * as Terrain from '../sim/terrainEnum.ts';
import type {FogQuery} from './fogOfWar';

/** One wisp per 256 tiles — the classic 16 on a 64 map, denser seas get
 * proportionally more so the mist never thins out with the map. */
function mistCount(size: number): number {
  return Math.round(tileCount(size) / 256);
}

interface Wisp {
  sprite: THREE.Sprite;
  originX: number;
  originZ: number;
  driftX: number;
  driftZ: number;
  phase: number;
  scale: number;
}

/** Soft radial blob drawn once on a canvas — no texture assets. */
function makeMistTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(
    size / 2,
    size / 2,
    8,
    size / 2,
    size / 2,
    size / 2,
  );
  grad.addColorStop(0, 'rgba(200, 225, 215, 0.55)');
  grad.addColorStop(0.5, 'rgba(190, 215, 210, 0.22)');
  grad.addColorStop(1, 'rgba(180, 205, 200, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Drifting mist over the water: a handful of big soft sprites that slowly
 * wander and breathe in opacity. Pure atmosphere, zero sim knowledge.
 */
export class Mist {
  readonly group = new THREE.Group();
  #wisps: Wisp[] = [];
  /** Never set = everything lit; the menu backdrop has no fog to give. */
  #fog: FogQuery | null = null;

  /** Dim each wisp by the fog at its position. Sprites cannot take the
   * fog's material patch (see fogOfWar.ts #patch), so the mist gates
   * itself — without this the wisps glowed over unexplored sea. */
  setFog(fog: FogQuery): void {
    this.#fog = fog;
  }

  constructor(map: MapView) {
    const size = map.size;
    // Candidate anchors: water tiles, thinned deterministically.
    const anchors: number[] = [];
    for (let i = 0; i < tileCount(size); i++) {
      if (map.terrain[i] === Terrain.Water && hash2(i, 77) < 0.12)
        anchors.push(i);
    }
    if (anchors.length === 0) return;

    const texture = makeMistTexture();
    for (let k = 0; k < mistCount(size); k++) {
      const anchor = anchors[Math.floor(hash2(k, 3) * anchors.length)]!;
      const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        fog: true,
      });
      const sprite = new THREE.Sprite(material);
      const scale = 7 + hash2(k, 5) * 8;
      sprite.scale.set(scale, scale * 0.45, 1);
      this.group.add(sprite);
      this.#wisps.push({
        sprite,
        originX: tileX(anchor, size) + 0.5,
        originZ: tileY(anchor, size) + 0.5,
        driftX: (hash2(k, 11) - 0.5) * 0.35,
        driftZ: (hash2(k, 13) - 0.5) * 0.25,
        phase: hash2(k, 17) * Math.PI * 2,
        scale,
      });
    }
  }

  update(nowMs: number): void {
    const t = nowMs / 1000;
    for (const w of this.#wisps) {
      // Slow figure-eight wander around the anchor plus a breathing cycle.
      const cycle = t * 0.05 + w.phase;
      const x = w.originX + Math.sin(cycle) * 6 + w.driftX * (t % 120);
      const z = w.originZ + Math.sin(cycle * 2) * 2.2 + w.driftZ * (t % 120);
      w.sprite.position.set(x, WATER_LEVEL + 0.9, z);
      const lit = this.#fog ? this.#fog.litAt(x, z) : 1;
      w.sprite.visible = lit > 0.02;
      const breathe = 0.5 + 0.5 * Math.sin(t * 0.13 + w.phase * 3);
      (w.sprite.material as THREE.SpriteMaterial).opacity =
        (0.08 + breathe * 0.14) * lit;
    }
  }
}
