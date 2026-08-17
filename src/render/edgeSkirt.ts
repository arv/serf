import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash2 } from '../shared/math';
import { tileIdx } from '../shared/grid';
import { Terrain, TileResource, type MapView } from '../sim/map';
import { palette } from './palette';
import { vnoise } from './noise';
import { glbRocks, glbTrees } from './assets';
import type { HeightField } from './heightField';

type RimStyle = 'sea' | 'ridge' | 'forest';

/**
 * How far past the map edge the skirt reaches, in tiles. Matches the water
 * plane's overhang (its geometry is three times the map on a side), so the
 * two horizons end together — and the outer quarter of the skirt melts
 * into the fog color anyway (see #surface), so even a corner camera at
 * full zoom-out never meets a hard rim.
 */
function skirtExtent(size: number): number {
  return size;
}

/**
 * Classify one edge by walking inward and reading the first non-water
 * tile at several positions — the same vote the worldgen tests take. The
 * walk-in matters: the waterline wobbles, so no fixed depth is reliable.
 */
function edgeStyle(map: MapView, side: number): RimStyle {
  const size = map.size;
  const probe = 3 * Math.max(1, Math.floor(size / 24)) + 3;
  let rock = 0;
  let wood = 0;
  let sea = 0;
  for (let along = 4; along < size - 4; along += 3) {
    let vote: RimStyle = 'sea';
    for (let d = 0; d < probe; d++) {
      const [x, y] =
        side === 0
          ? [along, d]
          : side === 1
            ? [size - 1 - d, along]
            : side === 2
              ? [along, size - 1 - d]
              : [d, along];
      const i = tileIdx(x, y, size);
      if (map.terrain[i] === Terrain.Water) continue;
      if (map.terrain[i] === Terrain.Rock) vote = 'ridge';
      else if (map.resource[i] === TileResource.Wood) vote = 'forest';
      break;
    }
    if (vote === 'ridge') rock++;
    else if (vote === 'forest') wood++;
    else sea++;
  }
  if (rock > wood && rock > sea) return 'ridge';
  if (wood > rock && wood > sea) return 'forest';
  return 'sea';
}

/** Smoothstep of t clamped to [0, 1]. */
function ease01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/**
 * The world beyond the map's edge. The playfield ends at the grid, but the
 * horizon must not: each border continues as what its rim already is — a
 * ridge edge keeps rising into ranges behind the coast, a forest edge rolls
 * on as wooded hills, a sea edge stays open water (the deep bed laid here
 * is what the water plane shades against). One low-resolution vertex-colored
 * plane ringing the map, plus instanced trees over the forest reaches;
 * corners blend the two adjoining styles by how far past each edge a point
 * sits. Pure scenery: nothing here is pickable, pathable, or lit by fog of
 * war, and none of it casts shadows into the playfield.
 */
export class EdgeSkirt {
  readonly group = new THREE.Group();
  #map: MapView;
  #heights: HeightField;
  #size: number;
  #ext: number;
  #styles: RimStyle[];

  constructor(map: MapView, heights: HeightField) {
    this.#map = map;
    this.#heights = heights;
    const size = map.size;
    this.#size = size;
    this.#ext = skirtExtent(size);
    this.#styles = [0, 1, 2, 3].map((s) => edgeStyle(map, s));

    const span = size + 2 * this.#ext;
    const geometry = new THREE.PlaneGeometry(span, span, span, span);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(size / 2, 0, size / 2);

    const pos = geometry.attributes.position!;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v);
      const z = pos.getZ(v);
      const y = this.#surface(x, z, c);
      pos.setY(v, y);
      const s = 0.92 + hash2(v, 977) * 0.16;
      colors[v * 3] = c.r * s;
      colors[v * 3 + 1] = c.g * s;
      colors[v * 3 + 2] = c.b * s;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshLambertMaterial({ vertexColors: true }),
    );
    mesh.receiveShadow = true;
    this.group.add(mesh);

    this.#plantTrees();
    this.#strewBoulders();
  }

  /**
   * Craggy dressing over the near ridge field — the same boulder scatter
   * the in-map rim rock wears, so the range across the channel carries the
   * map's texture until distance (and the fog) takes over.
   */
  #strewBoulders(): void {
    const size = this.#size;
    const ext = this.#ext;
    const rocks = glbRocks();
    if (!rocks || !this.#styles.includes('ridge')) return;

    const dummy = new THREE.Object3D();
    const tint = new THREE.Color();
    const spots: { x: number; z: number; y: number; seed: number }[] = [];
    for (let tz = -16; tz < size + 16; tz++) {
      for (let tx = -16; tx < size + 16; tx++) {
        const cx = tx + 0.5;
        const cz = tz + 0.5;
        const { ox, oz } = this.#overhang(cx, cz);
        if (ox === 0 && oz === 0) continue;
        const d = Math.hypot(ox, oz);
        if (d < 1.5 || d > 14) continue;
        let ridgeW = 0;
        for (const s of this.#sides(cx, cz, ox, oz)) {
          if (s.style === 'ridge') ridgeW += s.w;
        }
        if (ridgeW < 0.6) continue;
        const seed = (tz + 16) * (size + 32) + (tx + 16);
        if (hash2(seed, 71) > 0.28) continue;
        const jx = 0.2 + hash2(seed, 72) * 0.6;
        const jz = 0.2 + hash2(seed, 73) * 0.6;
        const x = tx + jx;
        const z = tz + jz;
        const y = this.#heightOnly(x, z);
        if (y < 0.05) continue;
        spots.push({ x, z, y, seed });
      }
    }
    if (spots.length === 0) return;

    const perSpecies: number[][] = rocks.geometries.map(() => []);
    spots.forEach((spot, i) => {
      perSpecies[(hash2(spot.seed, 41) * perSpecies.length) | 0]!.push(i);
    });
    rocks.geometries.forEach((geo, si) => {
      const ids = perSpecies[si]!;
      if (ids.length === 0) return;
      const mesh = new THREE.InstancedMesh(geo, rocks.material, ids.length);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      ids.forEach((spotIdx, k) => {
        const spot = spots[spotIdx]!;
        const s = 0.5 + hash2(spot.seed, 74) * 0.6;
        dummy.position.set(spot.x, spot.y - 0.03, spot.z);
        dummy.rotation.set(0, hash2(spot.seed, 75) * Math.PI * 2, 0);
        dummy.scale.set(s, s, s);
        dummy.updateMatrix();
        mesh.setMatrixAt(k, dummy.matrix);
        tint.setHex(0xffffff).lerp(TREE_TINT.setHex(palette.rockDark), hash2(spot.seed, 76) * 0.3);
        mesh.setColorAt(k, tint);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.group.add(mesh);
    });
  }

  /** Overhang past the map on each axis; 0,0 inside the playfield. */
  #overhang(x: number, z: number): { ox: number; oz: number } {
    const size = this.#size;
    return {
      ox: x < 0 ? -x : x > size ? x - size : 0,
      oz: z < 0 ? -z : z > size ? z - size : 0,
    };
  }

  /**
   * The style mix at a point outside the map: up to two sides contribute,
   * weighted by how far past each the point sits, so corners morph from
   * one border's scenery into the other's instead of seaming. Each entry
   * carries its side index plus that side's own edge coordinates (u along
   * the edge, d outward) for the anisotropic height field.
   */
  #sides(
    x: number,
    z: number,
    ox: number,
    oz: number,
  ): { style: RimStyle; w: number; side: number; u: number; d: number }[] {
    const out: { style: RimStyle; w: number; side: number; u: number; d: number }[] = [];
    // Sharpened, not linear: a wide 50/50 mush zone along the corner
    // diagonal averaged a sea bed against rising land into a half-sunk
    // shelf; easing the weight through the middle keeps the transition a
    // coastline instead.
    const w = ease01((ox / (ox + oz) - 0.3) / 0.4);
    if (ox > 0) {
      const side = x < 0 ? 3 : 1;
      out.push({ style: this.#styles[side]!, w: oz > 0 ? w : 1, side, u: z, d: ox });
    }
    if (oz > 0) {
      const side = z < 0 ? 0 : 2;
      out.push({ style: this.#styles[side]!, w: ox > 0 ? 1 - w : 1, side, u: x, d: oz });
    }
    return out;
  }

  /**
   * Terrain height of one style's far field. `u` runs along the side's
   * edge and `d` runs outward from it, so a ridge side can lay its ranges
   * down PARALLEL to the border — isotropic noise made lumpy plains here;
   * chains that run with the coast silhouette against the camera the way
   * the in-map border ridge does. Each side seeds its own noise so two
   * ranges never mirror each other across a corner.
   */
  #styleHeight(style: RimStyle, side: number, u: number, d: number): number {
    if (style === 'sea') return -1.5 - vnoise(171 + side * 7, u, d, 6) * 0.5;
    if (style === 'ridge') {
      // Rises out of the water a couple of tiles past the strip and stays
      // mountainous to the horizon. Crest features stretch ~12 tiles along
      // the edge but only ~5 across it; the massif mask keeps whole
      // stretches below the snow line so the peaks read as ranges, not as
      // one white lace; a rough high-frequency layer breaks the
      // 1-vertex-per-tile lattice's soft lumps into crags.
      const rise = ease01((d - 0.8) / 4.2);
      const r0 = 1 - Math.abs(2 * vnoise(173 + side * 7, u, d * 2.4, 12) - 1);
      const ridged = r0 * r0;
      const massif = vnoise(178 + side * 7, u, d, 34);
      const rough =
        (vnoise(177 + side * 7, u * 1.7, d * 1.7, 2.7) - 0.5) * 0.5 +
        (hash2(Math.round(u) * 31 + side, Math.round(d) * 57) - 0.5) * 0.25;
      const peak =
        0.45 + ridged * (1.8 + massif * 1.8) + (vnoise(174 + side * 7, u, d, 21) - 0.5) * 0.6 + rough;
      return -1.4 + (peak + 1.4) * rise;
    }
    // Forest: a wooded shore climbing into gentle rolling hills.
    const rise = ease01((d - 0.3) / 2.4);
    const roll =
      0.34 + (vnoise(175 + side * 7, u, d, 8) - 0.5) * 0.8 +
      (vnoise(176 + side * 7, u, d, 3.1) - 0.5) * 0.3;
    return -1.4 + (Math.max(roll, 0.1) + 1.4) * rise;
  }

  /** Bed color under open water, graded by depth like the terrain paint. */
  #bedColor(out: THREE.Color, y: number): void {
    out.copy(COL.bed).lerp(COL.water, Math.min(Math.max((-y - 0.2) * 1.4, 0), 1) * 0.75);
  }

  /** One style's ground color at (x, z), given its final height. */
  #styleColor(style: RimStyle, x: number, z: number, y: number, out: THREE.Color): void {
    if (style === 'sea' || y < -0.6) {
      this.#bedColor(out, y);
      return;
    }
    // The same three-scale meadow field the terrain paints with, so the
    // ground tone continues across the boundary instead of re-rolling.
    const m = vnoise(51, x, z, 9) * 0.5 + vnoise(53, x, z, 3.4) * 0.34 + vnoise(57, x, z, 1.2) * 0.16;
    if (style === 'ridge') {
      // Foothills keep some turf; the rock takes over with altitude, the
      // way the map's own peaks dry out of the meadow.
      if (m < 0.52) out.copy(COL.lush).lerp(COL.olive, m / 0.52);
      else out.copy(COL.olive).lerp(COL.gold, (m - 0.52) / 0.48);
      const rocky = Math.min(Math.max((y + 0.4) / 1.6, 0), 1) * 0.95;
      out.lerp(m < 0.5 ? COL.rock : COL.rockDark, rocky);
      // The skirt's snow line sits higher than the map's: only the
      // tallest crests cap out, so the range reads grey stone with white
      // crests instead of a snowfield.
      if (y > 2.3) out.lerp(COL.snow, Math.min((y - 2.3) / 0.5, 1) * 0.85);
      // Faked valley shade: feet dim, crests catch the light — the 1-tile
      // lattice's soft normals alone leave the relief unreadable.
      out.multiplyScalar(0.78 + 0.22 * Math.min(Math.max(y / 2.8, 0), 1));
    } else {
      if (m < 0.52) out.copy(COL.lush).lerp(COL.olive, m / 0.52);
      else out.copy(COL.olive).lerp(COL.gold, (m - 0.52) / 0.48);
      if (y > 0.9) out.lerp(m < 0.5 ? COL.rock : COL.rockDark, Math.min((y - 0.9) / 0.55, 1) * 0.9);
    }
    // Banks sink into dark moss near the waterline, like the map's own.
    if (y < 0.5) out.lerp(COL.moss, Math.min((0.5 - y) / 1.1, 0.8));
  }

  /**
   * Height at (x, z) with the vertex color written into `out`. Inside the
   * map the skirt tucks itself under the terrain mesh; across the first
   * couple of tiles beyond the edge it blends up from the map's own bed so
   * the seam hides under the water strip worldgen keeps on every border.
   */
  #surface(x: number, z: number, out: THREE.Color): number {
    const { ox, oz } = this.#overhang(x, z);
    if (ox === 0 && oz === 0) {
      const inset = Math.min(x, z, this.#size - x, this.#size - z);
      if (inset > 1.5) {
        // Deep interior: parked far below the bed, never visible.
        this.#bedColor(out, -2.5);
        return -2.5;
      }
      const y = this.#heights.at(x, z) - 0.15;
      this.#bedColor(out, y);
      return y;
    }

    const d = Math.hypot(ox, oz);
    const sides = this.#sides(x, z, ox, oz);
    let h = 0;
    for (const s of sides) h += this.#styleHeight(s.style, s.side, s.u, s.d) * s.w;

    // Feather up from the map's own edge bed over the first tiles out.
    const t = ease01(d / 2.2);
    const edgeY = this.#heights.at(x, z) - 0.15;
    const y = edgeY + (h - edgeY) * t;

    this.#styleColor(sides[0]!.style, x, z, y, out);
    if (sides.length === 2) {
      this.#styleColor(sides[1]!.style, x, z, y, SCRATCH2);
      out.lerp(SCRATCH2, sides[1]!.w);
    }
    this.#bedColor(SCRATCH2, edgeY);
    out.lerp(SCRATCH2, 1 - t);
    // The far field melts into the haze: the outer quarter of the skirt
    // fades to the fog color, so the horizon dissolves the same way at
    // every camera distance instead of ending on a cut edge.
    const ext = this.#ext;
    out.lerp(COL.fog, ease01((d - ext * 0.72) / (ext * 0.28)));
    return y;
  }

  /** Height only (for placing trees on the blended far field). */
  #heightOnly(x: number, z: number): number {
    return this.#surface(x, z, SCRATCH3);
  }

  /**
   * The forest continues as forest: instanced tree stands over every
   * skirt tile whose style mix is mostly forest belt, matching the in-map
   * groves' species and stature so the wall reads as one wood.
   */
  #plantTrees(): void {
    const size = this.#size;
    const ext = this.#ext;
    if (!this.#styles.includes('forest')) return;

    const spots: { x: number; z: number; y: number; seed: number }[] = [];
    for (let tz = -ext; tz < size + ext; tz++) {
      for (let tx = -ext; tx < size + ext; tx++) {
        const cx = tx + 0.5;
        const cz = tz + 0.5;
        const { ox, oz } = this.#overhang(cx, cz);
        if (ox === 0 && oz === 0) continue;
        const d = Math.hypot(ox, oz);
        // No stands past the haze line — a crisp tree on fog-melted ground
        // would give the fade away.
        if (d < 1.4 || d > ext * 0.72) continue;
        let forestW = 0;
        for (const s of this.#sides(cx, cz, ox, oz)) {
          if (s.style === 'forest') forestW += s.w;
        }
        if (forestW < 0.6) continue;
        const seed = (tz + ext) * (size + 2 * ext) + (tx + ext);
        // Denser than the in-map scatter reads from afar; thins with
        // distance so the far field softens toward the fog.
        if (hash2(seed, 61) > 0.55 - (d / ext) * 0.18) continue;
        const jx = 0.15 + hash2(seed, 62) * 0.7;
        const jz = 0.15 + hash2(seed, 63) * 0.7;
        const x = tx + jx;
        const z = tz + jz;
        const y = this.#heightOnly(x, z);
        if (y < 0.12) continue; // no trees standing in a bay
        spots.push({ x, z, y, seed });
      }
    }
    if (spots.length === 0) return;

    const dummy = new THREE.Object3D();
    const tint = new THREE.Color();
    const trees = glbTrees();
    if (trees) {
      const perSpecies: number[][] = trees.geometries.map(() => []);
      spots.forEach((spot, i) => {
        perSpecies[(hash2(spot.seed, 11) * perSpecies.length) | 0]!.push(i);
      });
      trees.geometries.forEach((geo, si) => {
        const ids = perSpecies[si]!;
        if (ids.length === 0) return;
        const mesh = new THREE.InstancedMesh(geo, trees.material, ids.length);
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        ids.forEach((spotIdx, k) => {
          const spot = spots[spotIdx]!;
          const h = 1.1 + hash2(spot.seed, 3) * 0.9;
          dummy.position.set(spot.x, spot.y, spot.z);
          dummy.rotation.set(0, hash2(spot.seed, 4) * Math.PI * 2, 0);
          dummy.scale.set(h * (0.8 + hash2(spot.seed, 5) * 0.35), h, h * (0.8 + hash2(spot.seed, 5) * 0.35));
          dummy.updateMatrix();
          mesh.setMatrixAt(k, dummy.matrix);
          const warm = hash2(spot.seed, 6);
          tint.setHex(0xffffff).lerp(
            TREE_TINT.setHex(warm > 0.85 ? 0xc8a050 : 0x6a8f4a),
            warm > 0.85 ? 0.35 : warm * 0.22,
          );
          mesh.setColorAt(k, tint);
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        this.group.add(mesh);
      });
      return;
    }

    // No GLB pack: stylized crown-on-trunk stand-ins, tinted with the
    // foliage palette. Coarser than the in-map stalks, but they only ever
    // appear at rim distance, half-lost in the haze.
    const trunk = new THREE.CylinderGeometry(0.06, 0.09, 0.5, 5);
    trunk.translate(0, 0.25, 0);
    const crown = new THREE.ConeGeometry(0.55, 1.6, 6);
    crown.translate(0, 1.2, 0);
    const geo = mergeGeometries([trunk, crown]);
    const mesh = new THREE.InstancedMesh(
      geo,
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      spots.length,
    );
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    spots.forEach((spot, k) => {
      const h = 1.1 + hash2(spot.seed, 3) * 0.9;
      dummy.position.set(spot.x, spot.y, spot.z);
      dummy.rotation.set(0, hash2(spot.seed, 4) * Math.PI * 2, 0);
      dummy.scale.set(h * 0.9, h, h * 0.9);
      dummy.updateMatrix();
      mesh.setMatrixAt(k, dummy.matrix);
      tint.setHex(palette.leaf).lerp(TREE_TINT.setHex(palette.leafDark), hash2(spot.seed, 6) * 0.6);
      mesh.setColorAt(k, tint);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
  }
}

/** Palette colors used by the skirt painter, built once. */
const COL = {
  lush: new THREE.Color(palette.grassLush),
  olive: new THREE.Color(palette.grassOlive),
  gold: new THREE.Color(palette.grassGold),
  moss: new THREE.Color(palette.bankMoss),
  bed: new THREE.Color(palette.riverbed),
  water: new THREE.Color(palette.water),
  rock: new THREE.Color(palette.rock),
  rockDark: new THREE.Color(palette.rockDark),
  snow: new THREE.Color(palette.peakSnow),
  fog: new THREE.Color(palette.fog),
};
const SCRATCH2 = new THREE.Color();
const SCRATCH3 = new THREE.Color();
const TREE_TINT = new THREE.Color();
