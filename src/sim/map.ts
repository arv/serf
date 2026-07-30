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

/** A faction's home: storehouse footprint origin tile. */
export interface StartSpot {
  x: number;
  y: number;
}

/** Plateau/flood anchor tile of a start (the storehouse's center tile). */
function anchorOf(s: StartSpot): { x: number; y: number } {
  return { x: s.x + 2, y: s.y + 2 };
}

export function generateMap(rng: Rng, starts: readonly StartSpot[]): GameMap {
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
  computeTerrain(map, heightSeed, starts);

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
      [TileResource.Bamboo, 6, 3],
      [TileResource.Rock, 10, 2],
    ] as const) {
      for (let tries = 0; ; tries++) {
        const ang = rng.range(0, Math.PI * 2);
        const dc = rng.range(10.5, 13);
        const x = Math.round(a.x + Math.cos(ang) * dc);
        const y = Math.round(a.y + Math.sin(ang) * dc);
        if (inBounds(x, y) && map.terrain[tileIdx(x, y)] === Terrain.Grass) {
          placeCluster(res, amt, x, y, radius, 0.8);
          break;
        }
        if (tries > 200) break; // pathological seed: live off the scattered ones
      }
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
  // More mouths, more seams: with N factions the ring carries more ore so
  // parallel hire economies don't starve (solo multiplier is 1 — classic
  // seeds unchanged).
  const seamMult = Math.ceil(starts.length / 2);
  const deposits: [TileResourceKind, number, number][] = [
    [TileResource.IronDep, 24, 2 * seamMult],
    [TileResource.SilverDep, 20, 2 * seamMult],
    [TileResource.GoldDep, 12, 1 * seamMult],
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

/** Are two tiles on the same 4-connected grass component? */
function connected(map: GameMap, from: number, to: number): boolean {
  if (map.terrain[from] !== Terrain.Grass || map.terrain[to] !== Terrain.Grass) return false;
  const seen = new Uint8Array(TILE_COUNT);
  const queue: number[] = [from];
  seen[from] = 1;
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    if (i === to) return true;
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
      if (seen[n] || map.terrain[n] !== Terrain.Grass) continue;
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
function computeTerrain(map: GameMap, seed: number, starts: readonly StartSpot[]): void {
  // Raw shape in ~[0, 1]: rolling base + squared ridge lines for ranges.
  const raw = new Float32Array(TILE_COUNT);
  // Plateau centers sit at each start's storehouse middle (solo: the map
  // center, exactly the classic constant).
  const centers = starts.map((s) => ({ x: s.x + 1.5, y: s.y + 1.5 }));
  for (let i = 0; i < TILE_COUNT; i++) {
    const x = i % MAP_SIZE;
    const y = (i / MAP_SIZE) | 0;
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

  // Basins flood.
  for (let i = 0; i < TILE_COUNT; i++) {
    if (raw[i]! < LAKE_LEVEL_T) map.terrain[i] = Terrain.Water;
  }

  // Rival plateaus must share the landmass: if the lakes cut a start off
  // from start 0, carve a 2-wide land bridge along the straight line
  // between them (deterministic, interior-only — starts sit well inside
  // the sea fringe). Solo skips this entirely.
  const anchorTile = (s: StartSpot): number => tileIdx(s.x + 2, s.y + 2);
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
          if (!inBounds(cx, cy)) continue;
          const ci = tileIdx(cx, cy);
          if (map.terrain[ci] === Terrain.Water && raw[ci]! < LAKE_LEVEL_T) {
            map.terrain[ci] = Terrain.Grass;
            raw[ci] = LAKE_LEVEL_T + 0.06; // causeway height, just above the water
          }
        }
      }
    }
  }

  // One landmass: drown grass pockets the lakes cut off from home.
  const center = anchorTile(starts[0]!);
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

  // 4-neighbor BFS distances (in tiles): to the nearest water tile, for
  // banks that dive toward the waterline, and to the nearest land tile,
  // for beds that shelve. Both are capped — past a few tiles the shaping
  // has already saturated.
  const bfs = (seedKind: number): Float32Array => {
    const dist = new Float32Array(TILE_COUNT).fill(99);
    const queue: number[] = [];
    for (let i = 0; i < TILE_COUNT; i++) {
      if (map.terrain[i] === seedKind) {
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
    return dist;
  };
  const dist = bfs(Terrain.Water);
  const landDist = bfs(Terrain.Grass);

  for (let i = 0; i < TILE_COUNT; i++) {
    const x = i % MAP_SIZE;
    const y = (i / MAP_SIZE) | 0;
    if (map.terrain[i] === Terrain.Water) {
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
