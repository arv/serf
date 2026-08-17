import * as THREE from 'three';
import { hash2 } from '../shared/math';
import { tileIdx } from '../shared/grid';
import { Terrain, TileResource, playMax, playMin, type MapView } from '../sim/map';
import { palette } from './palette';
import { vnoise } from './noise';
import { makeGroundTexture } from './groundTexture';
import type { HeightField } from './heightField';

/** Smoothstep of t clamped to [0, 1]. */
function ease01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/**
 * The scenery ring around the play square, rendered from the same map
 * tiles the sim carries — the grid is larger than the playing area
 * (Warcraft-style), and this mesh is simply the cheap half of drawing it:
 * one vertex per tile against the play mesh's six per tile edge, which is
 * what keeps a 2x grid inside the terrain budget. Same heightfield, same
 * palette, same paint formulas and detail texture as the fine mesh, so
 * the boundary between the two is a resolution change, not a seam; the
 * ring's outer quarter melts into the fog color so no camera ever meets
 * a cut edge. Static by design — nothing in the margin ever changes.
 */
export class MarginMesh {
  readonly mesh: THREE.Mesh;

  constructor(map: MapView, heights: HeightField) {
    const size = map.size;
    const p0 = playMin(map);
    const p1 = playMax(map);
    const marginW = p0;
    const geometry = new THREE.PlaneGeometry(size, size, size, size);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(size / 2, 0, size / 2);

    const pos = geometry.attributes.position!;
    const colors = new Float32Array(pos.count * 3);
    const c = SCRATCH;
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v);
      const z = pos.getZ(v);
      // Distance past the play rect (0 inside it).
      const ox = x < p0 ? p0 - x : x > p1 ? x - p1 : 0;
      const oz = z < p0 ? p0 - z : z > p1 ? z - p1 : 0;
      const d = Math.hypot(ox, oz);

      let y: number;
      if (d === 0) {
        const inset = Math.min(x - p0, z - p0, p1 - x, p1 - z);
        if (inset > 1.5) {
          // Deep under the play mesh: parked below any bed, never visible.
          y = -2.5;
          this.#bedColor(c, y);
        } else {
          // Under-terrain tuck along the boundary's inner side.
          y = heights.at(x, z) - 0.15;
          this.#bedColor(c, y);
        }
      } else {
        // The margin's real ground. The tuck fades to near-flush within
        // the first tile out — carried further it ran along the whole
        // border as a shadowed ledge line.
        y = heights.at(x, z) - 0.15 + 0.13 * ease01(d / 1.2);
        this.#paint(map, x, z, y, d, c);
        // The far field melts into the haze (dry land only — a pale-faded
        // bed under the semi-transparent sea reads as a milky sheet).
        if (y > -0.3) c.lerp(COL.fog, ease01((d - marginW * 0.7) / (marginW * 0.3)));
      }
      pos.setY(v, y);
      const s = 0.92 + hash2(v, 977) * 0.16;
      colors[v * 3] = c.r * s;
      colors[v * 3 + 1] = c.g * s;
      colors[v * 3 + 2] = c.b * s;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();

    this.mesh = new THREE.Mesh(
      geometry,
      // The same blade-speckle detail texture the fine mesh multiplies over
      // its paint, at the same four-tiles-per-repeat density (the margin is
      // a whole number of repeats wide, so the pattern stays in phase
      // across the boundary).
      new THREE.MeshLambertMaterial({ vertexColors: true, map: makeGroundTexture(size) }),
    );
    this.mesh.receiveShadow = true;
  }

  /** Bed color under open water, graded by depth like the terrain paint. */
  #bedColor(out: THREE.Color, y: number): void {
    out.copy(COL.bed).lerp(COL.water, Math.min(Math.max((-y - 0.2) * 1.4, 0), 1) * 0.75);
  }

  /**
   * Ground color from the real tile under (x, z) — the fine mesh's own
   * formulas, with two far-field rules (a higher snow line and a faked
   * valley shade) eased in over the first tiles so no rule change ever
   * lands exactly on the boundary as a line.
   */
  #paint(map: MapView, x: number, z: number, y: number, d: number, out: THREE.Color): void {
    const size = map.size;
    // The same boundary warp the fine mesh samples through, so the class
    // edges wander across the seam instead of restarting at it.
    const tx = Math.max(0, Math.min(size - 1, Math.floor(x + (vnoise(41, x, z, 2.1) - 0.5) * 1.1)));
    const tz = Math.max(0, Math.min(size - 1, Math.floor(z + (vnoise(43, x, z, 2.1) - 0.5) * 1.1)));
    const tile = tileIdx(tx, tz, size);
    const terrain = map.terrain[tile];

    if (terrain === Terrain.Water || y < -0.6) {
      this.#bedColor(out, y);
      return;
    }
    const m =
      vnoise(51, x, z, 9) * 0.5 + vnoise(53, x, z, 3.4) * 0.34 + vnoise(57, x, z, 1.2) * 0.16;
    if (m < 0.52) out.copy(COL.lush).lerp(COL.olive, m / 0.52);
    else out.copy(COL.olive).lerp(COL.gold, (m - 0.52) / 0.48);
    if (terrain === Terrain.Rock) {
      const rockCol = m < 0.5 ? COL.rock : COL.rockDark;
      out.lerp(rockCol, 0.45);
      if (y > 0.9) out.lerp(rockCol, Math.min((y - 0.9) / 0.55, 1) * 0.9);
      // The snow line climbs from the map's 1.95 at the seam to 2.3 in the
      // far field (a whole horizon parked above the line read as one
      // snowfield); the valley shade — feet dim, crests catch the light —
      // eases in the same way.
      const settle = ease01(d / 8);
      const snowLine = 1.95 + 0.35 * settle;
      if (y > snowLine) out.lerp(COL.snow, Math.min((y - snowLine) / 0.45, 1) * 0.85);
      out.multiplyScalar(1 - 0.22 * (1 - Math.min(Math.max(y / 2.8, 0), 1)) * ease01(d / 6));
    } else {
      if (y > 0.9) out.lerp(m < 0.5 ? COL.rock : COL.rockDark, Math.min((y - 0.9) / 0.55, 1) * 0.9);
      if (map.resource[tile] === TileResource.Wood) {
        // Forest floor under the margin's solid timber: shaded toward
        // moss so gaps between crowns read as canopy, eased in from the
        // seam where the playable belt's own ground has no such shade.
        out.lerp(COL.moss, (0.34 + (vnoise(59, x, z, 5) - 0.5) * 0.24) * ease01(d / 5));
      }
    }
    // Banks sink into dark moss near the waterline, like the map's own.
    if (y < 0.5) out.lerp(COL.moss, Math.min((0.5 - y) / 1.1, 0.8));
  }
}

/** Palette colors used by the margin painter, built once. */
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
const SCRATCH = new THREE.Color();
