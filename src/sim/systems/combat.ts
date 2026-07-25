import { COUNTER_TABLE, UNIT_DEFS } from '../defs/units';
import { centerOf, type Building } from '../entities';
import { findPath, findPathToAdjacent, nearestWalkable } from '../path';
import { destroyBuilding, killUnit, type World } from '../world';
import type { Unit } from '../units';

/**
 * Thin, quarantined combat: reads positions, writes hp and movement intents.
 * The economy learns about combat solely through deaths flowing into
 * removeDead + logistics reconcile. The whole RPS system is COUNTER_TABLE
 * applied at the moment damage lands; target scoring prefers favorable
 * matchups so battles sort into counters without micro.
 */
export function combatSystem(world: World): void {
  for (const unit of world.units.values()) {
    if (unit.dead) continue;
    const combat = UNIT_DEFS[unit.kind].combat;
    if (!combat) continue;

    if (unit.cooldownLeft > 0) unit.cooldownLeft--;

    // Explicit move orders suppress auto-acquire until arrival.
    if (unit.task.t === 'move') continue;

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
        unit.targetId = undefined;
        unit.targetIsBuilding = undefined;
        targetUnit = undefined;
        targetBuilding = undefined;
      }
    }

    if (unit.targetId === undefined) {
      targetUnit = acquireUnit(world, unit, combat.acquireRadius);
      if (targetUnit) {
        unit.targetId = targetUnit.id;
        unit.targetIsBuilding = false;
      } else if (unit.task.t === 'raid') {
        // Strategic objective: the building this unit was sent against, or —
        // for bandits — any surviving enemy building. Player attackers go
        // home (idle) once their target is gone.
        targetBuilding = world.buildings.get(unit.task.buildingId);
        if (targetBuilding && (targetBuilding.dead || targetBuilding.owner === unit.owner)) {
          targetBuilding = undefined;
        }
        if (!targetBuilding && unit.owner === 'bandit') {
          targetBuilding = nearestEnemyBuilding(world, unit);
          if (targetBuilding) unit.task = { t: 'raid', buildingId: targetBuilding.id };
        }
        if (targetBuilding) {
          unit.targetId = targetBuilding.id;
          unit.targetIsBuilding = true;
        } else {
          unit.task = { t: 'idle', until: world.tick };
        }
      }
    }

    if (unit.targetId === undefined) continue;

    // Engage: in range -> strike on cooldown; out of range -> close in.
    // Ranged units kite: they back off from anything closing to melee.
    if (targetUnit) {
      const dist = Math.hypot(targetUnit.x - unit.x, targetUnit.y - unit.y);
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
        unit.targetId = undefined; // it got away
      } else {
        chaseUnit(world, unit, targetUnit);
      }
    } else if (targetBuilding) {
      const near = distToBuilding(unit, targetBuilding);
      if (near <= Math.max(combat.range, 1.4)) {
        unit.path = null;
        if (unit.cooldownLeft <= 0) {
          targetBuilding.hp -= UNIT_DEFS[unit.kind].combat!.damage;
          unit.cooldownLeft = combat.cooldownTicks;
          if (targetBuilding.hp <= 0) {
            destroyBuilding(world, targetBuilding);
            unit.targetId = undefined;
            unit.targetIsBuilding = undefined;
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
        if (!unit.path) unit.targetId = undefined; // unreachable for now
      }
    }
  }
}

/** Nearest enemy unit in radius, preferring countered classes. */
function acquireUnit(world: World, unit: Unit, radius: number): Unit | undefined {
  const myClass = UNIT_DEFS[unit.kind].combat!.class;
  let best: Unit | undefined;
  let bestScore = Infinity;
  for (const other of world.units.values()) {
    if (other.dead || other.owner === unit.owner) continue;
    const dist = Math.hypot(other.x - unit.x, other.y - unit.y);
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
  // Fighting back: an idle victim with combat stats turns on its attacker.
  if (!defender.dead && UNIT_DEFS[defender.kind].combat && defender.targetId === undefined) {
    defender.targetId = attacker.id;
    defender.targetIsBuilding = false;
  }
  if (defender.hp <= 0) {
    killUnit(world, defender);
    attacker.targetId = undefined;
  }
}

function chaseUnit(world: World, unit: Unit, target: Unit): void {
  // Repath if we have no path or the target drifted from the path's end.
  const path = unit.path;
  if (path && unit.pathIdx < path.length) {
    const last = path[path.length - 1]!;
    const lx = (last % 64) + 0.5;
    const ly = Math.floor(last / 64) + 0.5;
    if (Math.hypot(target.x - lx, target.y - ly) < 1.6) return; // path still good
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
  const len = Math.hypot(dx, dy) || 1;
  const tx = Math.round(unit.x + (dx / len) * 3);
  const ty = Math.round(unit.y + (dy / len) * 3);
  const idx = nearestWalkable(world.map, tx, ty, 3);
  if (idx < 0) return;
  const p = findPath(world.map, Math.floor(unit.x), Math.floor(unit.y), idx % 64, Math.floor(idx / 64));
  if (p && p.length > 0) {
    unit.path = p;
    unit.pathIdx = 0;
  }
}

function distToBuilding(unit: Unit, b: Building): number {
  const cx = Math.max(b.x, Math.min(unit.x, b.x + b.w));
  const cy = Math.max(b.y, Math.min(unit.y, b.y + b.h));
  return Math.hypot(unit.x - cx, unit.y - cy);
}

function nearestEnemyBuilding(world: World, unit: Unit): Building | undefined {
  let best: Building | undefined;
  let bestDist = Infinity;
  for (const b of world.buildings.values()) {
    if (b.dead || b.owner === unit.owner) continue;
    const c = centerOf(b);
    const dist = Math.hypot(c.x - unit.x, c.y - unit.y);
    if (dist < bestDist) {
      bestDist = dist;
      best = b;
    }
  }
  return best;
}
