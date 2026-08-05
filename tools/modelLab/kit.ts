import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * The model lab's toolkit: load KayKit scenes, normalize them, and build
 * small procedural parts that wear the pack's own texture atlas.
 *
 * Everything here is deliberately independent of src/render — the lab is a
 * sketchpad for compositions we have not committed to yet. Whatever wins
 * gets ported into assets.ts (BUILDING_FILES + BUILDING_DECOR) afterwards.
 *
 * Space: one unit = one map tile. A variant declares its footprint (w x h)
 * and places parts in tile coordinates around the origin, which is where
 * buildingSync anchors a building.
 */

export const DIR = '/models/kaykit/';

/** The pack ships one 8x4 swatch atlas; every model samples flat cells of
 * it. Procedural parts do the same, so a hand-built oven shades exactly
 * like the mill beside it instead of sitting in its own palette. */
/* Cell centers, sampled straight off the atlas:
 *   0,0 #13191b   1,0 #d4dbde   2,0 #818c91   3,0 #4a5155
 *   4,0 #333333   5,0 #b16f52   6,0 #9b5a45   7,0 #c36532
 *   0,1 #62a0d0   1,1 #257ebc   2,1 #9b5a45   3,1 #d09745
 *   4,1 #7cab48   5,1 #daae7d   6,1 #978f86   7,1 #6b5c53
 *   0,2 #aaaf27   1,2 #008454   2,2 #818c91   3,2 #daae7d
 *   4,2 #daae7d   5,2 #e7cdb4   6,2 #d83f35   7,2 #d55652
 *   0,3 #257ebc   1,3 #d22227   2,3 #f9aa4e   3,3 #008454
 *   4,3 #f79845   5,3 #c5b097   6,3 #978675   7,3 #736458
 * Cell 3,3 is the team-color slot the renderer repaints per owner, so
 * nothing here may point at it — a hand-built part painted there would
 * change color with the flag. */
export const SWATCH = {
  stone: [6, 1],
  stonePale: [5, 3],
  stoneCold: [2, 0],
  slate: [3, 0],
  charcoal: [4, 0],
  timber: [5, 0],
  timberDark: [6, 0],
  brown: [7, 1],
  straw: [5, 1],
  cream: [5, 2],
  sand: [3, 2],
  roofBlue: [1, 1],
  roofOrange: [7, 0],
  green: [4, 1],
  gold: [3, 1],
  amber: [2, 3],
  red: [1, 3],
  salmon: [7, 2],
  steel: [2, 0],
  white: [1, 0],
  skyblue: [0, 1],
} as const;

export type SwatchName = keyof typeof SWATCH;

export class Kit {
  #scenes = new Map<string, THREE.Group>();
  #atlas!: THREE.Texture;
  #manager?: THREE.LoadingManager;

  /** The gallery build inlines every asset as a data URI and hands the Kit
   * a manager that rewrites URLs into that map; the dev page just fetches. */
  constructor(manager?: THREE.LoadingManager) {
    this.#manager = manager;
  }

  async load(files: string[]): Promise<void> {
    const loader = new GLTFLoader(this.#manager);
    await Promise.all(
      files.map(async (f) => {
        const gltf = await loader.loadAsync(`${DIR}${f}.gltf`);
        gltf.scene.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.castShadow = true;
            o.receiveShadow = true;
            const m = o.material as THREE.MeshStandardMaterial;
            if (m?.isMeshStandardMaterial) {
              m.roughness = 0.95;
              m.metalness = 0;
              if (!this.#atlas && !f.startsWith('restaurant/')) this.#atlas = m.map!;
            }
          }
        });
        this.#scenes.set(f, gltf.scene);
      }),
    );
  }

  has(file: string): boolean {
    return this.#scenes.has(file);
  }

  /** Paint every vertex of a geometry at the center of one atlas cell. */
  paint(geo: THREE.BufferGeometry, swatch: SwatchName): THREE.BufferGeometry {
    const [c, r] = SWATCH[swatch];
    const uv = geo.getAttribute('uv');
    const u = (c + 0.5) / 8;
    const v = (r + 0.5) / 4;
    if (uv) {
      for (let i = 0; i < uv.count; i++) uv.setXY(i, u, v);
      uv.needsUpdate = true;
    } else {
      const n = geo.getAttribute('position').count;
      const arr = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        arr[i * 2] = u;
        arr[i * 2 + 1] = v;
      }
      geo.setAttribute('uv', new THREE.BufferAttribute(arr, 2));
    }
    return geo;
  }

  /** A procedural mesh wearing an atlas cell. */
  part(geo: THREE.BufferGeometry, swatch: SwatchName): THREE.Mesh {
    const m = new THREE.Mesh(this.paint(geo, swatch), this.#sharedMat());
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  #shared?: THREE.MeshStandardMaterial;
  #sharedMat(): THREE.MeshStandardMaterial {
    if (!this.#shared) {
      this.#shared = new THREE.MeshStandardMaterial({
        map: this.#atlas,
        roughness: 0.95,
        metalness: 0,
      });
    }
    return this.#shared;
  }

  box(w: number, h: number, d: number, swatch: SwatchName): THREE.Mesh {
    return this.part(new THREE.BoxGeometry(w, h, d), swatch);
  }

  cyl(rt: number, rb: number, h: number, seg: number, swatch: SwatchName): THREE.Mesh {
    return this.part(new THREE.CylinderGeometry(rt, rb, h, seg), swatch);
  }

  sphere(r: number, swatch: SwatchName, seg = 8): THREE.Mesh {
    return this.part(new THREE.SphereGeometry(r, seg, Math.max(4, seg >> 1)), swatch);
  }

  cone(r: number, h: number, seg: number, swatch: SwatchName): THREE.Mesh {
    return this.part(new THREE.ConeGeometry(r, h, seg), swatch);
  }

  /**
   * A pack model, feet on y=0, centered on x/z, scaled so its tallest axis
   * is `h` tiles (or, with `span`, so its footprint is `span` tiles wide).
   */
  prop(
    file: string,
    opts: {
      h?: number;
      span?: number;
      at?: [number, number];
      y?: number;
      rot?: number;
      tiltX?: number;
      tiltZ?: number;
      keepBase?: boolean;
    } = {},
  ): THREE.Group | null {
    const src = this.#scenes.get(file);
    if (!src) return null;
    const inner = src.clone(true);
    inner.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(inner);
    inner.position.set(
      -(bb.min.x + bb.max.x) / 2,
      -bb.min.y,
      -(bb.min.z + bb.max.z) / 2,
    );
    const holder = new THREE.Group();
    holder.add(inner);
    const size = new THREE.Vector3();
    bb.getSize(size);
    const s =
      opts.span !== undefined
        ? opts.span / Math.max(size.x, size.z, 1e-6)
        : (opts.h ?? 1) / Math.max(size.y, 1e-6);
    holder.scale.setScalar(s);
    const g = new THREE.Group();
    g.add(holder);
    g.position.set(opts.at?.[0] ?? 0, opts.y ?? 0, opts.at?.[1] ?? 0);
    g.rotation.y = opts.rot ?? 0;
    if (opts.tiltX) g.rotation.x = opts.tiltX;
    if (opts.tiltZ) g.rotation.z = opts.tiltZ;
    return g;
  }

  /**
   * The base building of a composition: normalized the way makeGlbBuilding
   * does it — footprint fitted to a unit square, then scaled by the short
   * side of the footprint. Previews therefore show the exact size the game
   * would draw.
   */
  base(file: string, w: number, h: number, opts: { rot?: number } = {}): THREE.Group | null {
    const src = this.#scenes.get(file);
    if (!src) return null;
    const inner = src.clone(true);
    inner.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(inner);
    const spanX = bb.max.x - bb.min.x;
    const spanZ = bb.max.z - bb.min.z;
    inner.position.set(
      -(bb.min.x + bb.max.x) / 2,
      -bb.min.y,
      -(bb.min.z + bb.max.z) / 2,
    );
    const unit = new THREE.Group();
    unit.scale.setScalar(1 / Math.max(spanX, spanZ));
    unit.add(inner);
    const g = new THREE.Group();
    g.add(unit);
    g.scale.setScalar(Math.min(w, h) * 1.06);
    g.rotation.y = opts.rot ?? 0;
    return g;
  }

  /** Repaint a loaded pack model into a single atlas cell — how a white
   * flour sack is made out of the grain sack. */
  recolor(obj: THREE.Object3D, swatch: SwatchName): THREE.Object3D {
    obj.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry = (o.geometry as THREE.BufferGeometry).clone();
        this.paint(o.geometry as THREE.BufferGeometry, swatch);
        o.material = this.#sharedMat();
      }
    });
    return obj;
  }
}
