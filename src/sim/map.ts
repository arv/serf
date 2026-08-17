import { Rng } from '../shared/rng.ts';
import { edgeDist, inBounds, tileCount, tileIdx } from '../shared/grid.ts';
import { hash2 } from '../shared/math.ts';
import { WOOD_MAX_AMT } from './defs/balance.ts';
import { buildingDef, type TileResourceName } from './defs/buildings.ts';
import { buildingSight } from './visibility.ts';

export const Terrain = { Grass: 0, Water: 1, Rock: 2 } as const;
export type TerrainKind = (typeof Terrain)[keyof typeof Terrain];

/** Border styles an edge can draw (see the rim pass in generateMap). */
const RIM_SEA = 0;
const RIM_RIDGE = 1;
const RIM_FOREST = 2;
type RimStyle = typeof RIM_SEA | typeof RIM_RIDGE | typeof RIM_FOREST;

export const TileResource = {
  None: 0,
  Wood: 1,
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
  /** Grid side length in tiles — per-game data, not a global. */
  size: number;
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
  'size' | 'terrain' | 'resource' | 'blocked' | 'buildingAt' | 'pathLevel' | 'height'
>;

/** Walking resources block movement; ore deposits are walkable rocky ground. */
export function resourceBlocks(res: number): boolean {
  return res === TileResource.Wood || res === TileResource.Rock;
}

/**
 * The landscape's share of walkability: only clear grass is walkable —
 * water and rim rock (Terrain.Rock) are terrain-blocked, standing wood and
 * stone are resource-blocked. THE rule, shared by recomputeBlocked,
 * destroyBuilding's footprint release, and the server's unexplored-tile
 * masking, so the three can never drift apart. (Building footprints are
 * the one other blocker, layered on by the callers that know about them.)
 */
export function tileBlocks(terrain: number, res: number): boolean {
  return terrain !== Terrain.Grass || resourceBlocks(res);
}

/** A gather recipe's resource name, as the tile code the map stores. */
export const RESOURCE_CODE: Record<TileResourceName, TileResourceKind> = {
  wood: TileResource.Wood,
  rock: TileResource.Rock,
  ironDep: TileResource.IronDep,
  silverDep: TileResource.SilverDep,
  goldDep: TileResource.GoldDep,
};

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
        if (!inBounds(x, y, map.size)) continue;
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
        if (!inBounds(x, y, map.size)) continue;
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
  const def = buildingDef('storehouse');
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
  buildingSight('storehouse', buildingDef('storehouse').w, buildingDef('storehouse').h) - 1;

/**
 * How far from home (castle center, tile-center metric) worldgen promises
 * fishable water — a pond, a lake, or the sea itself. Enforced by the
 * water-access audit in computeTerrain, which carves a pond for any start
 * the noise left dry.
 */
export const WATER_ACCESS_RADIUS = 16;

export function generateMap(rng: Rng, starts: readonly StartSpot[], size: number): GameMap {
  const tiles = tileCount(size);
  const map: GameMap = {
    size,
    terrain: new Uint8Array(tiles),
    resource: new Uint8Array(tiles),
    resourceAmt: new Uint8Array(tiles),
    blocked: new Uint8Array(tiles),
    buildingAt: new Int16Array(tiles).fill(-1),
    wear: new Float32Array(tiles),
    pathLevel: new Uint8Array(tiles),
    height: new Float32Array(tiles),
  };
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
  // of holding one depth. The base depth grows with the map — the rim is
  // decorative margin (Warcraft-style: the camera stays inside the grid,
  // so this band is all the breathing room the border gets). The smoothing
  // wraps around the whole perimeter, which is also what keeps the band's
  // depth continuous where two styles meet at a corner.
  const fringe = Math.max(1, Math.floor(size / 24));
  const perimeter = size * 4;
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

  // The outermost ring is water on EVERY edge, whatever the style. This
  // one rule does a lot of quiet work: the water shader's clamp-to-edge
  // bed keeps extending open sea past every border (no void behind a
  // ridge), corners always meet over water so no grass pocket can be
  // stranded outside a ridge for the one-landmass pass to drown, mist
  // always has anchors, and a ridge rises straight out of the sea — a
  // cliff coastline — while a forest belt runs down to a wooded shore.
  //
  // The strip carries its OWN wobble, rougher than the band's (one
  // smoothing pass instead of two): the band wobble only bends the rim's
  // inner edge, and a constant-width strip left every ridge and forest
  // wall standing on a ruler-straight coastline.
  const strip = Math.max(1, Math.floor(size / 48));
  const stripWobble = new Float32Array(perimeter);
  for (let i = 0; i < stripWobble.length; i++) {
    stripWobble[i] = rng.range(0, Math.max(1, fringe * 0.75));
  }
  smoothLoop(stripWobble);

  // Ridge profile (0 = no rim rock, 1 = outermost rock row), fed into
  // computeTerrain so the heightfield raises the range under the rock.
  const rimRamp = new Float32Array(tiles);
  // Forest-belt tiles: 1 = full belt, 2 = ragged inner treeline row.
  const beltMask = new Uint8Array(tiles);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Which edge is nearest determines which wobble entry applies.
      const dists = [y, size - 1 - x, size - 1 - y, x]; // N, E, S, W
      let side = 0;
      for (let s = 1; s < 4; s++) if (dists[s]! < dists[side]!) side = s;
      const along = side % 2 === 0 ? x : y;
      const p = side * size + along;
      const i = tileIdx(x, y, size);
      // Band depth: base + jitter + meander, capped so the rim never eats
      // more than 3x its base into the playfield — and never less than the
      // base, which the blocked-band contract leans on. Per-tile teeth
      // (hash2, not rng — draw counts must not depend on geometry) fray
      // the band's inner edge on top of both.
      const tooth = hash2(i, 211);
      const depth =
        fringe +
        Math.min(wobble[p]! + meander(1, p, size / 5) * fringe * 1.2, 2 * fringe) +
        (tooth < 0.2 ? 2 : tooth < 0.5 ? 1 : 0);
      const d = dists[side]!;
      // The waterline: the wobbled strip plus its own shorter meander,
      // clamped so at least one rim row always survives inland of it,
      // bitten by one- and two-tile notches so the coast frays at tile
      // scale on top of the low-frequency wander.
      const bite = hash2(i, 137);
      const notch = bite < 0.14 ? 2 : bite < 0.45 ? 1 : 0;
      const waterline = Math.min(
        strip + stripWobble[p]! + meander(5, p, size / 7) * fringe * 0.8 + notch,
        depth - 1,
      );
      if (d < Math.max(strip, waterline)) {
        map.terrain[i] = Terrain.Water;
      } else if (d < depth) {
        switch (rimStyles[side]!) {
          case RIM_SEA:
            map.terrain[i] = Terrain.Water;
            break;
          case RIM_RIDGE:
            map.terrain[i] = Terrain.Rock;
            rimRamp[i] = (depth - d) / Math.max(1, depth - waterline);
            break;
          case RIM_FOREST:
            // Terrain stays grass; the trees are planted after the
            // heightfield settles, so lakes and drowning have their say.
            beltMask[i] = depth - d <= 1 ? 2 : 1;
            break;
        }
      }
    }
  }

  // Terrain shape before resources: basins flood into lakes, so clusters
  // must only ever land on the ground that survives. The belt mask rides
  // along so the water-access audit can refuse a bank the forest wall is
  // about to swallow.
  computeTerrain(map, heightSeed, starts, rimRamp, beltMask);

  // Plant the border forest, now that the ground under it is final: every
  // belt tile still grass gets standing wood at full amount, so regrowth
  // keeps the un-felled wall topped up — a deep timber reserve that IS
  // choppable (tunneling out is a strategy, not a bug). hash2 rather than
  // rng on purpose: the number of draws must not depend on which styles
  // the sides drew, or every downstream draw would shift.
  for (let i = 0; i < tiles; i++) {
    if (!beltMask[i] || map.terrain[i] !== Terrain.Grass) continue;
    if (map.resource[i] !== TileResource.None) continue;
    // The inner treeline thins out so the wall ends ragged, not ruled.
    if (beltMask[i] === 2 && hash2(i, heightSeed) < 0.55) continue;
    map.resource[i] = TileResource.Wood;
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
        if (!inBounds(x, y, size)) continue;
        if (dx * dx + dy * dy > radius * radius) continue;
        const i = tileIdx(x, y, size);
        if (map.terrain[i] !== Terrain.Grass || map.resource[i] !== TileResource.None) continue;
        if (rng.next() > density) continue;
        map.resource[i] = res;
        map.resourceAmt[i] = amt;
        placed++;
      }
    }
    return placed;
  };

  const randomSpot = (minEdge: number): [number, number] => {
    for (;;) {
      const x = rng.int(size);
      const y = rng.int(size);
      if (edgeDist(x, y, size) >= minEdge && map.terrain[tileIdx(x, y, size)] === Terrain.Grass) {
        return [x, y];
      }
    }
  };
  const heightAt = (x: number, y: number): number => map.height[tileIdx(x, y, size)]!;
  const centerDist = (x: number, y: number): number =>
    Math.hypot(x - size / 2, y - size / 2);
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
      [TileResource.Wood, 6, 3],
      [TileResource.Rock, 10, 2],
    ] as const) {
      for (let tries = 0; ; tries++) {
        const ang = rng.range(0, Math.PI * 2);
        const dc = rng.range(10.5, 13);
        const x = Math.round(a.x + Math.cos(ang) * dc);
        const y = Math.round(a.y + Math.sin(ang) * dc);
        if (inBounds(x, y, size) && map.terrain[tileIdx(x, y, size)] === Terrain.Grass) {
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
  const clusterCount = (classic: number): number => Math.floor((classic * tiles) / 4096);

  // Tree groves in the valleys — but off the immediate shoreline, so a
  // hut's commute never dead-ends against the water.
  for (let c = 0; c < clusterCount(11); c++) {
    const [x, y] = spotPref(4, 10, [
      (x0, y0) => heightAt(x0, y0) > 0.3 && heightAt(x0, y0) < 0.8,
      (x0, y0) => heightAt(x0, y0) < 0.8,
    ]);
    placeCluster(TileResource.Wood, 6, x, y, rng.range(2, 4), 0.75);
  }
  // Rock outcrops on the high ground.
  for (let c = 0; c < clusterCount(5); c++) {
    const [x, y] = spotPref(4, 10, [(x0, y0) => heightAt(x0, y0) > 0.7]);
    placeCluster(TileResource.Rock, 10, x, y, rng.range(1.4, 2.6), 0.85);
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
    const seamFor = (start: StartSpot, res: TileResourceKind, amt: number): void => {
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
          if (!inBounds(x, y, size) || edgeDist(x, y, size) < 3) continue;
          if (map.terrain[tileIdx(x, y, size)] !== Terrain.Grass) continue;
          if (!pred(x, y)) continue;
          if (placeCluster(res, amt, x, y, rng.range(1.2, 1.9), 1) > 0) return;
        }
      }
    };
    for (const start of starts) {
      seamFor(start, TileResource.IronDep, 24);
      seamFor(start, TileResource.SilverDep, 20);
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
        inBounds(x, y, size) &&
        map.terrain[tileIdx(x, y, size)] === Terrain.Grass &&
        placeCluster(TileResource.GoldDep, 12, x, y, rng.range(1.4, 1.9), 1) > 0
      ) {
        break;
      }
    }
  } else {
    // Solo keeps the classic mid-ring, draw for draw: the campaign (and
    // both winnable playthrough tests) are tuned against these worlds, and
    // fairness-between-rivals has no meaning with one player.
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
        if (map.resource[tileIdx(x, y, size)] === TileResource.Rock) n++;
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
      if (!inBounds(x, y, size) || map.terrain[tileIdx(x, y, size)] !== Terrain.Grass) continue;
      placeCluster(TileResource.Rock, 10, x, y, 2, 0.85);
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
  if (map.terrain[from] !== Terrain.Grass || map.terrain[to] !== Terrain.Grass) return false;
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
    if (map.terrain[i] === Terrain.Grass && raw[i]! < LAKE_LEVEL_T) map.terrain[i] = Terrain.Water;
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
      if (reached[n] || map.terrain[n] !== Terrain.Grass) continue;
      reached[n] = 1;
      flood.push(n);
    }
  }
  for (let i = 0; i < tiles; i++) {
    if (map.terrain[i] === Terrain.Grass && !reached[i]) map.terrain[i] = Terrain.Water;
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
        if (map.terrain[tileIdx(x, y, size)] !== Terrain.Water) continue;
        for (const [nx, ny] of [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ] as const) {
          if (!inBounds(nx, ny, size)) continue;
          const n = tileIdx(nx, ny, size);
          if (map.terrain[n] === Terrain.Grass && reached[n] && !beltMask[n]) return true;
        }
      }
    }
    return false;
  };
  const fringe = Math.max(1, Math.floor(size / 24));
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
          if (edgeDist(x, y, size) < rimClear + clearK) continue;
          let clear = true;
          for (let dy = -clearK; dy <= clearK && clear; dy++) {
            for (let dx = -clearK; dx <= clearK; dx++) {
              const n = tileIdx(x + dx, y + dy, size);
              if (map.terrain[n] !== Terrain.Grass || !reached[n]) {
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
        map.terrain[i] = Terrain.Water;
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
  const dist = bfs((t) => t === Terrain.Water);
  // Land = anything that isn't water: rim rock counts, so the sea strip's
  // bed shelves off a cliff foot the same way it shelves off a beach.
  const landDist = bfs((t) => t !== Terrain.Water);

  for (let i = 0; i < tiles; i++) {
    const x = i % size;
    const y = (i / size) | 0;
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
      // Meadows ease down to the waterline over a few tiles; border-ridge
      // rock does NOT — its tallest rows stand right against the outer sea
      // strip, and easing them flattened the whole range to beach height.
      // A cliff coastline rises straight out of the water by definition.
      if (map.terrain[i] === Terrain.Rock) {
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
  for (let i = 0; i < tileCount(map.size); i++) {
    map.blocked[i] =
      tileBlocks(map.terrain[i]!, map.resource[i]!) || map.buildingAt[i]! >= 0 ? 1 : 0;
  }
}

/** Clear standing resources in a rect (used to make room for pre-placed buildings). */
export function clearResources(map: GameMap, x0: number, y0: number, w: number, h: number): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (!inBounds(x, y, map.size)) continue;
      const i = tileIdx(x, y, map.size);
      map.resource[i] = TileResource.None;
      map.resourceAmt[i] = 0;
    }
  }
}

/** Is every tile of the rect grass, resource-free, and building-free? */
export function rectClear(map: MapView, x0: number, y0: number, w: number, h: number): boolean {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (!inBounds(x, y, map.size)) return false;
      const i = tileIdx(x, y, map.size);
      if (map.terrain[i] !== Terrain.Grass) return false;
      if (map.resource[i] !== TileResource.None) return false;
      if (map.buildingAt[i] !== -1) return false;
    }
  }
  return true;
}
