import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * The model lab's toolkit: KayKit scenes, normalized, plus small procedural
 * parts that wear the pack's own colors.
 *
 * Everything here is deliberately independent of src/render — the lab is a
 * sketchpad for compositions we have not committed to yet. Whatever wins
 * gets ported into assets.ts (BUILDING_FILES + BUILDING_DECOR) afterwards.
 *
 * Space: one unit = one map tile. A variant declares its footprint (w x h)
 * and places parts in tile coordinates around the origin, which is where
 * buildingSync anchors a building.
 *
 * There are no textures at runtime. The pack paints every model from one
 * small swatch atlas, so at load time each vertex is given the color the
 * atlas holds at its own UV and the map is dropped. The look is the same —
 * the cells are flat or vertically graded, and the models' UVs already sit
 * where they want the shade — and it buys two things: the published gallery
 * needs no image or buffer fetches at all (an Artifact's CSP blocks both,
 * data: URIs included), and a composition can be baked to plain arrays and
 * shipped inside the page.
 */

export const DIR = '/models/kaykit/';

/**
 * Atlas cells, sampled from the pack's own texture. Hand-built parts use
 * these so an oven shades like the mill beside it.
 *
 * Cell 3,3 (#008454) is the team-color slot the renderer repaints per
 * owner, so it is deliberately absent: a part painted there would change
 * color with the flag.
 */
export const SWATCH = {
  stone: 0x978f86,
  stonePale: 0xc5b097,
  stoneCold: 0x818c91,
  slate: 0x4a5155,
  charcoal: 0x333333,
  timber: 0xb16f52,
  timberDark: 0x9b5a45,
  brown: 0x6b5c53,
  straw: 0xdaae7d,
  cream: 0xe7cdb4,
  sand: 0xdaae7d,
  roofBlue: 0x257ebc,
  roofOrange: 0xc36532,
  green: 0x7cab48,
  gold: 0xd09745,
  amber: 0xf9aa4e,
  red: 0xd22227,
  salmon: 0xd55652,
  steel: 0x818c91,
  white: 0xd4dbde,
  skyblue: 0x62a0d0,
} as const;

export type SwatchName = keyof typeof SWATCH;

/** One model, flattened to a single drawable lump of vertex-colored mesh. */
export interface BakedModel {
  /** base64 Float32Array, world-space. */
  p: string;
  /** base64 Float32Array. */
  n: string;
  /** base64 Uint8Array, sRGB triples. */
  c: string;
  /** base64 Uint32Array. */
  i: string;
}

export type BakedSet = Record<string, BakedModel>;

function toBase64(buf: ArrayBufferLike): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function fromBase64(s: string): ArrayBuffer {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** sRGB byte to linear float — what three expects of a color attribute. */
function srgbToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

const LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) LINEAR[i] = srgbToLinear(i);

export class Kit {
  #models = new Map<string, THREE.BufferGeometry>();
  #material?: THREE.MeshStandardMaterial;

  /** One material for everything: flat-shaded pack colors, per vertex. */
  material(): THREE.MeshStandardMaterial {
    if (!this.#material) {
      this.#material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.95,
        metalness: 0,
      });
    }
    return this.#material;
  }

  /**
   * Load pack models over the network and convert them to vertex colors.
   * The dev page takes this path so a change to the checkout is one reload
   * away; the published gallery takes `loadBaked` instead.
   */
  async load(files: string[]): Promise<void> {
    const loader = new GLTFLoader();
    const samplers = new Map<HTMLImageElement | ImageBitmap, Sampler>();
    await Promise.all(
      files.map(async (f) => {
        const gltf = await loader.loadAsync(`${DIR}${f}.gltf`);
        this.#models.set(f, flatten(gltf.scene, samplers));
      }),
    );
  }

  /** Rebuild from arrays baked by tools/modelLab/bake.mjs. */
  loadBaked(set: BakedSet): void {
    for (const [name, m] of Object.entries(set)) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(fromBase64(m.p)), 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(fromBase64(m.n)), 3));
      const srgb = new Uint8Array(fromBase64(m.c));
      const lin = new Float32Array(srgb.length);
      for (let i = 0; i < srgb.length; i++) lin[i] = LINEAR[srgb[i]!]!;
      geo.setAttribute('color', new THREE.BufferAttribute(lin, 3));
      geo.setIndex(new THREE.BufferAttribute(new Uint32Array(fromBase64(m.i)), 1));
      this.#models.set(name, geo);
    }
  }

  /** Serialize everything loaded, for the gallery build. */
  bake(): BakedSet {
    const out: BakedSet = {};
    for (const [name, geo] of this.#models) {
      const col = geo.getAttribute('color') as THREE.BufferAttribute;
      const srgb = new Uint8Array(col.array.length);
      // Stored as sRGB bytes: a third of the size, and the load-time
      // conversion back to linear is a table lookup.
      for (let i = 0; i < col.array.length; i++) {
        const c = (col.array as Float32Array)[i]!;
        const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
        srgb[i] = Math.round(Math.min(1, Math.max(0, s)) * 255);
      }
      out[name] = {
        p: toBase64((geo.getAttribute('position').array as Float32Array).buffer),
        n: toBase64((geo.getAttribute('normal').array as Float32Array).buffer),
        c: toBase64(srgb.buffer),
        i: toBase64(new Uint32Array(geo.getIndex()!.array).buffer),
      };
    }
    return out;
  }

  has(file: string): boolean {
    return this.#models.has(file);
  }

  /** Fill a geometry's color attribute with one atlas swatch. */
  paint(geo: THREE.BufferGeometry, swatch: SwatchName): THREE.BufferGeometry {
    const hex = SWATCH[swatch];
    const r = LINEAR[(hex >> 16) & 255]!;
    const g = LINEAR[(hex >> 8) & 255]!;
    const b = LINEAR[hex & 255]!;
    const n = geo.getAttribute('position').count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = r;
      arr[i * 3 + 1] = g;
      arr[i * 3 + 2] = b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    geo.deleteAttribute('uv');
    return geo;
  }

  /** A procedural mesh wearing an atlas cell. */
  part(geo: THREE.BufferGeometry, swatch: SwatchName): THREE.Mesh {
    const m = new THREE.Mesh(this.paint(geo, swatch), this.material());
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
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

  #mesh(file: string): THREE.Mesh | null {
    const geo = this.#models.get(file);
    if (!geo) return null;
    const m = new THREE.Mesh(geo, this.material());
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
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
    } = {},
  ): THREE.Group | null {
    const inner = this.#mesh(file);
    if (!inner) return null;
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
    const inner = this.#mesh(file);
    if (!inner) return null;
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

  /** Repaint a loaded pack model into one atlas cell — how a white flour
   * sack is made out of the grain sack. */
  recolor(obj: THREE.Object3D, swatch: SwatchName): THREE.Object3D {
    obj.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry = (o.geometry as THREE.BufferGeometry).clone();
        this.paint(o.geometry as THREE.BufferGeometry, swatch);
      }
    });
    return obj;
  }
}

// ---------------------------------------------------------------------------
// gltf -> one vertex-colored geometry.

/** Reads pixels out of a pack atlas, once per texture. */
interface Sampler {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

function samplerFor(
  tex: THREE.Texture,
  cache: Map<HTMLImageElement | ImageBitmap, Sampler>,
): Sampler | null {
  const img = tex.image as HTMLImageElement | ImageBitmap | undefined;
  if (!img) return null;
  const hit = cache.get(img);
  if (hit) return hit;
  const w = 'naturalWidth' in img ? img.naturalWidth : img.width;
  const h = 'naturalHeight' in img ? img.naturalHeight : img.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img as CanvasImageSource, 0, 0);
  const s = { data: ctx.getImageData(0, 0, w, h).data, w, h };
  cache.set(img, s);
  return s;
}

function sample(s: Sampler, u: number, v: number, out: [number, number, number]): void {
  // GLTF textures are not flipped, so v runs down the image.
  const x = Math.min(s.w - 1, Math.max(0, Math.round(u * s.w - 0.5)));
  const y = Math.min(s.h - 1, Math.max(0, Math.round(v * s.h - 0.5)));
  const i = (y * s.w + x) * 4;
  out[0] = s.data[i]!;
  out[1] = s.data[i + 1]!;
  out[2] = s.data[i + 2]!;
}

/**
 * Flatten a loaded scene into one indexed geometry in world space, with the
 * atlas baked down to a color per vertex.
 */
function flatten(
  scene: THREE.Object3D,
  samplers: Map<HTMLImageElement | ImageBitmap, Sampler>,
): THREE.BufferGeometry {
  scene.updateMatrixWorld(true);
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const rgb: [number, number, number] = [255, 0, 255];
  const v = new THREE.Vector3();
  const nm = new THREE.Matrix3();

  scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const geo = o.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position');
    const nor = geo.getAttribute('normal');
    const uv = geo.getAttribute('uv');
    const map = (o.material as THREE.MeshStandardMaterial)?.map ?? null;
    const s = map ? samplerFor(map, samplers) : null;
    const base = positions.length / 3;
    nm.getNormalMatrix(o.matrixWorld);

    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      positions.push(v.x, v.y, v.z);
      if (nor) {
        v.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
        normals.push(v.x, v.y, v.z);
      } else {
        normals.push(0, 1, 0);
      }
      if (s && uv) {
        sample(s, uv.getX(i), uv.getY(i), rgb);
      } else {
        rgb[0] = 200;
        rgb[1] = 200;
        rgb[2] = 200;
      }
      colors.push(LINEAR[rgb[0]]!, LINEAR[rgb[1]]!, LINEAR[rgb[2]]!);
    }

    const idx = geo.getIndex();
    if (idx) {
      for (let i = 0; i < idx.count; i++) indices.push(base + idx.getX(i));
    } else {
      for (let i = 0; i < pos.count; i++) indices.push(base + i);
    }
  });

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  out.setIndex(indices);
  return out;
}
