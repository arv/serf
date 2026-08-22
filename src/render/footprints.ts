import * as THREE from 'three';
import { hash2 } from '../shared/math';
import { tileIdx, tileX, tileY } from '../shared/grid';
import { ACTION, AUX_STRIDE, type SabReader } from '../protocol/sabLayout';
import type { MapView } from '../sim/map';
import type { Sole } from './characters';
import { ribbonCover, type RibbonCover } from './pathRibbon';
import { FOOTPRINT_TEX_FILL, makeFootprintSprite } from './spriteTextures';
import type { FogQuery } from './fogOfWar';
import type { HeightField } from './heightField';

/** How long a print stays on the ground, in (unpaused) real seconds. */
export const PRINT_LIFE_S = 30;
/** A fresh print's strength: pressed into the turf, not stamped in ink —
 * the ground shows through from the first frame. */
const PRINT_ALPHA = 0.55;
/** Tiles of march between successive prints — one footfall per stride. */
export const STRIDE = 0.45;
/**
 * Backfill cap when a unit covers many strides in one publish (fast game
 * speeds). Past this the trail goes sparse instead of the pass going long.
 */
export const MAX_PRINTS_PER_STEP = 6;
/** Feet straddle the line of march by this much, in tiles — the fallback
 * when no character sole is to hand; with one, its own offset is used. */
const FOOT_OFFSET = 0.055;
/** Fallback print quad size, in tiles; with a sole the quad is sized from
 * the boot itself. */
const PRINT_W = 0.09;
const PRINT_L = 0.17;
/** Above the terrain skin, below everything that stands on it. */
const LIFT = 0.025;
/** Birth date that kills a print: ancient, so the GPU fade holds it at
 * alpha zero until the ring reuses the slot. */
const FAR_PAST = -1e9;
/**
 * Print slots, reused oldest-first. A busy late-game valley can outrun
 * this — a hundred walkers stamp ~360 prints a second — and then the
 * oldest prints simply fade early, which is the graceful way to be over
 * budget. Most economy traffic converges onto trails, which take no
 * prints, so in practice the ring runs far under this.
 */
const CAPACITY = 16384;

/**
 * Is this world point on the drawn trail/road band? The terrain tints
 * toward dirt for any coverage at all, so the print threshold sits at the
 * ribbon's outermost painted fringe — a print on a "shoulder" the eye
 * already reads as trail looks like a print on the trail.
 */
function onRibbon(map: MapView, x: number, z: number): boolean {
  ribbonCover(map.pathLevel, x, z, cover);
  return cover.trail > 0.05 || cover.road > 0.02;
}

/** One print to place: on the march line at (x, y), heading `yaw`, foot `side`. */
export type StampFn = (x: number, y: number, yaw: number, side: number) => void;

interface Tracker {
  /** Where the last print fell (or where the unit was first seen). */
  x: number;
  y: number;
  /** Which foot lands next: +1 right of the march line, -1 left. */
  side: number;
  /** Publish epoch this unit was last fed — sweep drops the rest. */
  epoch: number;
}

/**
 * The stride bookkeeping behind the prints, kept apart from the THREE layer
 * so it can be tested headless: per unit, how far since the last footfall,
 * and which foot lands next. Feed every walking unit each publish — `advance`
 * to march (emitting a print per stride crossed), `shadow` to move without
 * marking (fog-hidden enemies) — then `sweep` to forget the units gone.
 */
export class FootprintPlanner {
  #trackers = new Map<number, Tracker>();
  #epoch = 0;

  /** Start a publish pass; `advance`/`shadow` calls mark units as present. */
  begin(): void {
    this.#epoch++;
  }

  /** March a unit to (x, y), stamping a print per stride crossed. */
  advance(id: number, x: number, y: number, stamp: StampFn): void {
    const t = this.#trackers.get(id);
    if (!t) {
      // First sighting is a position, not a footfall — no print at spawn.
      this.#trackers.set(id, { x, y, side: (id & 1) === 0 ? 1 : -1, epoch: this.#epoch });
      return;
    }
    t.epoch = this.#epoch;
    const dx = x - t.x;
    const dy = y - t.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < STRIDE) return;
    const yaw = Math.atan2(dx, dy);
    const sx = (dx / dist) * STRIDE;
    const sy = (dy / dist) * STRIDE;
    let steps = Math.floor(dist / STRIDE);
    if (steps > MAX_PRINTS_PER_STEP) {
      // A long hop: drop the middle rather than carpet it.
      steps = MAX_PRINTS_PER_STEP;
      t.x = x - sx * steps;
      t.y = y - sy * steps;
    }
    for (let k = 0; k < steps; k++) {
      t.x += sx;
      t.y += sy;
      t.side = -t.side;
      stamp(t.x, t.y, yaw, t.side);
    }
  }

  /** Move a unit without marking, so re-emerging strides start from here. */
  shadow(id: number, x: number, y: number): void {
    const t = this.#trackers.get(id);
    if (t) {
      t.x = x;
      t.y = y;
      t.epoch = this.#epoch;
    } else {
      this.#trackers.set(id, { x, y, side: (id & 1) === 0 ? 1 : -1, epoch: this.#epoch });
    }
  }

  /** Forget every unit the pass since `begin` did not feed. */
  sweep(): void {
    for (const [id, t] of this.#trackers) {
      if (t.epoch !== this.#epoch) this.#trackers.delete(id);
    }
  }
}

const dummy = new THREE.Object3D();
const cover: RibbonCover = { trail: 0, road: 0 };

/**
 * Bootprints where people walk, fading out over half a minute — the ground
 * remembers everyone's passing, and where an army marches the width and
 * density of the print trail says how big it was. Purely render-side:
 * prints are stamped from the same SAB publishes the unit sync draws from,
 * no sim contact.
 *
 * The prints live in one instanced mesh. A stamp writes a slot's matrix and
 * birth time once; the fade happens on the GPU (a birth-time attribute
 * against a clock uniform), so a stamped print never costs CPU again. Slots
 * are a ring, reused oldest-first. Prints skip the trail and road ribbons —
 * packed dirt takes no new mark, the trail itself is the record of that
 * traffic — and when fresh wear turns grass into trail, the prints already
 * stamped there are culled with it (clearUnderPaths). Fog-hidden enemies
 * leave none, so the layer can't be used to scout the dark.
 */
export class Footprints {
  readonly mesh: THREE.InstancedMesh;
  #reader: SabReader;
  #map: MapView;
  #heights: HeightField;
  /** Seat viewing the scene — other owners' prints obey the fog. */
  #owner: number;
  #fog: FogQuery | null = null;
  #planner = new FootprintPlanner();
  #birth: THREE.InstancedBufferAttribute;
  /** Where each slot's print lies, for the cull under freshly worn paths. */
  #printX = new Float32Array(CAPACITY);
  #printZ = new Float32Array(CAPACITY);
  #uNow = { value: 0 };
  /** Next slot in the ring. */
  #cursor = 0;
  /** High-water mark of touched slots — what the mesh draws. */
  #high = 0;
  #lastSeq = -1;
  #lastMs = 0;
  /** Print clock, in seconds: holds while the game is paused, like the
   * animation clock, so a pause doesn't wash the ground clean. */
  #now = 0;
  #stamped = false;
  /** Sideways offset of each footfall from the march line. */
  #footOffset: number;

  constructor(
    reader: SabReader,
    map: MapView,
    heights: HeightField,
    owner: number,
    sole: Sole | null = null,
  ) {
    this.#reader = reader;
    this.#map = map;
    this.#heights = heights;
    this.#owner = owner;
    this.#footOffset = sole?.offset ?? FOOT_OFFSET;

    // The quad carries the boot at its true size: the sole fills
    // FOOTPRINT_TEX_FILL of the texture, the rest is soft-edge margin.
    const printW = sole ? sole.width / FOOTPRINT_TEX_FILL : PRINT_W;
    const printL = sole ? sole.length / FOOTPRINT_TEX_FILL : PRINT_L;
    const geometry = new THREE.PlaneGeometry(printW, printL);
    geometry.rotateX(-Math.PI / 2); // flat on the ground, length along the march
    this.#birth = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
    this.#birth.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aBirth', this.#birth);

    const material = new THREE.MeshLambertMaterial({
      map: makeFootprintSprite(),
      transparent: true,
      // A skin on the ground, like the road decal: depth-tested against the
      // world but never written, nudged off the terrain to kill z-fighting.
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    // Per-instance fade, computed on the GPU from the print's birth time so
    // a print costs nothing after its stamp. The fog patch wraps whatever
    // onBeforeCompile it finds, so this composes with it.
    //
    // The explicit cache key is load-bearing. Three keys compiled programs
    // on onBeforeCompile.toString() — but the fog wraps every material's
    // hook with the same wrapper text, so once patched, this material would
    // share a key with any other fog-patched Lambert of the same shape and
    // could be handed that material's program, compiled without the fade
    // splice below. The prints then simply never faded.
    material.customProgramCacheKey = () => 'footprints-fade';
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uNow = this.#uNow;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute float aBirth;\nuniform float uNow;\nvarying float vFade;',
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `#include <begin_vertex>
          {
            // Full strength for the first third of the print's life, then
            // a straight fade to nothing over the rest — all under the base
            // press-in strength.
            float age = (uNow - aBirth) / ${PRINT_LIFE_S.toFixed(1)};
            vFade = ${PRINT_ALPHA.toFixed(2)} * clamp(1.5 - age * 1.5, 0.0, 1.0);
          }`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vFade;')
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= vFade;');
    };

    this.mesh = new THREE.InstancedMesh(geometry, material, CAPACITY);
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // The bounding sphere describes the geometry at the origin, not where
    // the instances are; prints span the whole map anyway.
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
  }

  /** Fog test; a hidden enemy's march leaves no marks to scout by. */
  setFog(fog: FogQuery): void {
    this.#fog = fog;
  }

  /**
   * Advance the fade clock and stamp the latest publish's marches. Call once
   * per rendered frame, after the unit sync has polled the reader.
   */
  update(nowMs: number, paused: boolean): void {
    const dt = this.#lastMs > 0 ? Math.min((nowMs - this.#lastMs) / 1000, 0.1) : 0;
    this.#lastMs = nowMs;
    if (!paused) this.#now += dt;
    this.#uNow.value = this.#now;

    const latest = this.#reader.latest;
    if (latest.publishSeq === this.#lastSeq) return;
    this.#lastSeq = latest.publishSeq;

    this.#stamped = false;
    this.#planner.begin();
    for (let i = 0; i < latest.count; i++) {
      const a = i * AUX_STRIDE;
      if (latest.aux[a + 4] === ACTION.dead) continue; // corpses don't walk
      const id = latest.ids[i]!;
      const x = latest.xs[i]!;
      const y = latest.ys[i]!;
      if (latest.aux[a + 1] !== this.#owner && this.#fog && !this.#fog.visibleAt(x, y)) {
        this.#planner.shadow(id, x, y);
        continue;
      }
      this.#planner.advance(id, x, y, this.#stamp);
    }
    this.#planner.sweep();
    if (this.#stamped) {
      this.mesh.count = this.#high;
      this.mesh.instanceMatrix.needsUpdate = true;
      this.#birth.needsUpdate = true;
    }
  }

  /**
   * Cull the prints a newly worn path now runs under. Feet stamp on grass
   * and the grass turns to trail moments later — a marching column wears
   * its own lane in — and without this the old prints would sit on the
   * fresh dirt for the rest of their fade. Same 3x3 sweep as the grass
   * clumps: a changed tile's ribbon reaches only its immediate neighbors.
   */
  clearUnderPaths(tiles: readonly number[]): void {
    if (tiles.length === 0 || this.#high === 0) return;
    const size = this.#map.size;
    const swept = new Set<number>();
    for (const t of tiles) {
      const tx = tileX(t, size);
      const ty = tileY(t, size);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = tx + dx;
          const ny = ty + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          swept.add(tileIdx(nx, ny, size));
        }
      }
    }
    let culled = false;
    for (let slot = 0; slot < this.#high; slot++) {
      const born = this.#birth.getX(slot);
      if (this.#uNow.value - born >= PRINT_LIFE_S) continue; // already invisible
      const x = this.#printX[slot]!;
      const z = this.#printZ[slot]!;
      if (!swept.has(tileIdx(Math.floor(x), Math.floor(z), size))) continue;
      if (!onRibbon(this.#map, x, z)) continue;
      this.#birth.setX(slot, FAR_PAST);
      this.#birth.addUpdateRange(slot, 1);
      culled = true;
    }
    if (culled) this.#birth.needsUpdate = true;
  }

  #stamp: StampFn = (x, y, yaw, side) => {
    // No prints on the trail: the ribbon's dirt is already the record of
    // feet, and packed ground takes no new mark.
    if (onRibbon(this.#map, x, y)) return;

    const slot = this.#cursor;
    this.#cursor = (this.#cursor + 1) % CAPACITY;
    if (slot >= this.#high) this.#high = slot + 1;

    // Left and right feet straddle the march line.
    const px = x + Math.cos(yaw) * this.#footOffset * side;
    const pz = y - Math.sin(yaw) * this.#footOffset * side;
    this.#printX[slot] = px;
    this.#printZ[slot] = pz;
    dummy.position.set(px, this.#heights.at(px, pz) + LIFT, pz);
    // A little splay and size jitter, keyed to the slot, so a column reads
    // as many boots rather than a stenciled dashed line.
    dummy.rotation.set(0, yaw + (hash2(slot, 611) - 0.5) * 0.3, 0);
    const s = 0.85 + hash2(slot, 613) * 0.3;
    dummy.scale.set(s, 1, s);
    dummy.updateMatrix();
    this.mesh.setMatrixAt(slot, dummy.matrix);
    this.mesh.instanceMatrix.addUpdateRange(slot * 16, 16);
    this.#birth.setX(slot, this.#now);
    this.#birth.addUpdateRange(slot, 1);
    this.#stamped = true;
  };
}
