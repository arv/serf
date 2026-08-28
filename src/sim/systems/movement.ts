import {tileIdx, tileX, tileY} from '../../shared/grid.ts';
import {TICKS_PER_SECOND} from '../defs/balance.ts';
import * as ModifierKey from '../defs/modifierKeyEnum.ts';
import {UNIT_DEFS} from '../defs/units.ts';
import * as UnitTypeId from '../defs/unitTypeIdEnum.ts';
import {findPath, nearestWalkable, tileSpeedMult} from '../path.ts';
import {getModifier} from '../techHelpers.ts';
import type {Unit} from '../units.ts';
import * as UnitTaskKind from '../unitTaskKindEnum.ts';
import type {World} from '../world.ts';

/**
 * Advance every unit along its path. Waypoints are tile centers; speed is the
 * unit's tiles/sec scaled by the tile's trail/road multiplier. If the next
 * cell has become blocked (a building landed on it), route around it.
 */
export function movementSystem(world: World): void {
  const size = world.map.size;
  // serfSpeed tech multiplier per player, computed once per tick instead of
  // per civilian (getModifier walks every researched tech's effects). Owners
  // without a player entry (BANDIT) fall back to the same baseline of 1.
  const serfSpeedMod: number[] = [];
  for (let owner = 0; owner < world.players.length; owner++) {
    serfSpeedMod[owner] = getModifier(world, owner, ModifierKey.serfSpeed);
  }

  for (const unit of world.units.values()) {
    if (unit.dead || !unit.path) continue;
    const path = unit.path;

    const here = tileIdx(Math.floor(unit.x), Math.floor(unit.y), size);
    // Trail wear: bump the tile the unit just left.
    if (unit.lastTile !== here) {
      if (unit.lastTile >= 0) {
        world.map.wear[unit.lastTile] = world.map.wear[unit.lastTile]! + 1;
      }
      unit.lastTile = here;
    }
    const civilian =
      unit.kind === UnitTypeId.serf || unit.kind === UnitTypeId.worker;
    let budget =
      (UNIT_DEFS[unit.kind].speed *
        tileSpeedMult(world.map, here) *
        (civilian ? (serfSpeedMod[unit.owner] ?? 1) : 1)) /
      TICKS_PER_SECOND;

    while (budget > 0 && unit.pathIdx < path.length) {
      const next = path[unit.pathIdx]!;
      if (world.map.blocked[next]) {
        routeAround(world, unit, path[path.length - 1]!);
        break;
      }
      const wx = tileX(next, size) + 0.5;
      const wy = tileY(next, size) + 0.5;
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
      if (unit.task.t === UnitTaskKind.move)
        unit.task = {t: UnitTaskKind.idle, until: world.tick};
    }
  }
}

/**
 * A building landed on the route: plan a new one to the same goal.
 *
 * Simply dropping the path was wrong in two different ways, because a null
 * path is how every owner system reads "the walk is over" and it cannot tell
 * that from "the walk failed". Owners that act on arrival acted at a
 * distance — a hauler drew a good out of a storehouse tiles away, a recruit
 * was consumed by a barracks he never reached. And a plain move has no owner
 * system at all: nothing re-plans it and every other system filters for idle
 * units, so it stood on that tile for the rest of the match, taking its
 * cargo and (for an AI army waiting on the whole squad to arrive) the
 * attack it was part of with it.
 *
 * When the goal tile itself is what got built over, the walk aims at the
 * nearest open ground beside it instead. Every errand that ends at a
 * building already ends on a tile next to it, so this is the difference
 * between finishing the errand where it was headed and finishing it from
 * wherever the unit happened to be standing.
 *
 * A goal genuinely sealed off still leaves a null path — the state owners
 * already handle, and the one they can recover from. Holding the blocked
 * route instead would re-run a failed search every tick and freeze the unit
 * in a task no system recruits from, which is the very shape of bug this is
 * here to remove. A plain move is released to idle, where wander and the job
 * dispatcher can pick the unit up again.
 */
function routeAround(world: World, unit: Unit, goal: number): void {
  const size = world.map.size;
  const ux = Math.floor(unit.x);
  const uy = Math.floor(unit.y);
  let p = findPath(world.map, ux, uy, tileX(goal, size), tileY(goal, size));
  if (!p) {
    const beside = nearestWalkable(
      world.map,
      tileX(goal, size),
      tileY(goal, size),
      GOAL_SLIP,
    );
    if (beside >= 0)
      p = findPath(world.map, ux, uy, tileX(beside, size), tileY(beside, size));
  }
  unit.path = p && p.length > 0 ? p : null;
  unit.pathIdx = 0;
  if (unit.path === null && unit.task.t === UnitTaskKind.move) {
    unit.task = {t: UnitTaskKind.idle, until: world.tick};
  }
}

/** How far off a built-over goal the walk may re-aim and still be the same
 * errand. Past this the destination is not "beside the building" any more. */
const GOAL_SLIP = 3;
