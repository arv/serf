import * as THREE from 'three';
import {tileCount, tileIdx, tileX, tileY} from '../shared/grid';
import type {MapView} from '../sim/map';
import * as PathLevel from '../sim/pathLevelEnum.ts';
import type {HeightField} from './heightField';
import {ribbonCover, type RibbonCover} from './pathRibbon';
import {makeCobbleTexture} from './roadTexture';

/** Sub-quads per tile edge: how finely the paving follows the road's edge. */
const SUB = 6;
/** World tiles per texture repeat — sets the size of a single stone. */
const UV_TILES = 1.6;
/** Lift above the terrain, small enough to read as the same surface. */
const LIFT = 0.02;
/**
 * Stones stop a little short of the painted band's edge, so a road ends in
 * a fringe of trodden dirt rather than a hard cut line of masonry: stone
 * alpha hits zero while the band's coverage is still STONE_CUT, and ramps
 * to solid over the next STONE_RAMP of coverage.
 */
const STONE_CUT = 0.18;
const STONE_RAMP = 0.5;

const cover: RibbonCover = {trail: 0, road: 0};

/**
 * The paving on a stone road: a decal skin laid over the terrain wherever a
 * road ribbon runs, carrying a flagstone texture.
 *
 * The terrain mesh paints the road band itself, but it is a vertex-colored
 * surface — at its resolution a stone is a couple of vertices across and no
 * amount of painting will read as masonry. Cobbles need texels, so the
 * stonework rides on its own geometry: only the tiles a road touches, cut to
 * the same wobbling ribbon by per-vertex alpha, textured in world space so
 * the courses run continuously from tile to tile instead of restarting at
 * every border.
 */
export class RoadDecal {
  readonly mesh: THREE.Mesh;
  #heights: HeightField;
  #geometry = new THREE.BufferGeometry();

  constructor(map: MapView, heights: HeightField) {
    this.#heights = heights;
    const material = new THREE.MeshLambertMaterial({
      map: makeCobbleTexture(),
      vertexColors: true,
      transparent: true,
      // Depth-tested against the world but not written: the decal is a skin
      // on the ground, and nothing should sort against it.
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(this.#geometry, material);
    this.mesh.receiveShadow = true;
    this.rebuild(map);
  }

  /** Regenerate the paving from the map's current road tiles. */
  rebuild(map: MapView): void {
    const size = map.size;
    // Every tile a road's ribbon can reach: the road tiles and their ring,
    // since the wobble carries the band a little past its own tile.
    const candidates = new Set<number>();
    for (let i = 0; i < tileCount(size); i++) {
      if (map.pathLevel[i] !== PathLevel.Road) continue;
      const x = tileX(i, size);
      const y = tileY(i, size);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          candidates.add(tileIdx(nx, ny, size));
        }
      }
    }

    const positions: number[] = [];
    const uvs: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const alpha = new Float32Array((SUB + 1) * (SUB + 1));

    for (const tile of candidates) {
      const ox = tileX(tile, size);
      const oy = tileY(tile, size);

      let any = false;
      for (let r = 0; r <= SUB; r++) {
        for (let c = 0; c <= SUB; c++) {
          const px = ox + c / SUB;
          const pz = oy + r / SUB;
          ribbonCover(map.pathLevel, px, pz, cover);
          const a = Math.min(
            Math.max((cover.road - STONE_CUT) / STONE_RAMP, 0),
            1,
          );
          alpha[r * (SUB + 1) + c] = a;
          if (a > 0) any = true;
        }
      }
      if (!any) continue;

      const base = positions.length / 3;
      for (let r = 0; r <= SUB; r++) {
        for (let c = 0; c <= SUB; c++) {
          const px = ox + c / SUB;
          const pz = oy + r / SUB;
          positions.push(px, this.#heights.at(px, pz) + LIFT, pz);
          uvs.push(px / UV_TILES, pz / UV_TILES);
          colors.push(1, 1, 1, alpha[r * (SUB + 1) + c]!);
        }
      }
      for (let r = 0; r < SUB; r++) {
        for (let c = 0; c < SUB; c++) {
          const a = base + r * (SUB + 1) + c;
          const b = a + 1;
          const d = a + (SUB + 1);
          const e = d + 1;
          // Skip quads no stone reaches — most of a ring tile is bare grass.
          if (
            alpha[r * (SUB + 1) + c] === 0 &&
            alpha[r * (SUB + 1) + c + 1] === 0 &&
            alpha[(r + 1) * (SUB + 1) + c] === 0 &&
            alpha[(r + 1) * (SUB + 1) + c + 1] === 0
          ) {
            continue;
          }
          indices.push(a, d, b, b, d, e);
        }
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    this.mesh.geometry = geometry;
    this.#geometry.dispose();
    this.#geometry = geometry;
    this.mesh.visible = indices.length > 0;
  }
}
