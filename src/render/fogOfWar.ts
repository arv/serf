import * as THREE from 'three';
import { MAP_SIZE, TILE_COUNT, tileIdx } from '../shared/grid';
import { AUX_STRIDE, ACTION, type SabReader } from '../protocol/sabLayout';
import { OWNER_CODE } from '../sim/defs/units';
import type { BuildingSnap } from '../protocol/messages';

/** Disable the whole layer with ?nofog — handy when eyeballing the map. */
export const FOG_ENABLED = !new URLSearchParams(location.search).has('nofog');

/** How far each thing sees, in tiles. */
const UNIT_SIGHT = 6.5;
const BUILDING_SIGHT = 5.5;
const STOREHOUSE_SIGHT = 9;
/** Tiles over which a sight circle fades out at its rim. */
const RIM = 1.4;

/** Reveal snaps in; concealment lags behind, so edges breathe. */
const REVEAL_RATE = 14;
const CONCEAL_RATE = 3.5;

/** Above this a tile counts as seen for gameplay queries (picking, hiding). */
const SEEN = 0.35;

/** What the entity syncs need to know — they take this, not the whole fog. */
export interface FogQuery {
  /** Is this world position lit right now? */
  visibleAt(x: number, z: number): boolean;
  /** Has the player ever seen it? */
  exploredAt(x: number, z: number): boolean;
}

/**
 * Fog of war, entirely render-side. The sim stays untouched: it is single
 * player, so nothing about the simulation depends on what the player can
 * see, and keeping it out means no determinism risk, no protocol change,
 * and nothing new to serialize.
 *
 * Visibility lives in a MAP_SIZE² grid uploaded as a texture, and every
 * material in the scene samples it by world XZ. Doing it in the shader
 * rather than with an overlay plane is what makes it correct: a fog quad
 * laid over the ground would sit at one height, and under this fixed
 * isometric camera a mountain or a tower would poke through it, because
 * a tall object's pixels land far from its footprint on screen. Sampling
 * per fragment, every pixel is judged by the ground it actually stands on.
 */
export class FogOfWar implements FogQuery {
  /** Smoothed current visibility, 0..1 per tile. */
  #vis = new Float32Array(TILE_COUNT);
  /** Target for this update, before smoothing. */
  #target = new Float32Array(TILE_COUNT);
  /** Ever-seen, 0..1 per tile (never decreases). */
  #explored = new Float32Array(TILE_COUNT);
  #bytes = new Uint8Array(TILE_COUNT * 4);
  #texture: THREE.DataTexture;
  #uniforms: { uFogTex: { value: THREE.Texture }; uFogSize: { value: number } };
  #patched = new WeakSet<THREE.Material>();
  #accum = 0;

  constructor() {
    this.#texture = new THREE.DataTexture(this.#bytes, MAP_SIZE, MAP_SIZE);
    this.#texture.format = THREE.RGBAFormat;
    this.#texture.type = THREE.UnsignedByteType;
    // Linear so the tile grid dissolves into a soft frontier.
    this.#texture.magFilter = THREE.LinearFilter;
    this.#texture.minFilter = THREE.LinearFilter;
    this.#texture.wrapS = THREE.ClampToEdgeWrapping;
    this.#texture.wrapT = THREE.ClampToEdgeWrapping;
    this.#texture.needsUpdate = true;
    this.#uniforms = {
      uFogTex: { value: this.#texture },
      uFogSize: { value: MAP_SIZE },
    };
  }

  #at(field: Float32Array, x: number, z: number): number {
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    if (tx < 0 || tz < 0 || tx >= MAP_SIZE || tz >= MAP_SIZE) return 0;
    return field[tileIdx(tx, tz)]!;
  }

  visibleAt(x: number, z: number): boolean {
    return !FOG_ENABLED || this.#at(this.#vis, x, z) > SEEN;
  }

  exploredAt(x: number, z: number): boolean {
    return !FOG_ENABLED || this.#at(this.#explored, x, z) > SEEN;
  }

  /** Stamp one sight circle into the target mask. */
  #stamp(cx: number, cz: number, radius: number): void {
    const r = Math.ceil(radius + RIM);
    const x0 = Math.max(0, Math.floor(cx) - r);
    const x1 = Math.min(MAP_SIZE - 1, Math.floor(cx) + r);
    const z0 = Math.max(0, Math.floor(cz) - r);
    const z1 = Math.min(MAP_SIZE - 1, Math.floor(cz) + r);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const dz = z + 0.5 - cz;
        const d = Math.sqrt(dx * dx + dz * dz);
        // Soft rim so the frontier is a gradient, not a cookie cutter.
        const t = Math.min(Math.max((radius - d) / RIM, 0), 1);
        if (t <= 0) continue;
        const i = tileIdx(x, z);
        if (t > this.#target[i]!) this.#target[i] = t;
      }
    }
  }

  /**
   * Recompute what the player can see and fade the mask toward it. Throttled
   * to ~12 Hz: the sim only moves things 20 times a second, and the temporal
   * smoothing hides the difference.
   */
  update(dt: number, reader: SabReader, buildings: BuildingSnap[], scene: THREE.Scene): void {
    if (!FOG_ENABLED) return;
    this.#patchNewMaterials(scene);

    this.#accum += dt;
    if (this.#accum < 1 / 12) return;
    const step = this.#accum;
    this.#accum = 0;

    this.#target.fill(0);
    const { latest } = reader;
    for (let i = 0; i < latest.count; i++) {
      const a = i * AUX_STRIDE;
      if (latest.aux[a + 1] !== OWNER_CODE.player) continue;
      if (latest.aux[a + 4] === ACTION.dead) continue;
      this.#stamp(latest.xs[i]!, latest.ys[i]!, UNIT_SIGHT);
    }
    for (const b of buildings) {
      if (b.owner !== 'player') continue;
      const sight = b.type === 'storehouse' ? STOREHOUSE_SIGHT : BUILDING_SIGHT;
      this.#stamp(b.x + b.w / 2, b.y + b.h / 2, sight + Math.max(b.w, b.h) / 2);
    }

    const up = 1 - Math.exp(-step * REVEAL_RATE);
    const down = 1 - Math.exp(-step * CONCEAL_RATE);
    for (let i = 0; i < TILE_COUNT; i++) {
      const t = this.#target[i]!;
      const v = this.#vis[i]!;
      const next = v + (t - v) * (t > v ? up : down);
      this.#vis[i] = next;
      if (next > this.#explored[i]!) this.#explored[i] = next;
      const o = i * 4;
      this.#bytes[o] = Math.round(next * 255);
      this.#bytes[o + 1] = Math.round(this.#explored[i]! * 255);
    }
    this.#texture.needsUpdate = true;
  }

  /**
   * Patch every material in the scene to sample the fog. Done by sweeping
   * the graph rather than hooking each construction site: visuals are
   * created in half a dozen modules (and cloned per building, per unit,
   * per prop), and a sweep catches all of them without threading a fog
   * reference through every one.
   */
  #patchNewMaterials(scene: THREE.Scene): void {
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      if (Array.isArray(mat)) for (const m of mat) this.#patch(m);
      else this.#patch(mat);
    });
  }

  #patch(material: THREE.Material): void {
    if (this.#patched.has(material)) return;
    this.#patched.add(material);
    // Screen-space overlays (hp bars, selection rings) opt out: they only
    // ever show for things the player can already see.
    if (material.userData?.noFog) return;

    const previous = material.onBeforeCompile.bind(material);
    material.onBeforeCompile = (shader, renderer) => {
      previous(shader, renderer);
      shader.uniforms.uFogTex = this.#uniforms.uFogTex;
      shader.uniforms.uFogSize = this.#uniforms.uFogSize;

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vFogXZ;')
        .replace(
          '#include <project_vertex>',
          /* glsl */ `#include <project_vertex>
          {
            // After skinning and morphing, before the camera: this is the
            // one point where a single expression gives the world position
            // of a plain mesh, an instanced tree, and a skinned serf alike.
            vec4 fogPos = vec4(transformed, 1.0);
            #ifdef USE_INSTANCING
              fogPos = instanceMatrix * fogPos;
            #endif
            vFogXZ = (modelMatrix * fogPos).xz;
          }`,
        );

      const fogFrag = /* glsl */ `
          {
            vec2 fuv = vFogXZ / uFogSize;
            vec2 f = texture2D(uFogTex, fuv).rg;
            float vis = f.r;
            float seen = f.g;
            // Remembered ground: what you saw, drained of color and light.
            float lum = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
            vec3 memory = mix(vec3(lum), gl_FragColor.rgb, 0.4) * 0.42;
            vec3 unknown = vec3(0.016, 0.026, 0.03);
            vec3 hidden = mix(unknown, memory, seen);
            gl_FragColor.rgb = mix(hidden, gl_FragColor.rgb, vis);
          }`;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        '#include <common>\nuniform sampler2D uFogTex;\nuniform float uFogSize;\nvarying vec2 vFogXZ;',
      );
      // Last chunk standing: fog multiplies the finished pixel, so it dims
      // lighting, tone mapping and all.
      if (shader.fragmentShader.includes('#include <dithering_fragment>')) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <dithering_fragment>',
          `#include <dithering_fragment>${fogFrag}`,
        );
      } else {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          `#include <opaque_fragment>${fogFrag}`,
        );
      }
    };
    material.needsUpdate = true;
  }
}
