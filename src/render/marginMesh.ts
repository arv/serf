import * as THREE from 'three';
import { hash2 } from '../shared/math';
import { tileIdx } from '../shared/grid';
import { Terrain, TileResource, playMax, playMin, type MapView } from '../sim/map';
import {
  bankMoss,
  fog,
  grassGold,
  grassLush,
  grassOlive,
  peakSnow,
  riverbed,
  rock,
  rockDark,
  water,
} from './palette';
import { vnoise } from './noise';
import { makeGroundTexture } from './groundTexture';
import type { HeightField } from './heightField';

/** Smoothstep of t clamped to [0, 1]. */
function ease01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/**
 * How far past the grid the horizon skirt reaches, as a fraction of the
 * playable side.
 *
 * The tile ring stops a quarter of a play side out (grid.ts), and a camera
 * in a screen corner at full zoom-out looks about half a play side past
 * the boundary — further on a wide window, since the frustum grows
 * sideways with the aspect while the zoom cap only bounds its height. So a
 * mesh that ended where the tiles end would put a cut edge in that corner.
 * The skirt covers the difference with no tiles at all: the border row's
 * own ground, carried outward and handed to the haze. Two fifths of the
 * play side is the corner cleared at 21:9 with tiles to spare, and it
 * costs a handful of rings — everything out there is flat, fully hazed,
 * and drawn at one vertex per dozen tiles.
 */
const HORIZON = 0.4;

/**
 * Where the skirt's vertex rings sit, as fractions of the reach. Bunched
 * against the grid, where the ground still carries its own color and the
 * ridgeline still reads, and stretched at the rim, which is flat haze and
 * needs no resolution at all.
 */
const SKIRT_RINGS = [0.05, 0.13, 0.25, 0.42, 0.66, 1] as const;

/**
 * How much of the skirt the melt takes: the far field is pure fog color
 * well before the rim, so the outermost rings are one flat sheet rather
 * than a fading edge with a silhouette of its own.
 */
const MELT_RUN = 0.7;

/**
 * How far inside the grid the melt starts, in tiles. The tile ring ends in
 * standing timber and open rock, and the skirt behind it carries neither —
 * beginning the haze a few tiles early puts the ground under the last of
 * the trees already going, so the treeline reads as a forest thinning into
 * the distance rather than as the line where the trees stop.
 */
const MELT_LEAD = 4;

/** How much of the skirt the settle takes — see borderProfiles. */
const SETTLE_RUN = 0.6;

/**
 * How far along a border the settle level is averaged, each way, in tiles.
 * Wide enough to swallow a lone crag between two sea tiles, narrow enough
 * that a bay is still a bay.
 */
const BORDER_SMOOTH = 6;

/**
 * The level each border settles to out in the skirt: its own row of the
 * grid, run through a box blur along the border. Four of them, indexed
 * north/east/south/west (worldgen's own side order); the north and south
 * profiles are read at x, the east and west ones at z.
 *
 * The skirt is the border row carried outward, and carried outward is all
 * it is: HeightField clamps, so a rim of alternating rock and sea extrudes
 * into thirty tiles of parallel stripes — land standing over open water
 * wherever the row happened to hold a crag. So it does not carry far. Over
 * the first half of the skirt the ground eases onto this profile, which
 * has the border's coastline and none of its comb; and the profile itself
 * eases to the side's own mean over the whole reach, so what is left at
 * the rim is one level per side — a sea rim under the water plane and gone
 * beneath it, a ridge rim at the range's own height. The further a horizon
 * runs, the less of anything it has to say: a coast still cutting inlets
 * thirty tiles out would be reading detail out of ground that is not
 * there.
 */
function borderProfiles(map: MapView): Float32Array[] {
  const size = map.size;
  const rows = [
    Float32Array.from({ length: size }, (_, i) => map.height[tileIdx(i, 0, size)]!),
    Float32Array.from({ length: size }, (_, i) => map.height[tileIdx(size - 1, i, size)]!),
    Float32Array.from({ length: size }, (_, i) => map.height[tileIdx(i, size - 1, size)]!),
    Float32Array.from({ length: size }, (_, i) => map.height[tileIdx(0, i, size)]!),
  ];
  return rows.map((row) => {
    const out = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      let sum = 0;
      for (let k = -BORDER_SMOOTH; k <= BORDER_SMOOTH; k++) {
        sum += row[Math.max(0, Math.min(size - 1, i + k))]!;
      }
      out[i] = sum / (2 * BORDER_SMOOTH + 1);
    }
    return out;
  });
}

/**
 * The vertex lattice, in world coordinates along one axis: one per tile
 * across the grid, then the skirt's rings out on either side.
 */
function lattice(size: number, reach: number): Float64Array {
  const rings = SKIRT_RINGS.length;
  const out = new Float64Array(size + 1 + 2 * rings);
  for (let i = 0; i < rings; i++) {
    out[i] = -SKIRT_RINGS[rings - 1 - i]! * reach;
    out[out.length - 1 - i] = size + SKIRT_RINGS[rings - 1 - i]! * reach;
  }
  for (let i = 0; i <= size; i++) out[rings + i] = i;
  return out;
}

/**
 * The scenery ring around the play square, plus the horizon behind it,
 * rendered from the same map tiles the sim carries — the grid is larger
 * than the playing area (Warcraft-style), and this mesh is the cheap half
 * of drawing it: one vertex per tile against the play mesh's six per tile
 * edge. Same heightfield, same palette, same paint formulas and detail
 * texture as the fine mesh, so the boundary between the two is a
 * resolution change, not a seam.
 *
 * Two things the plane it used to be did not do. The ground under the
 * play mesh is no longer drawn at all — those quads were parked at y=-2.5
 * where nothing could ever see them, and they were half the mesh — only
 * the tuck along the boundary's inner side survives, which is the part
 * that has a job. And the surface runs on past the grid: the skirt
 * (HORIZON) carries the border row outward, settles it onto a level that
 * still has the border's coastline and none of its detail
 * (borderProfiles), and melts the whole of it into the fog color. So what
 * the tile ring no longer reaches, the horizon still covers, and no camera
 * meets a cut edge.
 *
 * Static by design — nothing in the margin ever changes.
 */
export class MarginMesh {
  readonly mesh: THREE.Mesh;

  constructor(map: MapView, heights: HeightField) {
    const size = map.size;
    const p0 = playMin(map);
    const p1 = playMax(map);
    const marginW = p0;
    const reach = Math.max(4, Math.round(map.play * HORIZON));
    const profiles = borderProfiles(map);
    const means = profiles.map((p) => p.reduce((a, b) => a + b, 0) / p.length);
    const grid = lattice(size, reach);
    const n = grid.length;

    const positions = new Float32Array(n * n * 3);
    const uvs = new Float32Array(n * n * 2);
    const colors = new Float32Array(n * n * 3);
    /** Vertices parked under the play mesh: no quad of their own is drawn. */
    const buried = new Uint8Array(n * n);
    const c = SCRATCH;
    for (let iz = 0; iz < n; iz++) {
      const z = grid[iz]!;
      for (let ix = 0; ix < n; ix++) {
        const x = grid[ix]!;
        const v = iz * n + ix;
        // Distance past the play rect (0 inside it).
        const ox = x < p0 ? p0 - x : x > p1 ? x - p1 : 0;
        const oz = z < p0 ? p0 - z : z > p1 ? z - p1 : 0;
        const d = Math.hypot(ox, oz);

        let y: number;
        if (d === 0) {
          const inset = Math.min(x - p0, z - p0, p1 - x, p1 - z);
          if (inset > 1.5) {
            // Deep under the play mesh: parked below any bed, never visible
            // — and, buried, never given a quad to be invisible on.
            y = -2.5;
            buried[v] = 1;
            this.#bedColor(c, y);
          } else {
            // Under-terrain tuck along the boundary's inner side. Painted
            // with the real tile paint, NOT the bed: boundary vertices are
            // shared by the first visible margin triangles, and a riverbed
            // tint here bled a dark seam along the join on land borders.
            y = heights.at(x, z) - 0.15;
            this.#paint(map, x, z, y, 0, c);
          }
        } else {
          // The margin's real ground — and, past the grid, the skirt, which
          // is the same call: HeightField and the tile lookups both clamp,
          // so the border row simply carries on outward.
          //
          // The tuck fades to near-flush within the first tile out — carried
          // further it ran along the whole border as a shadowed ledge line.
          y = heights.at(x, z) - 0.15 + 0.13 * ease01(d / 1.2);
          this.#paint(map, x, z, y, d, c);
          // Past the grid: how far out, and past which side (both, in a
          // corner, weighted by how far past each).
          const gx = x < 0 ? -x : x > size ? x - size : 0;
          const gz = z < 0 ? -z : z > size ? z - size : 0;
          const out = Math.hypot(gx, gz);
          if (out > 0) {
            const px = Math.max(0, Math.min(size - 1, Math.floor(x)));
            const pz = Math.max(0, Math.min(size - 1, Math.floor(z)));
            const sx = x < 0 ? 3 : 1;
            const sz = z < 0 ? 0 : 2;
            const flat = ease01(out / reach);
            const lx = profiles[sx]![pz]! + (means[sx]! - profiles[sx]![pz]!) * flat;
            const lz = profiles[sz]![px]! + (means[sz]! - profiles[sz]![px]!) * flat;
            const w = gx / (gx + gz);
            const level = gx > 0 ? (gz > 0 ? lx * w + lz * (1 - w) : lx) : lz;
            y += (level - y) * ease01(out / (reach * SETTLE_RUN));
          }
          // The far field melts into the haze, and is gone into it before
          // the rim (dry land only — a pale-faded bed under the
          // semi-transparent sea reads as a milky sheet).
          if (y > -0.3) {
            c.lerp(COL.fog, ease01((d - marginW + MELT_LEAD) / (reach * MELT_RUN)));
          }
        }
        positions[v * 3] = x;
        positions[v * 3 + 1] = y;
        positions[v * 3 + 2] = z;
        // The plane's own UVs, kept to the letter: the detail texture
        // repeats size/4 times across the grid either way, so the pattern
        // stays in phase with the fine mesh — and runs off the edge into
        // the skirt, which is what RepeatWrapping is for.
        uvs[v * 2] = x / size;
        uvs[v * 2 + 1] = 1 - z / size;
        const s = 0.92 + hash2(v, 977) * 0.16;
        colors[v * 3] = c.r * s;
        colors[v * 3 + 1] = c.g * s;
        colors[v * 3 + 2] = c.b * s;
      }
    }

    // Quads, skipping any whose four corners are all buried.
    const index: number[] = [];
    for (let iz = 0; iz < n - 1; iz++) {
      for (let ix = 0; ix < n - 1; ix++) {
        const a = iz * n + ix;
        const b = a + n;
        if (buried[a] && buried[a + 1] && buried[b] && buried[b + 1]) continue;
        index.push(a, b, b + 1, a, b + 1, a + 1);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(index);
    geometry.computeVertexNormals();

    this.mesh = new THREE.Mesh(
      geometry,
      // The same blade-speckle detail texture the fine mesh multiplies over
      // its paint, at the same four-tiles-per-repeat density — and, through
      // the UVs above, in the same phase across the boundary.
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
  lush: new THREE.Color(grassLush),
  olive: new THREE.Color(grassOlive),
  gold: new THREE.Color(grassGold),
  moss: new THREE.Color(bankMoss),
  bed: new THREE.Color(riverbed),
  water: new THREE.Color(water),
  rock: new THREE.Color(rock),
  rockDark: new THREE.Color(rockDark),
  snow: new THREE.Color(peakSnow),
  fog: new THREE.Color(fog),
};
const SCRATCH = new THREE.Color();
