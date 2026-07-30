import { Rng } from '../shared/rng';
import { MAP_SIZE, TILE_COUNT, edgeDist, inBounds, tileIdx } from '../shared/grid';
import { hash2 } from '../shared/math';

export const Terrain = { Grass: 0, Water: 1 } as const;
export type TerrainKind = (typeof Terrain)[keyof typeof Terrain];

export const TileResource = {
  None: 0,
  Bamboo: 1,
  Rock: 2,
  IronDep: 3,
  SilverDep: 4,
  GoldDep: 5,
} as const;
export type TileResourceKind = (typeof TileResource)[keyof typeof TileResource];

export const PathLevel = { None: 0, Trail: 1, Road: 2 } as const;

/**
 * The map as structure-of-arrays. Everything here is serializable typed-array
 * data; `blocked` is derived but cheap enough to keep in sync incrementally
 * (a full recompute exists for load).
 */
export interface GameMap {
  terrain: Uint8Array;
  resource: Uint8Array;
  /** Remaining harvests for bamboo/rock; remaining ore for deposits. */
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
  'terrain' | 'resource' | 'blocked' | 'buildingAt' | 'pathLevel' | 'height'
>;

/** Walking resources block movement; ore deposits are walkable rocky ground. */
export function resourceBlocks(res: number): boolean {
  return res === TileResource.Bamboo || res === TileResource.Rock;
}

export function generateMap(rng: Rng): GameMap {
  const map: GameMap = {
    terrain: new Uint8Array(TILE_COUNT),
    resource: new Uint8Array(TILE_COUNT),
    resourceAmt: new Uint8Array(TILE_COUNT),
    blocked: new Uint8Array(TILE_COUNT),
    buildingAt: new Int16Array(TILE_COUNT).fill(-1),
    wear: new Float32Array(TILE_COUNT),
    pathLevel: new Uint8Array(TILE_COUNT),
    height: new Float32Array(TILE_COUNT),
  };
  const heightSeed = rng.int(0x7fffffff);

  // Irregular water fringe: per-edge-position depth wobble, smoothed.
  const wobble = new Float32Array(MAP_SIZE * 4);
  for (let i = 0; i < wobble.length; i++) wobble[i] = rng.range(0, 2.6);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < wobble.length; i++) {
      const prev = wobble[(i + wobble.length - 1) % wobble.length]!;
      const next = wobble[(i + 1) % wobble.length]!;
      wobble[i] = (prev + wobble[i]! * 2 + next) / 4;
    }
  }
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      // Which edge is nearest determines which wobble entry applies.
      const dists = [y, MAP_SIZE - 1 - x, MAP_SIZE - 1 - y, x]; // N, E, S, W
      let side = 0;
      for (let s = 1; s < 4; s++) if (dists[s]! < dists[side]!) side = s;
      const along = side % 2 === 0 ? x : y;
      const depth = 1 + wobble[side * MAP_SIZE + along]!;
      if (dists[side]! < depth) map.terrain[tileIdx(x, y)] = Terrain.Water;
    }
  }

  // Terrain shape before resources: basins flood into lakes, so clusters
  // must only ever land on the ground that survives.
  computeTerrain(map, heightSeed);

  const placeCluster = (
    res: TileResourceKind,
    amt: number,
    cx: number,
    cy: number,
    radius: number,
    density: number,
  ): void => {
    const r = Math.ceil(radius);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!inBounds(x, y)) continue;
        if (dx * dx + dy * dy > radius * radius) continue;
        const i = tileIdx(x, y);
        if (map.terrain[i] !== Terrain.Grass || map.resource[i] !== TileResource.None) continue;
        if (rng.next() > density) continue;
        map.resource[i] = res;
        map.resourceAmt[i] = amt;
      }
    }
  };

  const randomSpot = (minEdge: number): [number, number] => {
    for (;;) {
      const x = rng.int(MAP_SIZE);
      const y = rng.int(MAP_SIZE);
      if (edgeDist(x, y) >= minEdge && map.terrain[tileIdx(x, y)] === Terrain.Grass) {
        return [x, y];
      }
    }
  };
  const heightAt = (x: number, y: number): number => map.height[tileIdx(x, y)]!;
  const centerDist = (x: number, y: number): number =>
    Math.hypot(x - MAP_SIZE / 2, y - MAP_SIZE / 2);
  // A spot matching an altitude taste: preference tiers are tried in
  // order (40 draws each) so a seed whose terrain lacks a band degrades
  // to the next-best flavor instead of scattering at random. Every tier
  // (and the last-resort fallback) keeps clusters off the home plateau —
  // a grove sprouting against the storehouse walls the whole town in.
  const spotPref = (
    minEdge: number,
    minCenter: number,
    preds: ((x: number, y: number) => boolean)[],
  ): [number, number] => {
    for (const pred of preds) {
      for (let tries = 0; tries < 40; tries++) {
        const [x, y] = randomSpot(minEdge);
        if (centerDist(x, y) >= minCenter && pred(x, y)) return [x, y];
      }
    }
    for (;;) {
      const [x, y] = randomSpot(minEdge);
      if (centerDist(x, y) >= minCenter) return [x, y];
    }
  };

  // Starter larder: one grove and one outcrop guaranteed just past the
  // plateau rim, so the opening build order isn't hostage to how far the
  // noise scattered everything (the bigger, lake-cut world pays real
  // travel time for distance).
  for (const [res, amt, radius] of [
    [TileResource.Bamboo, 6, 3],
    [TileResource.Rock, 10, 2],
  ] as const) {
    for (let tries = 0; ; tries++) {
      const ang = rng.range(0, Math.PI * 2);
      const dc = rng.range(10.5, 13);
      const x = Math.round(MAP_SIZE / 2 + Math.cos(ang) * dc);
      const y = Math.round(MAP_SIZE / 2 + Math.sin(ang) * dc);
      if (inBounds(x, y) && map.terrain[tileIdx(x, y)] === Terrain.Grass) {
        placeCluster(res, amt, x, y, radius, 0.8);
        break;
      }
      if (tries > 200) break; // pathological seed: live off the scattered ones
    }
  }

  // Bamboo groves in the valleys — but off the immediate shoreline, so a
  // hut's commute never dead-ends against the water.
  for (let c = 0; c < 11; c++) {
    const [x, y] = spotPref(4, 10, [
      (x0, y0) => heightAt(x0, y0) > 0.3 && heightAt(x0, y0) < 0.8,
      (x0, y0) => heightAt(x0, y0) < 0.8,
    ]);
    placeCluster(TileResource.Bamboo, 6, x, y, rng.range(2, 4), 0.75);
  }
  // Rock outcrops on the high ground.
  for (let c = 0; c < 5; c++) {
    const [x, y] = spotPref(4, 10, [(x0, y0) => heightAt(x0, y0) > 0.7]);
    placeCluster(TileResource.Rock, 10, x, y, rng.range(1.4, 2.6), 0.85);
  }
  // Ore deposits on a mid-map mountain ring: far enough from home that
  // mines demand expansion, near enough to defend, and — crucially —
  // outside the corners where the bandit camp spawns (a seam beside the
  // camp bleeds every serf sent to build its mine).
  const deposits: [TileResourceKind, number, number][] = [
    [TileResource.IronDep, 24, 2],
    [TileResource.SilverDep, 20, 2],
    [TileResource.GoldDep, 12, 1],
  ];
  const onRing = (x0: number, y0: number): boolean => {
    const dc = centerDist(x0, y0);
    return dc >= 13 && dc <= 17;
  };
  for (const [res, amt, count] of deposits) {
    for (let c = 0; c < count; c++) {
      const [x, y] = spotPref(4, 14, [
        (x0, y0) => onRing(x0, y0) && heightAt(x0, y0) > 1.0,
        onRing,
      ]);
      placeCluster(res, amt, x, y, rng.range(1.2, 1.9), 1);
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
function computeTerrain(map: GameMap, seed: number): void {
  // Raw shape in ~[0, 1]: rolling base + squared ridge lines for ranges.
  const raw = new Float32Array(TILE_COUNT);
  const c0 = MAP_SIZE / 2 - 0.5;
  for (let i = 0; i < TILE_COUNT; i++) {
    const x = i % MAP_SIZE;
    const y = (i / MAP_SIZE) | 0;
    const rolling = valueNoise(seed, x, y, 12) * 0.55 + valueNoise(seed + 1, x, y, 5) * 0.2;
    const ridge = 1 - Math.abs(2 * valueNoise(seed + 3, x, y, 9) - 1);
    let r = rolling + ridge * ridge * 0.25;
    // Home plateau: keep the starting area gentle and dry.
    const dc = Math.hypot(x - c0, y - c0);
    if (dc < 9) {
      const g = Math.min(Math.max((dc - 3) / 6, 0), 1);
      const blend = g * g * (3 - 2 * g);
      const clamped = Math.min(Math.max(r, 0.4), 0.55);
      r = clamped + (r - clamped) * blend;
    }
    raw[i] = r;
  }

  // Basins flood.
  for (let i = 0; i < TILE_COUNT; i++) {
    if (raw[i]! < LAKE_LEVEL_T) map.terrain[i] = Terrain.Water;
  }

  // One landmass: drown grass pockets the lakes cut off from the center.
  const center = tileIdx(MAP_SIZE / 2, MAP_SIZE / 2);
  const reached = new Uint8Array(TILE_COUNT);
  const flood: number[] = [center];
  reached[center] = 1;
  for (let head = 0; head < flood.length; head++) {
    const i = flood[head]!;
    const x = i % MAP_SIZE;
    const y = (i / MAP_SIZE) | 0;
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ] as const) {
      if (!inBounds(nx, ny)) continue;
      const n = tileIdx(nx, ny);
      if (reached[n] || map.terrain[n] !== Terrain.Grass) continue;
      reached[n] = 1;
      flood.push(n);
    }
  }
  for (let i = 0; i < TILE_COUNT; i++) {
    if (map.terrain[i] === Terrain.Grass && !reached[i]) map.terrain[i] = Terrain.Water;
  }

  // 4-neighbor BFS distance (in tiles) to the nearest water tile, for
  // banks that dive toward the waterline.
  const dist = new Float32Array(TILE_COUNT).fill(99);
  const queue: number[] = [];
  for (let i = 0; i < TILE_COUNT; i++) {
    if (map.terrain[i] === Terrain.Water) {
      dist[i] = 0;
      queue.push(i);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    const x = i % MAP_SIZE;
    const y = (i / MAP_SIZE) | 0;
    const d = dist[i]! + 1;
    if (d > 6) continue;
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ] as const) {
      if (!inBounds(nx, ny)) continue;
      const n = tileIdx(nx, ny);
      if (d < dist[n]!) {
        dist[n] = d;
        queue.push(n);
      }
    }
  }

  for (let i = 0; i < TILE_COUNT; i++) {
    const x = i % MAP_SIZE;
    const y = (i / MAP_SIZE) | 0;
    if (map.terrain[i] === Terrain.Water) {
      // Bed drops below the waterline, deeper away from shore.
      map.height[i] = -0.85 - valueNoise(seed + 2, x, y, 5) * 0.5;
    } else {
      // Power curve exaggerates the extremes: lowlands stay gentle,
      // ridges climb steeply into peaks.
      const t = (raw[i]! - LAKE_LEVEL_T) / (1 - LAKE_LEVEL_T);
      const peak = 0.05 + Math.pow(t, 1.7) * 2.5;
      const shore = Math.min(dist[i]! / 3.5, 1);
      const ease = shore * shore * (3 - 2 * shore);
      map.height[i] = 0.04 + (peak - 0.04) * ease;
    }
  }
}

/** Full rebuild of the derived walkability grid (worldgen, load). */
export function recomputeBlocked(map: GameMap): void {
  for (let i = 0; i < TILE_COUNT; i++) {
    map.blocked[i] =
      map.terrain[i] === Terrain.Water || resourceBlocks(map.resource[i]!) || map.buildingAt[i]! >= 0
        ? 1
        : 0;
  }
}

/** Clear standing resources in a rect (used to make room for pre-placed buildings). */
export function clearResources(map: GameMap, x0: number, y0: number, w: number, h: number): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (!inBounds(x, y)) continue;
      const i = tileIdx(x, y);
      map.resource[i] = TileResource.None;
      map.resourceAmt[i] = 0;
    }
  }
}

/** Is every tile of the rect grass, resource-free, and building-free? */
export function rectClear(map: MapView, x0: number, y0: number, w: number, h: number): boolean {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (!inBounds(x, y)) return false;
      const i = tileIdx(x, y);
      if (map.terrain[i] !== Terrain.Grass) return false;
      if (map.resource[i] !== TileResource.None) return false;
      if (map.buildingAt[i] !== -1) return false;
    }
  }
  return true;
}
