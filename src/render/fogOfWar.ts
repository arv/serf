import * as THREE from 'three';
import type {BuildingSnap} from '../protocol/messages';
import {AUX_STRIDE, ACTION, type SabReader} from '../protocol/sabLayout';
import {tileCount, tileIdx} from '../shared/grid';
import {clamp} from '../shared/math';
import {UNIT_DEFS} from '../sim/defs/units';
import {playMax, playMin, type PlayArea} from '../sim/map';
import {buildingSight} from '../sim/visibility';
import {background} from './palette';

/** Sight radii come from the unit and building defs, so this and the
 * server's visibility filter cannot drift apart — if they did, the server
 * would send things this never lights, or light ground it was sent nothing
 * for. See src/sim/visibility.ts. */
const SIGHT_BY_KIND_CODE = new Map<number, number>(
  Object.values(UNIT_DEFS).map(d => [d.id, d.sight]),
);
/** Tiles over which a sight circle fades out at its rim. Generous on
 * purpose: a long feather is what makes the frontier read as fog rolling
 * off rather than a stencil cut around each unit. */
const RIM = 3.2;

/** Reveal snaps in; concealment lags behind, so edges breathe. */
const REVEAL_RATE = 14;
const CONCEAL_RATE = 3.5;

/** Above this a tile counts as seen for gameplay queries (picking, hiding). */
const SEEN = 0.35;

/** What the entity syncs and effect layers need to know — they take this,
 * not the whole fog. */
export interface FogQuery {
  /** Is this world position lit right now? */
  visibleAt(x: number, z: number): boolean;
  /** Has the player ever seen it? */
  exploredAt(x: number, z: number): boolean;
  /** Presentation-grade light level, 0..1, at a world position — for the
   * few effects (mist sprites) that cannot take the material patch and
   * must dim themselves to match the ground under them. */
  litAt(x: number, z: number): number;
}

/**
 * Fog of war, entirely render-side. The sim stays untouched, and in
 * multiplayer that is not merely convenient but required: every client
 * draws a different fog from the same world, so anything the sim did with
 * visibility would have to stay identical on all of them anyway. Keeping
 * it in the renderer means no determinism risk, no protocol change, and
 * nothing new to serialize — a view over the world, not part of it.
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
  /** Map grid size (tiles per side) for this match. */
  #size: number;
  /** Smoothed current visibility, 0..1 per tile. */
  #vis: Float32Array;
  /** Target for this update, before smoothing. */
  #target: Float32Array;
  /** Ever-seen, 0..1 per tile (never decreases). */
  #explored: Float32Array;
  /** Blurred copies — what the texture carries. The crisp arrays above stay
   * authoritative for gameplay queries, so softening the look never makes
   * "can I see that raider" a fuzzy question. */
  #visSoft: Float32Array;
  #expSoft: Float32Array;
  #scratch: Float32Array;
  #bytes: Uint8Array;
  #texture: THREE.DataTexture;
  #uniforms: {
    uFogTex: {value: THREE.Texture};
    uFogSize: {value: number};
    uUnknown: {value: THREE.Color};
  };
  /**
   * Every material this fog has spliced itself into, and what its
   * onBeforeCompile was beforehand — `undefined` where the material had
   * none of its own and inherited the prototype's.
   *
   * A Map rather than the WeakSet this used to be, because the patch now
   * has to be undoable. The character and building GLBs are loaded once per
   * document and cached there, so their materials outlive any one match —
   * and a second match patching an already-patched material declares
   * `varying vec2 vFogXZ` twice and every shader on it fails to compile.
   * Holding them strongly costs nothing that matters: this map dies with
   * the match, and the assets it points at are the ones deliberately kept.
   */
  #patched = new Map<
    THREE.Material,
    THREE.Material['onBeforeCompile'] | undefined
  >();
  /** Objects already listening for children, so the sweep can be skipped
   * while the graph is unchanged. */
  #watched = new WeakSet<THREE.Object3D>();
  #dirty = true;
  #accum = 0;
  #enabled = true;
  /** Seat whose eyes we see through: its units and buildings light the map. */
  #owner: number;
  /** Fog source per tile: identity inside the play square; a margin tile
   * points at the nearest play tile, whose fate it shares (see ctor). */
  #mirror!: Int32Array;

  /**
   * Turn the layer on or off. Off lights the whole map rather than
   * unpatching materials, so toggling costs one texture write and the
   * remembered ground is still there when it comes back on.
   */
  setEnabled(on: boolean): void {
    if (on === this.#enabled) return;
    this.#enabled = on;
    if (on) {
      this.#accum = Infinity; // recompute on the next update, no wait
    } else {
      this.#bytes.fill(255);
      this.#texture.needsUpdate = true;
    }
  }

  constructor(owner: number, area: PlayArea) {
    const size = area.size;
    this.#owner = owner;
    this.#size = size;
    const tiles = tileCount(size);
    // The scenery ring has no sight of its own — nothing gameplay ever
    // stands there — so each margin tile mirrors the nearest play tile
    // and shares its fate: dark until the border beside it is scouted,
    // lit while it is watched. (It used to be held permanently lit, which
    // framed an unexplored map as a dark island in bright scenery — the
    // fog's framing turned inside out.) Baked as an index map the update
    // loop reads targets through.
    this.#mirror = new Int32Array(tiles);
    const p0 = playMin(area);
    const p1 = playMax(area) - 1;
    for (let z = 0; z < size; z++) {
      const mz = clamp(z, p0, p1);
      for (let x = 0; x < size; x++) {
        this.#mirror[tileIdx(x, z, size)] = tileIdx(clamp(x, p0, p1), mz, size);
      }
    }
    this.#vis = new Float32Array(tiles);
    this.#target = new Float32Array(tiles);
    this.#explored = new Float32Array(tiles);
    this.#visSoft = new Float32Array(tiles);
    this.#expSoft = new Float32Array(tiles);
    this.#scratch = new Float32Array(tiles);
    this.#bytes = new Uint8Array(tiles * 4);
    this.#texture = new THREE.DataTexture(this.#bytes, size, size);
    this.#texture.format = THREE.RGBAFormat;
    this.#texture.type = THREE.UnsignedByteType;
    // Linear so the tile grid dissolves into a soft frontier.
    this.#texture.magFilter = THREE.LinearFilter;
    this.#texture.minFilter = THREE.LinearFilter;
    this.#texture.wrapS = THREE.ClampToEdgeWrapping;
    this.#texture.wrapT = THREE.ClampToEdgeWrapping;
    this.#texture.needsUpdate = true;
    // Unexplored ground is painted the scene's own background color, so
    // the map stops being a silhouette in the dark: where there is no
    // geometry at all the background already shows, and anything else
    // leaves the map's edge legible as a shape. Encoded to sRGB because
    // this lands after the color-space conversion, on the final pixel.
    const unknown = new THREE.Color(background).convertLinearToSRGB();
    this.#uniforms = {
      uFogTex: {value: this.#texture},
      uFogSize: {value: size},
      uUnknown: {value: unknown},
    };
  }

  /**
   * Adopt a server-sent ever-seen grid (multiplayer boot and reconnect).
   * The fog otherwise re-accumulates from live sight only, which after a
   * reload left everything the seat had scouted dark — and the placement
   * gate refusing ground the server itself considers explored. Values only
   * ever rise: local memory is kept where it is already brighter.
   */
  seedExplored(explored: Uint8Array): void {
    const n = Math.min(explored.length, tileCount(this.#size));
    for (let i = 0; i < n; i++) {
      if (explored[i] && this.#explored[i]! < 1) this.#explored[i] = 1;
    }
    // The margin re-derives its memory from the border it mirrors. The
    // server's grid only carries what sight actually touched — in the ring
    // that is at most a rim-deep spill — while the live fog lights a
    // border's whole outward run; without this, a reload would leave
    // remembered coastline facing a black horizon.
    const tiles = tileCount(this.#size);
    for (let i = 0; i < tiles; i++) {
      const m = this.#mirror[i]!;
      if (this.#explored[m]! > this.#explored[i]!)
        this.#explored[i] = this.#explored[m]!;
    }
    this.#accum = Infinity; // re-blur and upload on the next update
  }

  /** Crisp ever-seen snapshot (1 = seen), judged by the same threshold the
   * gameplay queries use — what the solo save carries so a loaded game
   * remembers its map (multiplayer gets the server's grid instead). */
  exportExplored(): Uint8Array {
    const tiles = tileCount(this.#size);
    const out = new Uint8Array(tiles);
    for (let i = 0; i < tiles; i++) {
      if (this.#explored[i]! > SEEN) out[i] = 1;
    }
    return out;
  }

  #at(field: Float32Array, x: number, z: number): number {
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    if (tx < 0 || tz < 0 || tx >= this.#size || tz >= this.#size) return 0;
    return field[tileIdx(tx, tz, this.#size)]!;
  }

  visibleAt(x: number, z: number): boolean {
    return !this.#enabled || this.#at(this.#vis, x, z) > SEEN;
  }

  exploredAt(x: number, z: number): boolean {
    return !this.#enabled || this.#at(this.#explored, x, z) > SEEN;
  }

  /** The same smoothed-and-blurred values the shader's texture carries,
   * with memory counting for a quarter — roughly how far the shader dims
   * remembered ground. */
  litAt(x: number, z: number): number {
    if (!this.#enabled) return 1;
    return Math.max(
      this.#at(this.#visSoft, x, z),
      this.#at(this.#expSoft, x, z) * 0.25,
    );
  }

  /** Stamp one sight circle into the target mask. */
  #stamp(cx: number, cz: number, radius: number): void {
    const size = this.#size;
    const r = Math.ceil(radius + RIM);
    const x0 = Math.max(0, Math.floor(cx) - r);
    const x1 = Math.min(size - 1, Math.floor(cx) + r);
    const z0 = Math.max(0, Math.floor(cz) - r);
    const z1 = Math.min(size - 1, Math.floor(cz) + r);
    // The bounding box is a square and the stamp is a circle, so a fifth of
    // the tiles visited are corners that contribute nothing. Rejecting them
    // on the squared distance keeps the square root for the tiles that can
    // actually be lit. The bound is the OUTER radius, comfortably past the
    // `t <= 0` cut below, so the two can never disagree about a tile.
    const outerSq = (radius + RIM) * (radius + RIM);
    for (let z = z0; z <= z1; z++) {
      const dz = z + 0.5 - cz; // constant across the row
      const dzSq = dz * dz;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const dSq = dx * dx + dzSq;
        if (dSq >= outerSq) continue;
        const d = Math.sqrt(dSq);
        // Soft rim so the frontier is a gradient, not a cookie cutter.
        const t = Math.min(Math.max((radius - d) / RIM, 0), 1);
        if (t <= 0) continue;
        const i = tileIdx(x, z, size);
        if (t > this.#target[i]!) this.#target[i] = t;
      }
    }
  }

  /**
   * Recompute what the player can see and fade the mask toward it. Throttled
   * to ~12 Hz: the sim only moves things 20 times a second, and the temporal
   * smoothing hides the difference.
   */
  update(
    dt: number,
    reader: SabReader,
    buildings: BuildingSnap[],
    scene: THREE.Scene,
  ): void {
    // Only when the graph has actually grown. This used to walk every
    // Object3D in the scene on every frame — a dozen-plus nodes per unit
    // rig, plus buildings, piles and site frames — ahead of both the
    // enabled check and the throttle, to find nothing 59 frames out of 60.
    // Still done while disabled, though: materials created during a fog-off
    // stretch must be ready for it being switched back on.
    if (this.#dirty) this.#patchNewMaterials(scene);
    else if (this.#pending.length > 0) this.#patchPending();
    if (!this.#enabled) return;

    this.#accum += dt;
    if (this.#accum < 1 / 12) return;
    const step = this.#accum;
    this.#accum = 0;

    this.#target.fill(0);
    const {latest} = reader;
    for (let i = 0; i < latest.count; i++) {
      const a = i * AUX_STRIDE;
      if (latest.aux[a + 1] !== this.#owner) continue;
      if (latest.aux[a + 4] === ACTION.dead) continue;
      this.#stamp(
        latest.xs[i]!,
        latest.ys[i]!,
        SIGHT_BY_KIND_CODE.get(latest.aux[a]!) ?? 0,
      );
    }
    for (const b of buildings) {
      if (b.owner !== this.#owner) continue;
      this.#stamp(
        b.x + b.w / 2,
        b.y + b.h / 2,
        buildingSight(b.type, b.w, b.h),
      );
    }

    const tiles = tileCount(this.#size);
    const up = 1 - Math.exp(-step * REVEAL_RATE);
    const down = 1 - Math.exp(-step * CONCEAL_RATE);
    for (let i = 0; i < tiles; i++) {
      const t = this.#target[this.#mirror[i]!]!;
      const v = this.#vis[i]!;
      const next = v + (t - v) * (t > v ? up : down);
      this.#vis[i] = next;
      if (next > this.#explored[i]!) this.#explored[i] = next;
    }

    // Two blur passes before upload. One texel per tile means bilinear
    // filtering alone only ever smooths across a single tile, which still
    // leaves the grid legible along the frontier.
    this.#blur(this.#vis, this.#visSoft);
    this.#blur(this.#visSoft, this.#visSoft);
    this.#blur(this.#explored, this.#expSoft);
    this.#blur(this.#expSoft, this.#expSoft);
    for (let i = 0; i < tiles; i++) {
      const o = i * 4;
      this.#bytes[o] = Math.round(this.#visSoft[i]! * 255);
      this.#bytes[o + 1] = Math.round(this.#expSoft[i]! * 255);
    }
    this.#texture.needsUpdate = true;
  }

  /** Separable 1-2-1 blur, clamped at the map edge. */
  #blur(src: Float32Array, out: Float32Array): void {
    const size = this.#size;
    const s = this.#scratch;
    for (let z = 0; z < size; z++) {
      const row = z * size;
      for (let x = 0; x < size; x++) {
        const l = src[row + (x > 0 ? x - 1 : 0)]!;
        const c = src[row + x]!;
        const r = src[row + (x < size - 1 ? x + 1 : size - 1)]!;
        s[row + x] = (l + 2 * c + r) * 0.25;
      }
    }
    for (let z = 0; z < size; z++) {
      const row = z * size;
      const upRow = (z > 0 ? z - 1 : 0) * size;
      const dnRow = (z < size - 1 ? z + 1 : size - 1) * size;
      for (let x = 0; x < size; x++) {
        out[row + x] = (s[upRow + x]! + 2 * s[row + x]! + s[dnRow + x]!) * 0.25;
      }
    }
  }

  /**
   * Patch every material in the scene to sample the fog. Done by sweeping
   * the graph rather than hooking each construction site: visuals are
   * created in half a dozen modules (and cloned per building, per unit,
   * per prop), and a sweep catches all of them without threading a fog
   * reference through every one.
   *
   * The sweep also subscribes to every node it passes, which is what lets
   * it be skipped the rest of the time: a visual only becomes visible by
   * being added somewhere under the scene, and that add marks the graph
   * dirty in the same frame it happens, so the next sweep still lands
   * before the object's second frame — exactly where the every-frame sweep
   * landed.
   */
  #patchNewMaterials(scene: THREE.Scene): void {
    this.#dirty = false;
    this.#pending.length = 0; // the full sweep covers any queued subtrees
    scene.traverse(this.#visit);
  }

  /** Sweep only the subtrees added since the last frame — a scene add no
   * longer triggers a walk of the whole graph, just of what arrived (the
   * traverse catches grandchildren, so they get listeners and patches). */
  #patchPending(): void {
    for (const root of this.#pending) root.traverse(this.#visit);
    this.#pending.length = 0;
  }

  #visit = (obj: THREE.Object3D): void => {
    if (!this.#watched.has(obj)) {
      this.#watched.add(obj);
      obj.addEventListener('childadded', this.#onChildAdded);
    }
    const mesh = obj as THREE.Mesh;
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    if (Array.isArray(mat)) for (const m of mat) this.#patch(m);
    else this.#patch(mat);
  };

  /** Subtrees added to the scene since the last sweep. */
  #pending: THREE.Object3D[] = [];

  #onChildAdded = (event: {child: THREE.Object3D}): void => {
    this.#pending.push(event.child);
  };

  /**
   * Unpick every splice, so the materials that outlive this match meet the
   * next one's fog as they were. Skipping this leaves a shared GLB material
   * carrying a dead match's fog uniforms and, on the second patch, a shader
   * that will not compile at all.
   */
  dispose(): void {
    for (const [material, previous] of this.#patched) {
      if (previous) material.onBeforeCompile = previous;
      // No own property before us: hand it back to the prototype's no-op
      // rather than leaving a copy of it shadowing one.
      else delete (material as Partial<THREE.Material>).onBeforeCompile;
      // The compiled program still has the patch baked in; this is what
      // makes the next context build a clean one.
      material.needsUpdate = true;
    }
    this.#patched.clear();
  }

  #patch(material: THREE.Material): void {
    if (this.#patched.has(material)) return;
    // Stored to be assigned straight back onto this same material (see
    // #restore); it is never called detached, and the live call site
    // below binds before it invokes.
    // oxlint-disable-next-line typescript/unbound-method
    const own = material.onBeforeCompile;
    this.#patched.set(
      material,
      Object.hasOwn(material, 'onBeforeCompile') ? own : undefined,
    );
    // Screen-space overlays (hp bars, selection rings) opt out: they only
    // ever show for things the player can already see.
    if (material.userData?.noFog) return;
    // Sprites cannot take this patch. Their vertex shader has no
    // <project_vertex> to hang the world position on, so vFogXZ would be
    // declared, read, and never written — the fragment then sampled some
    // arbitrary tile (0,0 in practice) instead of the sprite's own, and
    // mist over explored water came out painted toward the unknown color.
    if (material instanceof THREE.SpriteMaterial) return;

    const previous = material.onBeforeCompile.bind(material);
    material.onBeforeCompile = (shader, renderer) => {
      previous(shader, renderer);
      shader.uniforms.uFogTex = this.#uniforms.uFogTex;
      shader.uniforms.uFogSize = this.#uniforms.uFogSize;
      shader.uniforms.uUnknown = this.#uniforms.uUnknown;

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
            vec3 memory = mix(vec3(lum), gl_FragColor.rgb, 0.4) * 0.5;
            vec3 hidden = mix(uUnknown, memory, seen);
            gl_FragColor.rgb = mix(hidden, gl_FragColor.rgb, vis);
          }`;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        '#include <common>\nuniform sampler2D uFogTex;\nuniform float uFogSize;\nuniform vec3 uUnknown;\nvarying vec2 vFogXZ;',
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
