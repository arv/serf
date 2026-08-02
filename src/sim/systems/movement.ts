import { tileIdx, tileX, tileY } from '../../shared/grid.ts';
import { TICKS_PER_SECOND } from '../defs/balance.ts';
import { UNIT_DEFS } from '../defs/units.ts';
import { tileSpeedMult } from '../path.ts';
import { getModifier } from '../techHelpers.ts';
import type { World } from '../world.ts';

/**
 * Advance every unit along its path. Waypoints are tile centers; speed is the
 * unit's tiles/sec scaled by the tile's trail/road multiplier. If the next
 * cell has become blocked (a building landed on it), drop the path — the
 * owner task re-plans on its next decision.
 */
export function movementSystem(world: World): void {
  // serfSpeed tech multiplier per player, computed once per tick instead of
  // per civilian (getModifier walks every researched tech's effects). Owners
  // without a player entry (BANDIT) fall back to the same baseline of 1.
  const serfSpeedMod: number[] = [];
  for (let owner = 0; owner < world.players.length; owner++) {
    serfSpeedMod[owner] = getModifier(world, owner, 'serfSpeed');
  }

  for (const unit of world.units.values()) {
    if (unit.dead || !unit.path) continue;
    const path = unit.path;

    const here = tileIdx(Math.floor(unit.x), Math.floor(unit.y));
    // Trail wear: bump the tile the unit just left.
    if (unit.lastTile !== here) {
      if (unit.lastTile >= 0) {
        world.map.wear[unit.lastTile] = world.map.wear[unit.lastTile]! + 1;
      }
      unit.lastTile = here;
    }
    const civilian = unit.kind === 'serf' || unit.kind === 'worker';
    let budget =
      (UNIT_DEFS[unit.kind].speed *
        tileSpeedMult(world.map, here) *
        (civilian ? (serfSpeedMod[unit.owner] ?? 1) : 1)) /
      TICKS_PER_SECOND;

    while (budget > 0 && unit.pathIdx < path.length) {
      const next = path[unit.pathIdx]!;
      if (world.map.blocked[next]) {
        unit.path = null;
        break;
      }
      const wx = tileX(next) + 0.5;
      const wy = tileY(next) + 0.5;
      const dx = wx - unit.x;
      const dy = wy - unit.y;
      const dist = Math.sqrt(dx * dx + dy * dy); // sqrt is IEEE-exact; hypot is not
      if (dist <= budget) {
        unit.x = wx;
        unit.y = wy;
        unit.pathIdx++;
        budget -= dist;
      } else {
        unit.x += (dx / dist) * budget;
        unit.y += (dy / dist) * budget;
        budget = 0;
      }
    }

    if (unit.path && unit.pathIdx >= path.length) {
      unit.path = null;
      if (unit.task.t === 'move') unit.task = { t: 'idle', until: world.tick };
    }
  }
}
