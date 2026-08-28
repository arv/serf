import { Rng } from '../shared/rng.ts';
import { gridFor, inBounds, marginFor, tileCount, tileIdx } from '../shared/grid.ts';
import { hash2 } from '../shared/math.ts';
import { WOOD_MAX_AMT } from './defs/balance.ts';
import { buildingDef, BuildingTypeId } from './defs/buildings.ts';
import { buildingSight } from './visibility.ts';

import type { Enum } from '../shared/enum.ts';
import * as TerrainNs from './terrainEnum.ts';
import * as TileResourceNs from './tileResourceEnum.ts';
import * as PathLevelNs from './pathLevelEnum.ts';

export * as Terrain from './terrainEnum.ts';
export type TerrainKind = Enum<typeof TerrainNs>;
export * as TileResource from './tileResourceEnum.ts';
export type TileResourceKind = Enum<typeof TileResourceNs>;
export * as PathLevel from './pathLevelEnum.ts';
export type PathLevelKind = Enum<typeof PathLevelNs>;

/** Border styles an edge can draw (see the rim pass in generateMap). */
const RIM_SEA = 0;
const RIM_RIDGE = 1;
const RIM_FOREST = 2;
type RimStyle = typeof RIM_SEA | typeof RIM_RIDGE | typeof RIM_FOREST;

/**
 * The map as structure-of-arrays. Everything here is serializable typed-array
 * data; `blocked` is derived but cheap enough to keep in sync incrementally
 * (a full recompute exists for load).
 */
export interface GameMap {
  /** Full grid side length in tiles — per-game data, not a global. */
  size: number;
  /**
   * Playable side length: a `play`² square centered in the grid. The ring
   * around it is real, editable scenery — Warcraft-style, the world is
   * larger than the playing area — that nothing may walk, build, or
   * gather on. `recomputeBlocked` enforces the rule; play-rect helpers
   * below answer it.
   */
  play: number;
  terrain: Uint8Array;
  resource: Uint8Array;
  /** Remaining harvests for wood/rock; remaining ore for deposits. */
  resourceAmt: Uint8Array;
  /** 1 = not walkable (water, standing resources, building footprints). */
  blocked: Uint8Array;
  /** Building entity id occupying the tile, -1 if none. */
  buildingAt: Int16Array;
  /** Trail wear from foot traffic; decays. */
  wear: Float32Array;
  /** 0 grass, 1 dirt trail, 2 stone road. */
  pathLevel: Uint8Array;
  /**
   * Terrain elevation per tile (world units). Purely visual today — the sim
   * paths on the flat grid — but owned by worldgen so it's deterministic,
   * serialized, and could gain gameplay meaning later.
   */
  height: Float32Array;
}

/** The water plane's world y — terrain under water dips well below this. */
export const WATER_LEVEL = -0.3;

/**
 * The subset of map arrays the render/UI side mirrors — what terrain and
 * scatter rendering read. MapSnapshot in the protocol satisfies this shape.
 */
export type MapView = Pick<
  GameMap,
  'size' | 'play' | 'terrain' | 'resource' | 'blocked' | 'buildingAt' | 'pathLevel' | 'height'
>;

/** The play square's bounds and membership — one definition for sim and
 * renderer both, so "on the map" can never mean two different rectangles. */
export interface PlayArea {
  size: number;
  play: number;
}

/** First playable row/column (== the margin width). */
export function playMin(map: PlayArea): number {
  return (map.size - map.play) / 2;
}

/** One past the last playable row/column. */
export function playMax(map: PlayArea): number {
  return playMin(map) + map.play;
}

export function inPlayArea(map: PlayArea, x: number, y: number): boolean {
  const p0 = playMin(map);
  const p1 = p0 + map.play;
  return x >= p0 && y >= p0 && x < p1 && y < p1;
}

/** Chebyshev distance to the nearest play-area edge; negative outside it.
 * The play-rect twin of grid.ts's edgeDist, which measures the full grid. */
export function playEdgeDist(map: PlayArea, x: number, y: number): number {
  const p0 = playMin(map);
  const p1 = p0 + map.play;
  return Math.min(x - p0, y - p0, p1 - 1 - x, p1 - 1 - y);
}

/** Walking resources block movement; ore deposits are walkable rocky ground. */
export function resourceBlocks(res: number): boolean {
  return res === TileResourceNs.Wood || res === TileResourceNs.Rock;
}

/**
 * The landscape's share of walkability: only clear grass is walkable —
 * water and rim rock (TerrainNs.Rock) are terrain-blocked, standing wood and
 * stone are resource-blocked. THE rule, shared by recomputeBlocked,
 * destroyBuilding's footprint release, and the server's unexplored-tile
 * masking, so the three can never drift apart. (Building footprints are
 * the one other blocker, layered on by the callers that know about them.)
 */
export function tileBlocks(terrain: number, res: number): boolean {
  return terrain !== TerrainNs.Grass || resourceBlocks(res);
}

/** A gather recipe's resource name, as the tile code the map stores. */
/**
 * Nearest tile a gatherer can work, searched outward in rings to `radius`.
 *
 * This is the search the resident worker runs at the start of every trip —
 * and, run against a prospective footprint's center, the placement rule that
 * refuses a woodcutter with no trees in reach. One function, so a hut can
 * never be legal to build in a spot where its worker would stand idle.
 *
 * `resourceAmt` is sim-only (the mirrored MapView carries no amounts), but a
 * tile worked dry has its resource code cleared as well, so the code alone
 * answers the question on the render side.
 */
export function findResourceNear(
  map: MapView & { resourceAmt?: ArrayLike<number> },
  cx: number,
  cy: number,
  code: TileResourceKind,
  radius: number,
): number {
  // A direct scan rather than findResourcesNear(..., 1): this runs under
  // canPlace on every build-cursor move, and the single answer should not
  // buy an array per frame. The twin below must keep walking the same
  // rings in the same order — the gather loop's first candidate has to be
  // exactly this function's answer.
  for (let r = 1; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        // Play-area only: the margin's timber is scenery, and a hut by the
        // border must not send its worker at trees no one can reach.
        if (!inPlayArea(map, x, y)) continue;
        const i = tileIdx(x, y, map.size);
        if (map.resource[i] !== code) continue;
        if (map.resourceAmt && map.resourceAmt[i]! <= 0) continue;
        return i;
      }
    }
  }
  return -1;
}

/**
 * The nearest workable tiles in ring order, up to `limit` of them. The
 * gather loop asks for a handful rather than one: the nearest tile can be
 * permanently unreachable — a tree walled in by its own grove, a seam tile
 * pinched shut by construction — and a worker that only ever retries the
 * nearest starves in front of workable ground it could have walked to
 * (see gatherStep in systems/production.ts).
 */
export function findResourcesNear(
  map: MapView & { resourceAmt?: ArrayLike<number> },
  cx: number,
  cy: number,
  code: TileResourceKind,
  radius: number,
  limit: number,
): number[] {
  const out: number[] = [];
  for (let r = 1; r <= radius && out.length < limit; r++) {
    for (let dy = -r; dy <= r && out.length < limit; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (!inPlayArea(map, x, y)) continue;
        const i = tileIdx(x, y, map.size);
        if (map.resource[i] !== code) continue;
        if (map.resourceAmt && map.resourceAmt[i]! <= 0) continue;
        out.push(i);
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

/**
 * Everything the ground inside a gatherer's reach still holds, summed —
 * the number of loads that hut, quarry or mine can still take out of it
 * wherever it stands.
 *
 * Walks the same square, in the same play-area-only terms, as the two
 * searches above: what this counts is exactly what they will hand a
 * worker, so the readout on the card can never promise a harvest the
 * gather loop refuses to make. (The center tile is the footprint's own
 * and holds nothing; the searches skip it by starting at r = 1.)
 */
export function countResourceNear(
  map: PlayArea & { resource: ArrayLike<number>; resourceAmt: ArrayLike<number> },
  cx: number,
  cy: number,
  code: TileResourceKind,
  radius: number,
): number {
  let total = 0;
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (x === cx && y === cy) continue;
      if (!inPlayArea(map, x, y)) continue;
      const i = tileIdx(x, y, map.size);
      if (map.resource[i] === code) total += map.resourceAmt[i]!;
    }
  }
  return total;
}

/** A faction's home: storehouse footprint origin tile. */
export interface StartSpot {
  x: number;
  y: number;
}

/**
 * Plateau/flood anchor tile of a start: the tile just past the middle of
 * the 3x3 castle (whose footprint runs s.x..s.x+2). Half a tile off the
 * true center on each axis, which does not matter to the wide distance
 * bands that use it — anything measured against what the player can *see*
 * wants `castleCenter` instead.
 */
function anchorOf(s: StartSpot): { x: number; y: number } {
  return { x: s.x + 2, y: s.y + 2 };
}

/**
 * The point the castle's sight circle is stamped from — the same
 * `b.x + b.w / 2` that visibility and the renderer's fog both use, so a
 * radius measured from here means what it means on screen.
 */
function castleCenter(s: StartSpot): { x: number; y: number } {
  const def = buildingDef(BuildingTypeId.storehouse);
  return { x: s.x + def.w / 2, y: s.y + def.h / 2 };
}

/**
 * How far a castle's own light reaches at tick zero, as the player sees
 * it. `buildingSight` is what the sim lights and the server sends; the
 * renderer feathers that circle out over a rim and only draws the inner
 * part, so worldgen holds itself a tile inside the nominal radius rather
 * than promising stone that arrives as fog.
 */
export const CASTLE_OPENING_SIGHT =
  buildingSight(
    BuildingTypeId.storehouse,
    buildingDef(BuildingTypeId.storehouse).w,
    buildingDef(BuildingTypeId.storehouse).h,
  ) - 1;

/**
 * How far from home (castle center, tile-center metric) worldgen promises
 * fishable water — a pond, a lake, or the sea itself. Enforced by the
 * water-access audit in computeTerrain, which carves a pond for any start
 * the noise left dry.
 */
export const WATER_ACCESS_RADIUS = 16;

/** Smoothstep of t clamped to [0, 1]. */
function ease01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/**
 * `starts` are grid coordinates (world.ts lays seats out inside the play
 * square); `play` is the playable side — the grid is derived from it, and
 * everything outside the centered play square is generated as scenery:
 * each border's style continued outward as real tiles.
 */
export function generateMap(rng: Rng, starts: readonly StartSpot[], play: number): GameMap {
  const size = gridFor(play);
  const margin = marginFor(play);
  const tiles = tileCount(size);
  const map: GameMap = {
    size,
    play,
    terrain: new Uint8Array(tiles),
    resource: new Uint8Array(tiles),
    resourceAmt: new Uint8Array(tiles),
    blocked: new Uint8Array(tiles),
    buildingAt: new Int16Array(tiles).fill(-1),
    wear: new Float32Array(tiles),
    pathLevel: new Uint8Array(tiles),
    height: new Float32Array(tiles),
  };
  const p0 = margin;
  const p1 = margin + play;
  const heightSeed = rng.int(0x7fffffff);

  // The rim: each edge draws its own border style from the seed — open sea,
  // an impassable mountain ridge, or a deep (choppable) forest belt — so
  // maps stop being the same island every game. One side is forced to sea:
  // the fishery's price is tuned against real shoreline, and the AI's
  // fishery step wants honest coast to anchor on. Five draws, always, so
  // the rng stream stays aligned whatever the styles come out as.
  const seaSide = rng.int(4);
  const rimStyles = [rng.int(3), rng.int(3), rng.int(3), rng.int(3)] as RimStyle[];
  rimStyles[seaSide] = RIM_SEA;

  // Irregular rim depth: two scales of wander. Per-edge-position jitter
  // (rng, one smoothing pass — the two-pass original averaged the band
  // nearly straight) rides on a long hash-driven meander a few dozen tiles
  // across, so the border swings in and out in bays and headlands instead
  // of holding one depth. The band is measured from the PLAY boundary: the
  // grid continues past it, but the ring beyond is scenery — the camera
  // stays inside the play square (Warcraft-style), and this band is all
  // the breathing room the border gets. The smoothing wraps around the
  // whole perimeter, which is also what keeps the band's depth continuous
  // where two styles meet at a corner.
  const fringe = Math.max(1, Math.floor(play / 24));
  const perimeter = play * 4;
  const smoothLoop = (arr: Float32Array): void => {
    for (let i = 0; i < arr.length; i++) {
      const prev = arr[(i + arr.length - 1) % arr.length]!;
      const next = arr[(i + 1) % arr.length]!;
      arr[i] = (prev + arr[i]! * 2 + next) / 4;
    }
  };
  const wobble = new Float32Array(perimeter);
  for (let i = 0; i < wobble.length; i++) wobble[i] = rng.range(0, fringe);
  smoothLoop(wobble);
  // 1D value noise around the perimeter — hash2 off heightSeed, no rng
  // draws, so the stream downstream of the rim stays aligned draw for
  // draw whatever the meander does.
  const meander = (salt: number, p: number, wavelength: number): number => {
    const cells = Math.max(4, Math.round(perimeter / wavelength));
    const f = ((p % perimeter) / perimeter) * cells;
    const i0 = Math.floor(f);
    const t = f - i0;
    const s = t * t * (3 - 2 * t);
    const a = hash2(heightSeed + salt, i0 % cells);
    const b = hash2(heightSeed + salt, (i0 + 1) % cells);
    return a + (b - a) * s;
  };

  // Ridge profile (0 = no rim rock, 1 = outermost rock row), fed into
  // computeTerrain so the heightfield raises the range under the rock.
  const rimRamp = new Float32Array(tiles);
  // Forest-belt tiles: 1 = full belt, 2 = ragged inner treeline row.
  const beltMask = new Uint8Array(tiles);

  // --- The rim, inside the play square -----------------------------------
  // Only a SEA edge carries open water; a ridge or forest edge runs its
  // rock or timber to the very last playable row, and the margin beyond
  // continues it — no moat, no channel: the border and the horizon are one
  // landscape.
  for (let y = p0; y < p1; y++) {
    for (let x = p0; x < p1; x++) {
      // Which play edge is nearest determines which wobble entry applies.
      const px = x - p0;
      const py = y - p0;
      const dists = [py, play - 1 - px, play - 1 - py, px]; // N, E, S, W
      let side = 0;
      for (let s = 1; s < 4; s++) if (dists[s]! < dists[side]!) side = s;
      const along = side % 2 === 0 ? px : py;
      const p = side * play + along;
      const i = tileIdx(x, y, size);
      // Band depth: base + jitter + meander, capped so the rim never eats
      // more than 3x its base into the playfield — and never less than the
      // base, which the blocked-band contract leans on. Per-tile teeth
      // (hash2, not rng — draw counts must not depend on geometry) fray
      // the band's inner edge on top of both.
      const tooth = hash2(i, 211);
      const depth =
        fringe +
        Math.min(wobble[p]! + meander(1, p, play / 5) * fringe * 1.2, 2 * fringe) +
        (tooth < 0.2 ? 2 : tooth < 0.5 ? 1 : 0);
      const d = dists[side]!;
      if (d >= depth) continue;
      switch (rimStyles[side]!) {
        case RIM_SEA:
          // Sea to the band's inner edge: the coast is that edge, already
          // frayed by the wobble, the meander, and the per-tile teeth in
          // `depth` above.
          map.terrain[i] = TerrainNs.Water;
          break;
        case RIM_RIDGE: {
          // The ramp peaks at the play boundary and slopes inland over the
          // band — modulated along the edge, because a full-strength ramp
          // at d=0 in every column put one constant crest along the whole
          // border, a ruler-straight snowy wall.
          map.terrain[i] = TerrainNs.Rock;
          const crest = 0.62 + meander(9, p, play / 9) * 0.5 + (hash2(i, 251) - 0.5) * 0.24;
          rimRamp[i] = Math.min(1, ((depth - d) / depth) * crest);
          break;
        }
        case RIM_FOREST:
          // Terrain stays grass; the trees are planted after the
          // heightfield settles, so lakes and drowning have their say.
          beltMask[i] = depth - d <= 1 ? 2 : 1;
          break;
      }
    }
  }

  // --- The margin: each border's style, continued as real tiles ----------
  // Up to two sides claim a margin tile, weighted by how far past each
  // edge it sits; the weight is eased through the middle so corners morph
  // along a coastline instead of averaging a sea bed against rising land.
  // `u` runs along the owning edge and `d` outward from it — the ridge
  // height field is anisotropic in those axes (ranges parallel the border,
  // like every real border range in the game).
  const marginMix = (x: number, y: number): { side: number; w: number; u: number; d: number }[] => {
    const ox = x < p0 ? p0 - x : x >= p1 ? x - (p1 - 1) : 0;
    const oy = y < p0 ? p0 - y : y >= p1 ? y - (p1 - 1) : 0;
    const out: { side: number; w: number; u: number; d: number }[] = [];
    const w = ease01((ox / (ox + oy) - 0.3) / 0.4);
    if (ox > 0) out.push({ side: x < p0 ? 3 : 1, w: oy > 0 ? w : 1, u: y, d: ox });
    if (oy > 0) out.push({ side: y < p0 ? 0 : 2, w: ox > 0 ? 1 - w : 1, u: x, d: oy });
    return out;
  };
  /** One style's far-field ground height, `d` tiles past the boundary. */
  const marginHeight = (side: number, u: number, d: number): number => {
    const style = rimStyles[side]!;
    if (style === RIM_SEA) return -1.5 - valueNoise(heightSeed + 71 + side, u, d, 6) * 0.5;
    if (style === RIM_RIDGE) {
      // Crest features stretch ~12 tiles along the edge but only ~5 across
      // it; the massif mask keeps whole stretches below the snow line so
      // the peaks read as ranges, not one white lace; the rough layer
      // breaks coarse-mesh lumps into crags.
      const s7 = heightSeed + side * 7;
      const r0 = 1 - Math.abs(2 * valueNoise(s7 + 173, u, d * 2.4, 12) - 1);
      const ridged = r0 * r0;
      const massif = valueNoise(s7 + 178, u, d, 34);
      const rough =
        (valueNoise(s7 + 177, u * 1.7, d * 1.7, 2.7) - 0.5) * 0.5 +
        (hash2(u * 31 + side, d * 57) - 0.5) * 0.25;
      return (
        0.45 + ridged * (1.8 + massif * 1.8) + (valueNoise(s7 + 174, u, d, 21) - 0.5) * 0.6 + rough
      );
    }
    // Forest: rolling wooded hills straight from the belt's last row.
    const s7 = heightSeed + side * 7;
    const roll =
      0.34 +
      (valueNoise(s7 + 175, u, d, 8) - 0.5) * 0.8 +
      (valueNoise(s7 + 176, u, d, 3.1) - 0.5) * 0.3;
    return Math.max(roll, 0.1);
  };
  // Terrain classes first (heights come after computeTerrain settles the
  // playfield): the dominant side decides what a margin tile IS.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inPlayArea(map, x, y)) continue;
      const mix = marginMix(x, y);
      let best = mix[0]!;
      for (const s of mix) if (s.w > best.w) best = s;
      const i = tileIdx(x, y, size);
      const style = rimStyles[best.side]!;
      if (style === RIM_SEA) map.terrain[i] = TerrainNs.Water;
      else if (style === RIM_RIDGE) map.terrain[i] = TerrainNs.Rock;
      // Forest margin stays grass here; computeTerrain may flood its
      // basins into coves, and the survivors take timber below.
    }
  }

  // Terrain shape before resources: basins flood into lakes, so clusters
  // must only ever land on the ground that survives. The belt mask rides
  // along so the water-access audit can refuse a bank the forest wall is
  // about to swallow.
  computeTerrain(map, heightSeed, starts, rimRamp, beltMask);

  // Margin heights, now that the playfield's are settled: the blended
  // far-field profile, tied to the boundary row's own height over the
  // first couple of tiles so the border crest and the horizon behind it
  // are one surface. Water keeps the bed computeTerrain shelved for it.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inPlayArea(map, x, y)) continue;
      const i = tileIdx(x, y, size);
      if (map.terrain[i] === TerrainNs.Water) continue;
      const mix = marginMix(x, y);
      let h = 0;
      let d = 0;
      for (const s of mix) {
        h += marginHeight(s.side, s.u, s.d) * s.w;
        d = Math.max(d, s.d);
      }
      const edgeH =
        map.height[
          tileIdx(Math.min(Math.max(x, p0), p1 - 1), Math.min(Math.max(y, p0), p1 - 1), size)
        ]!;
      let hh = edgeH + (h - edgeH) * ease01(d / 2.5);
      // Land behind a border may descend, but only gradually — a profile
      // valley landing right behind the crest read as a gutter line.
      hh = Math.max(hh, edgeH - d * 0.4);
      map.height[i] = hh;
    }
  }

  // The margin forest: every grass tile out there belongs to a forest
  // side (the other styles wrote rock or sea), and all of it stands in
  // full timber — the wall the playable belt leans against. Scenery: the
  // play-area rule keeps every axe away from it.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inPlayArea(map, x, y)) continue;
      const i = tileIdx(x, y, size);
      if (map.terrain[i] !== TerrainNs.Grass || map.resource[i] !== TileResourceNs.None) continue;
      map.resource[i] = TileResourceNs.Wood;
      map.resourceAmt[i] = WOOD_MAX_AMT;
    }
  }

  // Plant the border forest, now that the ground under it is final: every
  // belt tile still grass gets standing wood at full amount, so regrowth
  // keeps the un-felled wall topped up — a deep timber reserve that IS
  // choppable (tunneling out is a strategy, not a bug). hash2 rather than
  // rng on purpose: the number of draws must not depend on which styles
  // the sides drew, or every downstream draw would shift.
  for (let i = 0; i < tiles; i++) {
    if (!beltMask[i] || map.terrain[i] !== TerrainNs.Grass) continue;
    if (map.resource[i] !== TileResourceNs.None) continue;
    // The inner treeline thins out so the wall ends ragged, not ruled.
    if (beltMask[i] === 2 && hash2(i, heightSeed) < 0.55) continue;
    map.resource[i] = TileResourceNs.Wood;
    map.resourceAmt[i] = WOOD_MAX_AMT;
  }

  /** Returns how many tiles were actually written — a center inside an
   * existing grove or against water can yield zero, and callers that
   * guarantee a resource must know to try elsewhere. */
  const placeCluster = (
    res: TileResourceKind,
    amt: number,
    cx: number,
    cy: number,
    radius: number,
    density: number,
  ): number => {
    let placed = 0;
    const r = Math.ceil(radius);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!inPlayArea(map, x, y)) continue;
        if (dx * dx + dy * dy > radius * radius) continue;
        const i = tileIdx(x, y, size);
        if (map.terrain[i] !== TerrainNs.Grass || map.resource[i] !== TileResourceNs.None) continue;
        if (rng.next() > density) continue;
        map.resource[i] = res;
        map.resourceAmt[i] = amt;
        placed++;
      }
    }
    return placed;
  };

  /** Tiles a metal seam aims to cover, and how far it may spread looking
   * for them. The reach stays inside a mine's own gather radius, so a seam
   * that had to widen is still one mine's worth of ground rather than two. */
  const SEAM_TILES = 6;
  const SEAM_REACH = 3;

  /**
   * A metal seam of fixed total worth, however the ground lets it lie.
   *
   * `placeCluster` writes a flat amount per tile, which prices a seam by
   * whatever the terrain happened to allow: a blob that lands on open grass
   * is six tiles and six times the metal, while one that lands against a
   * grove or a lake is a single tile. Across the four starts of a generated
   * valley that ran to a tenfold spread — 20 silver against 200 — and the
   * seat dealt the thin end mined its whole birthright out inside twenty
   * minutes and went prospecting across the map. That is not a difficulty
   * setting, it is the seed deciding the match.
   *
   * So a seam is priced rather than measured. It takes the nearest open
   * tiles it can find, widening until it has SEAM_TILES of them or runs out
   * of room, and splits `budget` evenly over whatever landed: ground with
   * space for two tiles gets two rich ones. Every faction mines the same
   * amount of metal out of its own valley, which is what "ore is a
   * birthright" was always meant to say.
   *
   * Nearest-first and index-ordered, drawing nothing from the Rng — where a
   * seam sits is still a roll (see seamFor), but how it lies once the center
   * is chosen is the terrain's business alone.
   *
   * The budget is checked rather than merely documented, because both ends
   * of its range fail silently. `resourceAmt` is a byte, so a budget past
   * 255 wraps on a seam that lands on one tile — 300 becoming 44 — and a
   * map that reads as fair while one faction mines a seventh of what its
   * rivals do is the exact failure this function exists to remove. A budget
   * thinner than the tiles it is split over rounds some of them to nothing,
   * and a resource tile holding nothing is a seam a miner walks to and
   * cannot work (mapFile refuses one outright: 'resource with no amount').
   *
   * Returns how many tiles were written, so a caller that must place a seam
   * knows to try another center.
   */
  const placeSeam = (res: TileResourceKind, budget: number, cx: number, cy: number): number => {
    if (!Number.isInteger(budget) || budget < 1 || budget > 255) {
      throw new Error(`seam budget must be a whole number of 1..255 (got ${budget})`);
    }
    const open: { i: number; d2: number }[] = [];
    for (let dy = -SEAM_REACH; dy <= SEAM_REACH; dy++) {
      for (let dx = -SEAM_REACH; dx <= SEAM_REACH; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > SEAM_REACH * SEAM_REACH) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (!inPlayArea(map, x, y)) continue;
        const i = tileIdx(x, y, size);
        if (map.terrain[i] !== TerrainNs.Grass || map.resource[i] !== TileResourceNs.None) continue;
        open.push({ i, d2 });
      }
    }
    // Nearest first, ties by index: a seam short of room grows as a blob
    // around its center instead of reaching for whichever corner the scan
    // happened to walk first.
    open.sort((a, b) => a.d2 - b.d2 || a.i - b.i);
    // Never more tiles than the budget can put metal in: a seam priced
    // below SEAM_TILES buys fewer, richer tiles rather than padding itself
    // out with empty ones. At the budgets in use this takes all six.
    const take = open.slice(0, Math.min(SEAM_TILES, budget));
    if (take.length === 0) return 0;
    // The even split, with the remainder going to the tiles nearest the
    // middle. Whole tiles of the budget land and none of it is lost, so two
    // seams priced the same are worth exactly the same.
    const per = Math.floor(budget / take.length);
    let over = budget - per * take.length;
    for (const { i } of take) {
      map.resource[i] = res;
      map.resourceAmt[i] = per + (over-- > 0 ? 1 : 0);
    }
    return take.length;
  };

  const randomSpot = (minEdge: number): [number, number] => {
    for (;;) {
      const x = p0 + rng.int(play);
      const y = p0 + rng.int(play);
      if (
        playEdgeDist(map, x, y) >= minEdge &&
        map.terrain[tileIdx(x, y, size)] === TerrainNs.Grass
      ) {
        return [x, y];
      }
    }
  };
  const heightAt = (x: number, y: number): number => map.height[tileIdx(x, y, size)]!;
  const centerDist = (x: number, y: number): number => Math.hypot(x - size / 2, y - size / 2);
  // Distance to the nearest faction start — the multiplayer generalization
  // of "distance from the (center) home plateau". Solo start anchors at the
  // map center, so this IS centerDist there, keeping the classic seeds
  // byte-identical.
  const startDist = (x: number, y: number): number => {
    let best = Infinity;
    for (const s of starts) {
      const a = anchorOf(s);
      const d = Math.hypot(x - a.x, y - a.y);
      if (d < best) best = d;
    }
    return best;
  };
  // A spot matching an altitude taste: preference tiers are tried in
  // order (40 draws each) so a seed whose terrain lacks a band degrades
  // to the next-best flavor instead of scattering at random. Every tier
  // (and the last-resort fallback) keeps clusters off the home plateau —
  // a grove sprouting against the storehouse walls the whole town in.
  const spotPref = (
    minEdge: number,
    minStart: number,
    preds: ((x: number, y: number) => boolean)[],
  ): [number, number] => {
    for (const pred of preds) {
      for (let tries = 0; tries < 40; tries++) {
        const [x, y] = randomSpot(minEdge);
        if (startDist(x, y) >= minStart && pred(x, y)) return [x, y];
      }
    }
    for (;;) {
      const [x, y] = randomSpot(minEdge);
      if (startDist(x, y) >= minStart) return [x, y];
    }
  };

  // Starter larder: one grove and one outcrop guaranteed just past each
  // start's plateau rim, so no faction's opening build order is hostage to
  // how far the noise scattered everything (the bigger, lake-cut world pays
  // real travel time for distance).
  for (const start of starts) {
    const a = anchorOf(start);
    for (const [res, amt, radius] of [
      [TileResourceNs.Wood, 6, 3],
      [TileResourceNs.Rock, 10, 2],
    ] as const) {
      for (let tries = 0; ; tries++) {
        const ang = rng.range(0, Math.PI * 2);
        const dc = rng.range(10.5, 13);
        const x = Math.round(a.x + Math.cos(ang) * dc);
        const y = Math.round(a.y + Math.sin(ang) * dc);
        if (inPlayArea(map, x, y) && map.terrain[tileIdx(x, y, size)] === TerrainNs.Grass) {
          placeCluster(res, amt, x, y, radius, 0.8);
          break;
        }
        if (tries > 200) break; // pathological seed: live off the scattered ones
      }
    }
  }

  // Scattered cluster counts are densities, not quotas: the classic 64 map
  // carried 11 groves and 5 outcrops over 4096 tiles, and a bigger map
  // earns proportionally more of both (exact integer math, the classic
  // counts at 64). A fixed count spread over 2.25x the land starved the
  // mid-game — woodcutters walked half the valley for the next grove.
  const clusterCount = (classic: number): number => Math.floor((classic * play * play) / 4096);

  // Tree groves in the valleys — but off the immediate shoreline, so a
  // hut's commute never dead-ends against the water.
  for (let c = 0; c < clusterCount(11); c++) {
    const [x, y] = spotPref(4, 10, [
      (x0, y0) => heightAt(x0, y0) > 0.3 && heightAt(x0, y0) < 0.8,
      (x0, y0) => heightAt(x0, y0) < 0.8,
    ]);
    placeCluster(TileResourceNs.Wood, 6, x, y, rng.range(2, 4), 0.75);
  }
  // Rock outcrops on the high ground.
  for (let c = 0; c < clusterCount(5); c++) {
    const [x, y] = spotPref(4, 10, [(x0, y0) => heightAt(x0, y0) > 0.7]);
    placeCluster(TileResourceNs.Rock, 10, x, y, rng.range(1.4, 2.6), 0.85);
  }
  if (starts.length > 1) {
    // Ore is a birthright, not a lottery. Every faction gets one iron seam
    // and one silver seam at the same distance band from home, in its own
    // territory (no closer to any rival) — random deposits on a shared
    // ring could hand both iron seams to one side of a two-player map.
    // Placement draws polar offsets from the start's anchor, preferring
    // high ground.
    const isOwnGround = (s: StartSpot, x: number, y: number): boolean => {
      const a = anchorOf(s);
      return Math.hypot(x - a.x, y - a.y) <= startDist(x, y) + 1e-6;
    };
    const seamFor = (start: StartSpot, res: TileResourceKind, budget: number): void => {
      const a = anchorOf(start);
      const tiers: ((x: number, y: number) => boolean)[] = [
        (x, y) => isOwnGround(start, x, y) && heightAt(x, y) > 0.8,
        (x, y) => isOwnGround(start, x, y),
        () => true, // pathological seed: any grass in the band beats no seam
      ];
      for (const [ti, pred] of tiers.entries()) {
        const reach = ti === tiers.length - 1 ? 17 : 13; // last tier looks wider
        for (let tries = 0; tries < 60; tries++) {
          const ang = rng.range(0, Math.PI * 2);
          const d = rng.range(9, reach);
          const x = Math.round(a.x + Math.cos(ang) * d);
          const y = Math.round(a.y + Math.sin(ang) * d);
          if (playEdgeDist(map, x, y) < 3) continue;
          if (map.terrain[tileIdx(x, y, size)] !== TerrainNs.Grass) continue;
          if (!pred(x, y)) continue;
          if (placeSeam(res, budget, x, y) > 0) return;
        }
      }
    };
    for (const start of starts) {
      // What a seam is worth, not what a tile holds. Iron is priced at the
      // total the old six-tile blob carried, so the fair map is the map the
      // lucky seat already had. Silver is priced above it: the tech tree
      // costs 79 silver and a hand costs four every time one is taken off
      // haulage for a post, so 120 — the best a seat used to draw — bought
      // the techs or the people and never both, and the seats that drew
      // less spent the back half of the match with nothing to spend.
      seamFor(start, TileResourceNs.IronDep, 144);
      seamFor(start, TileResourceNs.SilverDep, 180);
    }

    // Gold is the exception by design: contested, not owned. It sits in
    // the middle — equidistant from every start, and the bandit camp that
    // spawns there stands guard over it.
    const mid = size / 2;
    for (let tries = 0; tries < 200; tries++) {
      const ang = rng.range(0, Math.PI * 2);
      const d = rng.range(1.5, 3 + tries * 0.03); // widen slowly if the middle is lake
      const x = Math.round(mid + Math.cos(ang) * d);
      const y = Math.round(mid + Math.sin(ang) * d);
      if (
        inPlayArea(map, x, y) &&
        map.terrain[tileIdx(x, y, size)] === TerrainNs.Grass &&
        placeCluster(TileResourceNs.GoldDep, 12, x, y, rng.range(1.4, 1.9), 1) > 0
      ) {
        break;
      }
    }
  } else {
    // Solo keeps the classic mid-ring, draw for draw: the campaign (and
    // both winnable playthrough tests) are tuned against these worlds, and
    // fairness-between-rivals has no meaning with one player.
    const deposits: [TileResourceKind, number, number][] = [
      [TileResourceNs.IronDep, 24, 2],
      [TileResourceNs.SilverDep, 20, 2],
      [TileResourceNs.GoldDep, 12, 1],
    ];
    const onRing = (x0: number, y0: number): boolean => {
      const dc = centerDist(x0, y0);
      return dc >= 13 && dc <= 17;
    };
    for (const [res, amt, count] of deposits) {
      for (let c = 0; c < count; c++) {
        // A center inside an existing grove writes nothing — redraw then.
        // Seeds whose first draw lands keep their exact classic worlds.
        for (let tries = 0; tries < 40; tries++) {
          const [x, y] = spotPref(4, 14, [
            (x0, y0) => onRing(x0, y0) && heightAt(x0, y0) > 1.0,
            onRing,
          ]);
          if (placeCluster(res, amt, x, y, rng.range(1.2, 1.9), 1) > 0) break;
        }
      }
    }
  }

  // Stone in the opening view — audited last, once every other cluster is
  // down, and repaired only where the audit fails.
  //
  // The larder above promises each start an outcrop, but the promise was
  // never counted: a center that clears the grass check still writes
  // nothing when the grove drawn a moment earlier owns every tile in
  // reach, and even a cluster that lands can sit entirely outside the
  // castle's opening sight (~10 tiles) while the trees sit inside it. A
  // player who sees timber and no stone at all reads the map as stoneless
  // and plays it that way — which is exactly the solo game this repairs.
  //
  // Repair draws from `rng` only for a start that came up short, so every
  // seed that was already fine keeps its world draw for draw — the
  // campaign map the balance tests are pinned to among them.
  //
  // Distances run from `castleCenter`, not from `anchorOf` — the anchor
  // sits half a tile off the middle on each axis, and a sight radius is
  // exactly the kind of measurement that slop turns into stone the fog
  // never uncovers. Tile centers, for the same reason: it is the distance
  // the visibility stamp itself computes.
  const rockWithin = (c: { x: number; y: number }, radius: number): number => {
    let n = 0;
    const r = Math.ceil(radius) + 1;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = Math.floor(c.x) + dx;
        const y = Math.floor(c.y) + dy;
        if (!inBounds(x, y, size)) continue;
        if (Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y) > radius) continue;
        if (map.resource[tileIdx(x, y, size)] === TileResourceNs.Rock) n++;
      }
    }
    return n;
  };
  // In sight, so the player knows stone exists at all; and enough of it
  // within a short walk to be worth siting a quarry on.
  const stoneEnough = (c: { x: number; y: number }): boolean =>
    rockWithin(c, CASTLE_OPENING_SIGHT) > 0 && rockWithin(c, 13) >= 5;
  for (const start of starts) {
    const c = castleCenter(start);
    for (let tries = 0; tries < 400 && !stoneEnough(c); tries++) {
      const ang = rng.range(0, Math.PI * 2);
      // Inside the fog line, clear of the ground the town builds on.
      const dc = rng.range(7, 9);
      const x = Math.round(c.x + Math.cos(ang) * dc);
      const y = Math.round(c.y + Math.sin(ang) * dc);
      if (!inPlayArea(map, x, y) || map.terrain[tileIdx(x, y, size)] !== TerrainNs.Grass) continue;
      placeCluster(TileResourceNs.Rock, 10, x, y, 2, 0.85);
    }
  }

  // Rival starts must be able to REACH each other, not merely share a
  // landmass. The land-bridge pass in computeTerrain guarantees connected
  // TERRAIN, but standing timber is grass a unit cannot walk: a belt arm
  // or a grove line across the only isthmus seals two villages apart —
  // soldiers cannot chop, so a war of elimination never ends (the exact
  // stall the Rival Banner playtest caught). Audited on the walkable
  // grid resources included, repaired by felling a 2-wide lane of
  // standing wood and rock along the straight line between the anchors.
  // Deterministic, no rng draws; ore seams are never touched (they are
  // walkable ground already).
  if (starts.length > 1) {
    const walkable = (i: number): boolean =>
      inPlayArea(map, i % size, (i / size) | 0) && !tileBlocks(map.terrain[i]!, map.resource[i]!);
    const reach = (from: number): Uint8Array => {
      const seen = new Uint8Array(tiles);
      const queue = [from];
      seen[from] = 1;
      for (let head = 0; head < queue.length; head++) {
        const i = queue[head]!;
        const x = i % size;
        const y = (i / size) | 0;
        for (const [nx, ny] of [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ] as const) {
          if (!inBounds(nx, ny, size)) continue;
          const n = tileIdx(nx, ny, size);
          if (seen[n] || !walkable(n)) continue;
          seen[n] = 1;
          queue.push(n);
        }
      }
      return seen;
    };
    const anchorIdx = (s: StartSpot): number => tileIdx(s.x + 2, s.y + 2, size);
    // A grass route always exists: the one-landmass pass drowned every
    // grass pocket start 0 cannot reach, so all surviving play-area grass
    // is one 4-connected component. Find the route that fells the FEWEST
    // standing tiles (0-1 BFS: clear grass is free, a wood/rock tile costs
    // one fell) and clear exactly those — a straight line was blind to
    // lakes, and chewing through a guaranteed home grove for no reason is
    // its own kind of damage.
    const fellLane = (from: number, to: number): void => {
      const INF = 0x7fffffff;
      const cost = new Int32Array(tiles).fill(INF);
      const parent = new Int32Array(tiles).fill(-1);
      // 0-1 BFS over an index-based deque (free steps go to the front,
      // fells to the back): Array#shift/unshift are O(n) and turned the
      // repair into quadratic work on big grids. Each relaxation enqueues
      // once and a node has four edges, so 8x tiles bounds the ring.
      const deque = new Int32Array(tiles * 8 + 2);
      let head = tiles * 4;
      let tail = head;
      deque[tail++] = from;
      cost[from] = 0;
      while (head < tail) {
        const i = deque[head++]!;
        if (i === to) break;
        const x = i % size;
        const y = (i / size) | 0;
        for (const [nx, ny] of [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ] as const) {
          if (!inPlayArea(map, nx, ny)) continue;
          const n = tileIdx(nx, ny, size);
          if (map.terrain[n] !== TerrainNs.Grass) continue;
          const step = resourceBlocks(map.resource[n]!) ? 1 : 0;
          if (cost[i]! + step >= cost[n]!) continue;
          cost[n] = cost[i]! + step;
          parent[n] = i;
          if (step === 0) deque[--head] = n;
          else deque[tail++] = n;
        }
      }
      for (let i = to; i >= 0; i = parent[i]!) {
        if (resourceBlocks(map.resource[i]!)) {
          map.resource[i] = TileResourceNs.None;
          map.resourceAmt[i] = 0;
        }
        if (i === from) break;
      }
    };
    for (let si = 1; si < starts.length; si++) {
      const seen = reach(anchorIdx(starts[0]!));
      if (seen[anchorIdx(starts[si]!)]) continue;
      fellLane(anchorIdx(starts[0]!), anchorIdx(starts[si]!));
    }
  }

  recomputeBlocked(map);
  return map;
}

/** Smooth value noise in [0,1]: bilinear over a hashed lattice. */
function valueNoise(seed: number, x: number, y: number, scale: number): number {
  const fx = x / scale;
  const fy = y / scale;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const h = (cx: number, cy: number): number => hash2(seed + cx * 131, seed * 7 + cy * 337);
  const a = h(x0, y0);
  const b = h(x0 + 1, y0);
  const c = h(x0, y0 + 1);
  const d = h(x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Below this raw-noise value a tile floods into a lake. */
const LAKE_LEVEL_T = 0.26;

/** Are two tiles on the same 4-connected grass component? */
function connected(map: GameMap, from: number, to: number): boolean {
  const size = map.size;
  if (map.terrain[from] !== TerrainNs.Grass || map.terrain[to] !== TerrainNs.Grass) return false;
  const seen = new Uint8Array(tileCount(size));
  const queue: number[] = [from];
  seen[from] = 1;
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    if (i === to) return true;
    const x = i % size;
    const y = (i / size) | 0;
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ] as const) {
      if (!inBounds(nx, ny, size)) continue;
      const n = tileIdx(nx, ny, size);
      if (seen[n] || map.terrain[n] !== TerrainNs.Grass) continue;
      seen[n] = 1;
      queue.push(n);
    }
  }
  return false;
}

/**
 * Terrain shape: a dramatic heightfield whose extremes mean something.
 * Ridged noise piles into real mountain ranges (up to ~2.5 world units);
 * basins dip below the lake threshold and flood — lakes and river arms in
 * the low ground, on top of the wobbled sea fringe painted earlier. A BFS
 * from the center then drowns any grass pocket cut off from the main
 * landmass, so everything that generates on grass stays reachable. The
 * middle of the map is eased toward gentle meadow: the starting town needs
 * buildable land.
 */
function computeTerrain(
  map: GameMap,
  seed: number,
  starts: readonly StartSpot[],
  rimRamp: Float32Array,
  beltMask: Uint8Array,
): void {
  const size = map.size;
  const tiles = tileCount(size);
  // Raw shape in ~[0, 1]: rolling base + squared ridge lines for ranges.
  const raw = new Float32Array(tiles);
  // Plateau centers sit at each start's storehouse middle (solo: the map
  // center, exactly the classic constant).
  const centers = starts.map((s) => ({ x: s.x + 1.5, y: s.y + 1.5 }));
  for (let i = 0; i < tiles; i++) {
    const x = i % size;
    const y = (i / size) | 0;
    const rolling = valueNoise(seed, x, y, 12) * 0.55 + valueNoise(seed + 1, x, y, 5) * 0.2;
    const ridge = 1 - Math.abs(2 * valueNoise(seed + 3, x, y, 9) - 1);
    let r = rolling + ridge * ridge * 0.25;
    // Home plateaus: keep every faction's starting area gentle and dry.
    let dc = Infinity;
    for (const c of centers) {
      const d = Math.hypot(x - c.x, y - c.y);
      if (d < dc) dc = d;
    }
    if (dc < 9) {
      const g = Math.min(Math.max((dc - 3) / 6, 0), 1);
      const blend = g * g * (3 - 2 * g);
      const clamped = Math.min(Math.max(r, 0.4), 0.55);
      r = clamped + (r - clamped) * blend;
    }
    raw[i] = r;
  }

  // The border ridge: raise the raw field under the rim rock so the range
  // is real geometry, ramping from full height at the outermost rock row
  // down to the meadow over the band's width (the SEG=6 ground mesh then
  // draws a slope rather than a wall). Forcing raw well above the lake
  // level also keeps basins from flooding wet notches through the rim.
  for (let i = 0; i < tiles; i++) {
    const t = rimRamp[i]!;
    if (t <= 0) continue;
    const ease = t * t * (3 - 2 * t);
    raw[i] = Math.max(raw[i]!, 0.55 + 0.45 * ease);
  }

  // Basins flood (grass only — rim rock stands above any basin).
  for (let i = 0; i < tiles; i++) {
    if (map.terrain[i] === TerrainNs.Grass && raw[i]! < LAKE_LEVEL_T)
      map.terrain[i] = TerrainNs.Water;
  }

  // Rival plateaus must share the landmass: if the lakes cut a start off
  // from start 0, carve a 2-wide land bridge along the straight line
  // between them (deterministic, interior-only — starts sit well inside
  // the sea fringe). Solo skips this entirely.
  const anchorTile = (s: StartSpot): number => tileIdx(s.x + 2, s.y + 2, size);
  if (starts.length > 1) {
    for (let si = 1; si < starts.length; si++) {
      if (connected(map, anchorTile(starts[0]!), anchorTile(starts[si]!))) continue;
      const a = centers[0]!;
      const b = centers[si]!;
      const steps = Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))) * 2;
      for (let t = 0; t <= steps; t++) {
        const px = Math.round(a.x + ((b.x - a.x) * t) / steps);
        const py = Math.round(a.y + ((b.y - a.y) * t) / steps);
        for (const [ox, oy] of [
          [0, 0],
          [1, 0],
          [0, 1],
        ] as const) {
          const cx = px + ox;
          const cy = py + oy;
          if (!inBounds(cx, cy, size)) continue;
          const ci = tileIdx(cx, cy, size);
          if (map.terrain[ci] === TerrainNs.Water && raw[ci]! < LAKE_LEVEL_T) {
            map.terrain[ci] = TerrainNs.Grass;
            raw[ci] = LAKE_LEVEL_T + 0.06; // causeway height, just above the water
          }
        }
      }
    }
  }

  // One landmass: drown grass pockets the lakes cut off from home.
  const center = anchorTile(starts[0]!);
  const reached = new Uint8Array(tiles);
  const flood: number[] = [center];
  reached[center] = 1;
  for (let head = 0; head < flood.length; head++) {
    const i = flood[head]!;
    const x = i % size;
    const y = (i / size) | 0;
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ] as const) {
      if (!inBounds(nx, ny, size)) continue;
      const n = tileIdx(nx, ny, size);
      if (reached[n] || map.terrain[n] !== TerrainNs.Grass) continue;
      reached[n] = 1;
      flood.push(n);
    }
  }
  for (let i = 0; i < tiles; i++) {
    if (!inPlayArea(map, i % size, (i / size) | 0)) continue; // margin: scenery, not a pocket
    if (map.terrain[i] === TerrainNs.Grass && !reached[i]) map.terrain[i] = TerrainNs.Water;
  }

  // Every start keeps fishable water within a short walk: a pond, a lake,
  // or the sea itself. The noise owes nobody a basin, and a start whose
  // surroundings all rolled high opened with the fishery a forced march
  // away — or, boxed in by a ridge rim, with no usable shore at all.
  // Audited here, after the lakes have flooded and the cut-off pockets
  // have drowned (so "water" means water that survived), and repaired only
  // where the audit fails. No rng draws on either path: the pond site is a
  // deterministic scan, so every seed that already had its water keeps its
  // world byte for byte.
  // Distances run from `castleCenter` to tile centers — the visibility
  // stamp's own metric — and a bank only counts if it is grass ON the main
  // landmass and OFF the border belt: a frayed sea notch lapping the
  // forest wall is real water no fishery could ever stand beside (the same
  // refusal the AI's nearestWater makes), and it must not satisfy the
  // audit either.
  const hasShore = (c: { x: number; y: number }): boolean => {
    const r = WATER_ACCESS_RADIUS;
    const x0 = Math.max(0, Math.floor(c.x - r));
    const x1 = Math.min(size - 1, Math.ceil(c.x + r));
    const y0 = Math.max(0, Math.floor(c.y - r));
    const y1 = Math.min(size - 1, Math.ceil(c.y + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y) > r) continue;
        if (map.terrain[tileIdx(x, y, size)] !== TerrainNs.Water) continue;
        for (const [nx, ny] of [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ] as const) {
          if (!inPlayArea(map, nx, ny)) continue;
          const n = tileIdx(nx, ny, size);
          if (map.terrain[n] === TerrainNs.Grass && reached[n] && !beltMask[n]) return true;
        }
      }
    }
    return false;
  };
  const fringe = Math.max(1, Math.floor(map.play / 24));
  for (const s of starts) {
    const c = castleCenter(s);
    if (hasShore(c)) continue;
    // Site the pond on the lowest reachable meadow in a ring just past the
    // home plateau. The candidate must clear a full Chebyshev square of
    // grass: the square's outer ring is a 4-connected cycle the carve
    // (strictly inside it) can never touch, so digging the pond can never
    // sever the landmass — any path through the pond detours around its
    // own bank. `reached` keeps that bank on the main landmass; the rim
    // margin keeps the dig out of every border band the deepest wobble
    // could draw.
    const dig = (clearK: number, dMin: number, dMax: number): number => {
      let best = -1;
      let bestRaw = Infinity;
      const rimClear = 3 * fringe + 3;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const dc = Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y);
          if (dc < dMin || dc > dMax) continue;
          if (playEdgeDist(map, x, y) < rimClear + clearK) continue;
          let clear = true;
          for (let dy = -clearK; dy <= clearK && clear; dy++) {
            for (let dx = -clearK; dx <= clearK; dx++) {
              const n = tileIdx(x + dx, y + dy, size);
              if (map.terrain[n] !== TerrainNs.Grass || !reached[n]) {
                clear = false;
                break;
              }
            }
          }
          const i = tileIdx(x, y, size);
          if (clear && raw[i]! < bestRaw) {
            bestRaw = raw[i]!;
            best = i;
          }
        }
      }
      return best;
    };
    let center = dig(4, 9.5, 15.5);
    let pondR = 2.4;
    if (center < 0) {
      // Pathological seed: a smaller pool, wider ring, up against the
      // plateau's toe if it must — still beats a start with no shore.
      center = dig(3, 8, 15.5);
      pondR = 1.6;
    }
    if (center < 0) continue; // no meadow at all within reach; live with it
    const cx = center % size;
    const cy = (center / size) | 0;
    const pr = Math.ceil(pondR * 1.3);
    for (let dy = -pr; dy <= pr; dy++) {
      for (let dx = -pr; dx <= pr; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const i = tileIdx(x, y, size);
        // Ragged edge: each tile draws its own threshold, so the pond
        // comes out lobed rather than stamped as a circle.
        const rim = pondR * (0.72 + 0.58 * hash2(i, seed + 9));
        if (Math.hypot(dx, dy) > rim) continue;
        map.terrain[i] = TerrainNs.Water;
      }
    }
  }

  // 4-neighbor BFS distances (in tiles): to the nearest water tile, for
  // banks that dive toward the waterline, and to the nearest land tile,
  // for beds that shelve. Both are capped — past a few tiles the shaping
  // has already saturated.
  const bfs = (isSeed: (t: number) => boolean): Float32Array => {
    const dist = new Float32Array(tiles).fill(99);
    const queue: number[] = [];
    for (let i = 0; i < tiles; i++) {
      if (isSeed(map.terrain[i]!)) {
        dist[i] = 0;
        queue.push(i);
      }
    }
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head]!;
      const x = i % size;
      const y = (i / size) | 0;
      const d = dist[i]! + 1;
      if (d > 6) continue;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const) {
        if (!inBounds(nx, ny, size)) continue;
        const n = tileIdx(nx, ny, size);
        if (d < dist[n]!) {
          dist[n] = d;
          queue.push(n);
        }
      }
    }
    return dist;
  };
  const dist = bfs((t) => t === TerrainNs.Water);
  // Land = anything that isn't water: rim rock counts, so the sea strip's
  // bed shelves off a cliff foot the same way it shelves off a beach.
  const landDist = bfs((t) => t !== TerrainNs.Water);

  for (let i = 0; i < tiles; i++) {
    const x = i % size;
    const y = (i / size) | 0;
    if (map.terrain[i] === TerrainNs.Water) {
      // Beds shelve: barely under the surface at the margins, plunging to
      // full depth a few tiles out. A flat bed gives the renderer nothing
      // to grade, and every lake reads as one solid slab of color.
      const shelf = Math.min(landDist[i]! / 2.2, 1);
      const ease = shelf * shelf * (3 - 2 * shelf);
      map.height[i] = -0.34 - ease * 0.95 - valueNoise(seed + 2, x, y, 5) * 0.22;
    } else {
      // Power curve exaggerates the extremes: lowlands stay gentle,
      // ridges climb steeply into peaks.
      const t = (raw[i]! - LAKE_LEVEL_T) / (1 - LAKE_LEVEL_T);
      const peak = 0.05 + Math.pow(t, 1.7) * 2.5;
      // Meadows ease down to the waterline over a few tiles; border-ridge
      // rock does NOT — its tallest rows stand right against the outer sea
      // strip, and easing them flattened the whole range to beach height.
      // A cliff coastline rises straight out of the water by definition.
      if (map.terrain[i] === TerrainNs.Rock) {
        map.height[i] = peak;
      } else {
        const shore = Math.min(dist[i]! / 3.5, 1);
        const ease = shore * shore * (3 - 2 * shore);
        map.height[i] = 0.04 + (peak - 0.04) * ease;
      }
    }
  }
}

/** Full rebuild of the derived walkability grid (worldgen, load). */
export function recomputeBlocked(map: GameMap): void {
  const size = map.size;
  for (let i = 0; i < tileCount(size); i++) {
    map.blocked[i] =
      tileBlocks(map.terrain[i]!, map.resource[i]!) ||
      map.buildingAt[i]! >= 0 ||
      // The margin is scenery, walkable-looking ground included: worldgen
      // fills it with rock, sea, and solid timber, but an edited map owes
      // no such guarantee, so the rule is enforced here rather than
      // assumed from content.
      !inPlayArea(map, i % size, (i / size) | 0)
        ? 1
        : 0;
  }
}

/** Clear standing resources in a rect (used to make room for pre-placed buildings). */
export function clearResources(map: GameMap, x0: number, y0: number, w: number, h: number): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (!inBounds(x, y, map.size)) continue;
      const i = tileIdx(x, y, map.size);
      map.resource[i] = TileResourceNs.None;
      map.resourceAmt[i] = 0;
    }
  }
}

/** Is every tile of the rect grass, resource-free, and building-free? */
export function rectClear(map: MapView, x0: number, y0: number, w: number, h: number): boolean {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (!inPlayArea(map, x, y)) return false;
      const i = tileIdx(x, y, map.size);
      if (map.terrain[i] !== TerrainNs.Grass) return false;
      if (map.resource[i] !== TileResourceNs.None) return false;
      if (map.buildingAt[i] !== -1) return false;
    }
  }
  return true;
}

/**
 * The nearest live tile of a resource, by manhattan distance, or -1 when the
 * map holds none. Play area only: the margin outside it is scenery no seat
 * can build on, so a seam out there is not somewhere to re-site to.
 *
 * Lives here rather than in the AI because it is a question about the map,
 * and two callers need it — the build order picking where to anchor a hut,
 * and the economy rules deciding whether a worked-out one is worth selling.
 */
export function nearestResource(map: GameMap, code: number, cx: number, cy: number): number {
  const size = map.size;
  const lo = playMin(map);
  const hi = playMax(map);
  let best = -1;
  let bestDist = Infinity;
  for (let y = lo; y < hi; y++) {
    for (let x = lo; x < hi; x++) {
      const i = y * size + x;
      if (map.resource[i] !== code || map.resourceAmt[i]! <= 0) continue;
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
  }
  return best;
}
