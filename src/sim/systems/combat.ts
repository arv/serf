import { COUNTER_TABLE, UNIT_DEFS } from '../defs/units.ts';
import { BANDIT, centerOf, isPlayerOwner, type Building } from '../entities.ts';
import { tileX, tileY } from '../../shared/grid.ts';
import { exactDist } from '../../shared/math.ts';
import { distToFootprint } from '../arrival.ts';
import { findPath, findPathToAdjacent, nearestWalkable } from '../path.ts';
import { destroyBuilding, killUnit, type World } from '../world.ts';
import type { Unit } from '../units.ts';

/**
 * Thin, quarantined combat: reads positions, writes hp and movement intents.
 * The economy learns about combat solely through deaths flowing into
 * removeDead + logistics reconcile. The whole RPS system is COUNTER_TABLE
 * applied at the moment damage lands; target scoring prefers favorable
 * matchups so battles sort into counters without micro.
 */
export function combatSystem(world: World): void {
  // Per-tick caches, hoisted out of the per-unit loop. Arrays preserve Map
  // insertion order (ascending entity id), so every strict-< first-wins
  // selection below behaves exactly as scanning the Maps directly did.
  // Entities killed mid-loop stay in the arrays with dead=true, hence the
  // dead re-checks at each use site.
  const liveUnits: Unit[] = [];
  for (const u of world.units.values()) if (!u.dead) liveUnits.push(u);
  const liveBuildings: Building[] = [];
  for (const b of world.buildings.values()) if (!b.dead) liveBuildings.push(b);

  // Lazily computed camp, invalidated if it dies mid-tick (matching the old
  // per-unit rescan, which skipped dead camps and took the next one).
  let camp: Building | undefined;
  let campValid = false;
  const campOf = (): Building | undefined => {
    if (!campValid || (camp !== undefined && camp.dead)) {
      campValid = true;
      camp = undefined;
      for (const b of liveBuildings) {
        if (!b.dead && b.type === 'banditCamp') {
          camp = b;
          break;
        }
      }
    }
    return camp;
  };

  for (const unit of world.units.values()) {
    if (unit.dead) continue;
    const combat = UNIT_DEFS[unit.kind].combat;
    if (!combat) continue;

    if (unit.cooldownLeft > 0) unit.cooldownLeft--;

    // A plain move order suppresses auto-acquire until arrival; an
    // attack-move stays in this system and fights its way there. Dropping the
    // target rather than just skipping matters: retaliation (in strikeUnit)
    // can hang one on a unit that is walking away, and nothing below this
    // point would ever act on it or clear it, so the unit would keep
    // reporting itself as fighting an enemy it has left behind.
    if (unit.task.t === 'move') {
      disengage(unit);
      continue;
    }

    // The half order: quiet like a plain move until the path cursor crosses
    // engageIdx (the ordered route's midpoint), then a live attack-move for
    // the back leg. Going live re-acquires from scratch — being struck while
    // fleeing set targetId to exactly what the front leg was running from.
    // A path lost to new construction goes live early rather than quiet:
    // resumeAttackMove re-plans, but the original midpoint is meaningless
    // on a route that no longer exists.
    if (unit.task.t === 'attackMove' && unit.task.engageIdx !== undefined) {
      if (isDisengaging(unit)) {
        disengage(unit);
        continue;
      }
      unit.task = { t: 'attackMove', destX: unit.task.destX, destY: unit.task.destY };
      disengage(unit);
    }

    // Validate or acquire a target.
    let targetUnit: Unit | undefined;
    let targetBuilding: Building | undefined;
    if (unit.targetId !== undefined) {
      if (unit.targetIsBuilding) targetBuilding = world.buildings.get(unit.targetId);
      else targetUnit = world.units.get(unit.targetId);
      const gone = unit.targetIsBuilding
        ? !targetBuilding || targetBuilding.dead
        : !targetUnit || targetUnit.dead;
      if (gone) {
        disengage(unit);
        targetUnit = undefined;
        targetBuilding = undefined;
      }
    }

    // Camp guards hold their post. Without a leash a wandering serf tows
    // one into the village, and the pack follows it home.
    const guard = unit.owner === BANDIT && unit.task.t !== 'raid' ? campOf() : undefined;
    if (guard && distToBuilding(unit, guard) > GUARD_LEASH) {
      disengage(unit);
      if (unit.path === null && !(unit.repathAt !== undefined && world.tick < unit.repathAt)) {
        unit.path = findPathToAdjacent(
          world.map,
          Math.floor(unit.x),
          Math.floor(unit.y),
          guard.x,
          guard.y,
          guard.w,
          guard.h,
        );
        unit.pathIdx = 0;
        if (!unit.path) unit.repathAt = world.tick + 45;
      }
      continue;
    }

    if (unit.targetId === undefined) {
      targetUnit = acquireUnit(liveUnits, unit, combat.acquireRadius);
      if (targetUnit) {
        unit.targetId = targetUnit.id;
        unit.targetIsBuilding = false;
      } else if (unit.task.t === 'raid') {
        // An objective that just proved unreachable stays on the books, but
        // the unit holds instead of burning a worst-case path search at it
        // every tick (see Unit.repathAt).
        if (unit.repathAt !== undefined && world.tick < unit.repathAt) continue;
        // Strategic objective: the building this unit was sent against, or —
        // for bandits — any surviving enemy building. Player attackers go
        // home (idle) once their target is gone.
        targetBuilding = world.buildings.get(unit.task.buildingId);
        if (targetBuilding && (targetBuilding.dead || targetBuilding.owner === unit.owner)) {
          targetBuilding = undefined;
        }
        if (!targetBuilding && unit.owner === BANDIT) {
          targetBuilding = nearestEnemyBuilding(liveBuildings, unit);
          if (targetBuilding) unit.task = { t: 'raid', buildingId: targetBuilding.id };
        }
        if (targetBuilding) {
          unit.targetId = targetBuilding.id;
          unit.targetIsBuilding = true;
        } else {
          unit.task = { t: 'idle', until: world.tick };
        }
      } else if (isPlayerOwner(unit.owner)) {
        // No enemy units around: idle soldiers besiege enemy buildings in
        // acquire range. Without this, a squad that cuts down the camp's
        // guards stands politely beside the camp instead of finishing it.
        // Player armies only — camp guards get their targets from raids, or
        // three of them would demolish a base nobody ever provoked.
        const b = nearestEnemyBuilding(liveBuildings, unit);
        if (b && distToBuilding(unit, b) <= combat.acquireRadius) {
          unit.targetId = b.id;
          unit.targetIsBuilding = true;
          // Drop any path in hand so the engage step plans toward the
          // building now. An attack-move otherwise kept walking its route
          // with the target stuck on — building targets never drop by
          // distance, so it would double back after arriving instead of
          // fighting what it found on the way.
          unit.path = null;
        }
      }
    }

    if (unit.targetId === undefined) {
      if (unit.task.t === 'attackMove') resumeAttackMove(world, unit);
      continue;
    }

    // Engage: in range -> strike on cooldown; out of range -> close in.
    // Ranged units kite: they back off from anything closing to melee.
    if (targetUnit) {
      const dist = exactDist(targetUnit.x - unit.x, targetUnit.y - unit.y);
      const isRanged = combat.range > 2;
      if (isRanged && dist < 2.4) {
        if (dist <= combat.range && unit.cooldownLeft <= 0) {
          strikeUnit(world, unit, targetUnit);
          unit.cooldownLeft = combat.cooldownTicks;
        }
        kiteAway(world, unit, targetUnit);
      } else if (dist <= combat.range) {
        unit.path = null; // stand and fight
        if (unit.cooldownLeft <= 0) {
          strikeUnit(world, unit, targetUnit);
          unit.cooldownLeft = combat.cooldownTicks;
        }
      } else if (dist > combat.acquireRadius * 1.6) {
        disengage(unit); // it got away
      } else {
        chaseUnit(world, unit, targetUnit);
      }
    } else if (targetBuilding) {
      const near = distToBuilding(unit, targetBuilding);
      if (near <= Math.max(combat.range, 1.4)) {
        unit.path = null;
        if (unit.cooldownLeft <= 0) {
          targetBuilding.hp -= UNIT_DEFS[unit.kind].combat!.damage;
          if (isPlayerOwner(targetBuilding.owner)) {
            const c = centerOf(targetBuilding);
            world.pendingEvents.push({
              kind: 'damage',
              player: targetBuilding.owner,
              x: c.x,
              y: c.y,
              building: true,
            });
          }
          unit.cooldownLeft = combat.cooldownTicks;
          if (targetBuilding.hp <= 0) {
            destroyBuilding(world, targetBuilding);
            disengage(unit);
          }
        }
      } else if (unit.path === null) {
        unit.path = findPathToAdjacent(
          world.map,
          Math.floor(unit.x),
          Math.floor(unit.y),
          targetBuilding.x,
          targetBuilding.y,
          targetBuilding.w,
          targetBuilding.h,
        );
        unit.pathIdx = 0;
        if (!unit.path) {
          // Unreachable for now: stand down and do not try again for a
          // couple of seconds — the wall is not coming down this tick.
          unit.repathAt = world.tick + 45;
          disengage(unit);
        }
      }
    }
  }
}

/** How far a camp guard may stray from home before it turns back. */
const GUARD_LEASH = 9;

/**
 * Drop the fight. Both halves of the target go together: `targetIsBuilding`
 * is the discriminator that decides which map `targetId` is looked up in, so
 * a stale one left behind resolves the next target against the wrong map.
 */
function disengage(unit: Unit): void {
  unit.targetId = undefined;
  unit.targetIsBuilding = undefined;
}

/**
 * Is this unit under an order that says *walk away, don't fight*? A plain
 * move, or the quiet front leg of a half order. Such a unit is skipped by the
 * loop above, so anything that hands it a target hands it one that will never
 * be chased, struck or cleared.
 */
function isDisengaging(unit: Unit): boolean {
  if (unit.task.t === 'move') return true;
  return (
    unit.task.t === 'attackMove' &&
    unit.task.engageIdx !== undefined &&
    unit.path !== null &&
    unit.pathIdx < unit.task.engageIdx
  );
}

/**
 * An attack-move with no fight on: keep walking toward the ordered tile.
 * Chasing and stand-and-fight consume the original path, so the leg back to
 * the destination is re-planned here; standing on the goal tile (or finding
 * no way to it) ends the order the way a plain move ends — going idle.
 */
function resumeAttackMove(world: World, unit: Unit): void {
  if (unit.task.t !== 'attackMove' || unit.path !== null) return;
  const { destX, destY } = unit.task;
  const ux = Math.floor(unit.x);
  const uy = Math.floor(unit.y);
  if (ux === destX && uy === destY) {
    unit.task = { t: 'idle', until: world.tick };
    return;
  }
  const path = findPath(world.map, ux, uy, destX, destY);
  if (path && path.length > 0) {
    unit.path = path;
    unit.pathIdx = 0;
  } else {
    unit.task = { t: 'idle', until: world.tick };
  }
}

/** Nearest enemy unit in radius, preferring countered classes. */
function acquireUnit(units: readonly Unit[], unit: Unit, radius: number): Unit | undefined {
  const myClass = UNIT_DEFS[unit.kind].combat!.class;
  // Conservative squared-distance reject: anything strictly beyond
  // radius + 1 cannot pass `dist <= radius` below even after sqrt rounding,
  // so skipping it early is behavior-identical.
  const rejectSq = (radius + 1) * (radius + 1);
  let best: Unit | undefined;
  let bestScore = Infinity;
  for (const other of units) {
    if (other.dead || other.owner === unit.owner) continue;
    const dx = other.x - unit.x;
    const dy = other.y - unit.y;
    if (dx * dx + dy * dy > rejectSq) continue;
    const dist = exactDist(dx, dy);
    if (dist > radius) continue;
    const otherClass = UNIT_DEFS[other.kind].combat?.class;
    // Favor targets we counter; civilians are class-less easy prey for raiders.
    const advantage = otherClass ? COUNTER_TABLE[myClass][otherClass] : 1.2;
    const score = dist / advantage;
    if (score < bestScore) {
      bestScore = score;
      best = other;
    }
  }
  return best;
}

function strikeUnit(world: World, attacker: Unit, defender: Unit): void {
  const a = UNIT_DEFS[attacker.kind].combat!;
  const defClass = UNIT_DEFS[defender.kind].combat?.class;
  const mult = defClass ? COUNTER_TABLE[a.class][defClass] : 1;
  defender.hp -= a.damage * mult;
  if (isPlayerOwner(defender.owner)) {
    world.pendingEvents.push({
      kind: 'damage',
      player: defender.owner,
      x: defender.x,
      y: defender.y,
      building: false,
    });
  }
  // Fighting back: an idle victim with combat stats turns on its attacker.
  // A victim under a disengage order is not idle — it was told to walk away,
  // and the systems above will neither chase nor swing on its behalf, so
  // handing it a target would only make it look like it is fighting back.
  if (
    !defender.dead &&
    UNIT_DEFS[defender.kind].combat &&
    defender.targetId === undefined &&
    !isDisengaging(defender)
  ) {
    defender.targetId = attacker.id;
    defender.targetIsBuilding = false;
  }
  if (defender.hp <= 0) {
    killUnit(world, defender);
    disengage(attacker);
  }
}

function chaseUnit(world: World, unit: Unit, target: Unit): void {
  // Repath if we have no path or the target drifted from the path's end.
  const path = unit.path;
  if (path && unit.pathIdx < path.length) {
    const last = path[path.length - 1]!;
    const lx = tileX(last, world.map.size) + 0.5;
    const ly = tileY(last, world.map.size) + 0.5;
    if (exactDist(target.x - lx, target.y - ly) < 1.6) return; // path still good
  }
  const p = findPath(
    world.map,
    Math.floor(unit.x),
    Math.floor(unit.y),
    Math.floor(target.x),
    Math.floor(target.y),
  );
  if (p) {
    unit.path = p;
    unit.pathIdx = 0;
  }
}

/** Shoot-and-scoot: back away from a closing melee threat, keeping the bow drawn. */
function kiteAway(world: World, unit: Unit, threat: Unit): void {
  if (unit.path !== null && unit.pathIdx < unit.path.length) return; // already scooting
  const dx = unit.x - threat.x;
  const dy = unit.y - threat.y;
  const len = exactDist(dx, dy) || 1;
  const tx = Math.round(unit.x + (dx / len) * 3);
  const ty = Math.round(unit.y + (dy / len) * 3);
  const idx = nearestWalkable(world.map, tx, ty, 3);
  if (idx < 0) return;
  const size = world.map.size;
  const p = findPath(world.map, Math.floor(unit.x), Math.floor(unit.y), tileX(idx, size), tileY(idx, size));
  if (p && p.length > 0) {
    unit.path = p;
    unit.pathIdx = 0;
  }
}

function distToBuilding(unit: Unit, b: Building): number {
  return distToFootprint(unit, b.x, b.y, b.w, b.h);
}

function nearestEnemyBuilding(buildings: readonly Building[], unit: Unit): Building | undefined {
  let best: Building | undefined;
  let bestDist = Infinity;
  // Conservative squared-distance reject: anything strictly beyond
  // bestDist + 1 cannot pass `dist < bestDist` below even after sqrt
  // rounding, so skipping it early is behavior-identical.
  let rejectSq = Infinity;
  for (const b of buildings) {
    if (b.dead || b.owner === unit.owner) continue;
    const c = centerOf(b);
    const dx = c.x - unit.x;
    const dy = c.y - unit.y;
    if (dx * dx + dy * dy > rejectSq) continue;
    const dist = exactDist(dx, dy);
    if (dist < bestDist) {
      bestDist = dist;
      best = b;
      rejectSq = (bestDist + 1) * (bestDist + 1);
    }
  }
  return best;
}
