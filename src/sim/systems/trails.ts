import {
  MAX_CONCURRENT_PAVING,
  PAVE_INTERVAL,
  PAVE_WEAR_THRESHOLD,
  TRAILS_INTERVAL,
  TRAIL_REVERT_WEAR,
  TRAIL_WEAR_THRESHOLD,
  WEAR_DECAY,
} from '../defs/balance';
import { tileX, tileY } from '../../shared/grid';
import { PathLevel, Terrain } from '../map';
import { placeSite, pushDelta, type World } from '../world';

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
  if (!world.pavingUnlocked) return;
  if (world.tick === 0 || world.tick % PAVE_INTERVAL !== 0) return;

  let active = 0;
  for (const b of world.buildings.values()) {
    if (!b.dead && b.type === 'roadSite') active++;
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
  picks.sort((a, z) => map.wear[z]! - map.wear[a]!);
  for (const idx of picks.slice(0, MAX_CONCURRENT_PAVING - active)) {
    placeSite(world, 'roadSite', 'player', tileX(idx), tileY(idx));
  }
}
