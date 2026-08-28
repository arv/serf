import {
  MAX_CONCURRENT_PAVING,
  PAVE_INTERVAL,
  PAVE_WEAR_THRESHOLD,
  TRAILS_INTERVAL,
  TRAIL_REVERT_WEAR,
  TRAIL_WEAR_THRESHOLD,
  WEAR_DECAY,
} from '../defs/balance.ts';
import { tileX, tileY } from '../../shared/grid.ts';
import { buildingDef } from '../defs/buildings.ts';
import { PathLevel, Terrain } from '../map.ts';
import { isPlayerOwner, type Owner } from '../entities.ts';
import { placeSite, pushDelta, type World } from '../world.ts';
import { BuildingTypeId } from '../defs/buildings.ts';
import { BuildingState } from '../entities.ts';

/**
 * Emergent trails, the Settlers homage: foot traffic wears tiles (movement
 * bumps `map.wear` when a unit leaves a tile); worn tiles become dirt trails
 * (faster, preferred by A*), unused trails fade back to grass. Stone-road
 * paving arrives in M3 on top of the same data.
 */
export function trailsSystem(world: World): void {
  paveStep(world);
  if (world.tick === 0 || world.tick % TRAILS_INTERVAL !== 0) return;
  const map = world.map;
  for (let i = 0; i < map.wear.length; i++) {
    const wear = map.wear[i]!;
    if (wear <= 0) continue;
    map.wear[i] = wear * WEAR_DECAY;

    const level = map.pathLevel[i]!;
    if (level === PathLevel.None) {
      if (
        wear >= TRAIL_WEAR_THRESHOLD &&
        map.terrain[i] === Terrain.Grass &&
        map.buildingAt[i]! < 0
      ) {
        map.pathLevel[i] = PathLevel.Trail;
        pushDelta(world, i);
      }
    } else if (level === PathLevel.Trail && wear < TRAIL_REVERT_WEAR) {
      map.pathLevel[i] = PathLevel.None;
      pushDelta(world, i);
    }
    // Roads (PathLevel.Road) never revert.
  }
}

/**
 * Stone paving (Masonry): sustained high-wear trails become road "sites" —
 * ordinary 1x1 construction sites with a priority-3 stone demand, so the
 * whole logistics machinery (matcher, serfs, cancellation) applies unchanged.
 * Capped concurrency keeps paving from starving real construction.
 */
function paveStep(world: World): void {
  // Cadence first. Both guards are side-effect-free early returns, so the
  // order between them is invisible — but the seat scan used to run on
  // every tick to serve a pass that can only do work on one tick in
  // PAVE_INTERVAL, and now runs only on the ticks that can use it.
  if (world.tick === 0 || world.tick % PAVE_INTERVAL !== 0) return;
  if (!world.players.some((p) => p.pavingUnlocked)) return;

  let active = 0;
  for (const b of world.buildings.values()) {
    if (!b.dead && b.type === BuildingTypeId.roadSite) active++;
  }
  if (active >= MAX_CONCURRENT_PAVING) return;

  // Best candidates by wear, few per pass.
  const map = world.map;
  const picks: number[] = [];
  for (let i = 0; i < map.wear.length; i++) {
    if (map.pathLevel[i] !== PathLevel.Trail) continue;
    if (map.wear[i]! < PAVE_WEAR_THRESHOLD) continue;
    if (map.buildingAt[i] !== -1 || map.blocked[i]) continue;
    picks.push(i);
  }
  picks.sort((a, z) => map.wear[z]! - map.wear[a]! || a - z);
  const size = map.size;
  for (const idx of picks.slice(0, MAX_CONCURRENT_PAVING - active)) {
    // The stone bill goes to whoever wore the trail: attribute the tile to
    // the nearest live storage building's owner — and only pave when that
    // owner has actually researched Masonry.
    const owner = nearestStorageOwner(world, tileX(idx, size), tileY(idx, size));
    if (owner === undefined || !world.players[owner]?.pavingUnlocked) continue;
    placeSite(world, BuildingTypeId.roadSite, owner, tileX(idx, size), tileY(idx, size));
  }
}

/** Owner of the nearest live storage building (ties: lowest owner id wins
 * via the buildings map's insertion order). */
function nearestStorageOwner(world: World, x: number, y: number): Owner | undefined {
  let best: Owner | undefined;
  let bestDist = Infinity;
  for (const b of world.buildings.values()) {
    if (b.dead || b.state !== BuildingState.built || !buildingDef(b.type).storage) continue;
    if (!isPlayerOwner(b.owner)) continue;
    const dist = Math.max(Math.abs(b.x + b.w / 2 - x), Math.abs(b.y + b.h / 2 - y));
    if (dist < bestDist) {
      bestDist = dist;
      best = b.owner;
    }
  }
  return best;
}
