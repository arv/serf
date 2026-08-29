import {tileX, tileY} from '../../shared/grid.ts';
import {exactDist} from '../../shared/math.ts';
import {distToFootprint} from '../arrival.ts';
import * as BuildingState from '../buildingStateEnum.ts';
import {BUILDING_DAMAGE_MULT} from '../defs/balance.ts';
import {buildingDef, type BuildingDef} from '../defs/buildings.ts';
import * as BuildingTypeId from '../defs/buildingTypeIdEnum.ts';
import {
  COUNTER_TABLE,
  UNIT_DEFS,
  type UnitClass,
  type UnitTypeId,
} from '../defs/units.ts';
import {BANDIT, centerOf, isPlayerOwner, type Building} from '../entities.ts';
import * as GameEventKind from '../gameEventKindEnum.ts';
import {findPath, findPathToAdjacent, nearestWalkable} from '../path.ts';
import type {Unit} from '../units.ts';
import * as UnitTaskKind from '../unitTaskKindEnum.ts';
import {destroyBuilding, killUnit, type World} from '../world.ts';

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
  // The acquisition index over liveUnits — see buildUnitGrid. Built here,
  // once, because positions do not move again until the next tick.
  buildUnitGrid(liveUnits, world.map.size);

  // Lazily computed camp, invalidated if it dies mid-tick (matching the old
  // per-unit rescan, which skipped dead camps and took the next one).
  let camp: Building | undefined;
  let campValid = false;
  const campOf = (): Building | undefined => {
    if (!campValid || (camp !== undefined && camp.dead)) {
      campValid = true;
      camp = undefined;
      for (const b of liveBuildings) {
        if (!b.dead && b.type === BuildingTypeId.banditCamp) {
          camp = b;
          break;
        }
      }
    }
    return camp;
  };

  towerFire(world, liveBuildings, liveUnits);

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
    if (unit.task.t === UnitTaskKind.move) {
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
    if (
      unit.task.t === UnitTaskKind.attackMove &&
      unit.task.engageIdx !== undefined
    ) {
      if (isDisengaging(unit)) {
        disengage(unit);
        continue;
      }
      unit.task = {
        t: UnitTaskKind.attackMove,
        destX: unit.task.destX,
        destY: unit.task.destY,
      };
      disengage(unit);
    }

    // Validate or acquire a target.
    let targetUnit: Unit | undefined;
    let targetBuilding: Building | undefined;
    if (unit.targetId !== undefined) {
      if (unit.targetIsBuilding)
        targetBuilding = world.buildings.get(unit.targetId);
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
    const guard =
      unit.owner === BANDIT && unit.task.t !== UnitTaskKind.raid
        ? campOf()
        : undefined;
    if (guard && distToBuilding(unit, guard) > GUARD_LEASH) {
      disengage(unit);
      if (
        unit.path === null &&
        !(unit.repathAt !== undefined && world.tick < unit.repathAt)
      ) {
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
      } else if (unit.task.t === UnitTaskKind.raid) {
        // An objective that just proved unreachable stays on the books, but
        // the unit holds instead of burning a worst-case path search at it
        // every tick (see Unit.repathAt).
        if (unit.repathAt !== undefined && world.tick < unit.repathAt) continue;
        // Strategic objective: the building this unit was sent against, or —
        // for bandits — any surviving enemy building. Player attackers go
        // home (idle) once their target is gone.
        targetBuilding = world.buildings.get(unit.task.buildingId);
        if (
          targetBuilding &&
          (targetBuilding.dead || targetBuilding.owner === unit.owner)
        ) {
          targetBuilding = undefined;
        }
        if (!targetBuilding && unit.owner === BANDIT) {
          targetBuilding = nearestEnemyBuilding(liveBuildings, unit);
          if (targetBuilding)
            unit.task = {t: UnitTaskKind.raid, buildingId: targetBuilding.id};
        }
        if (targetBuilding) {
          unit.targetId = targetBuilding.id;
          unit.targetIsBuilding = true;
        } else {
          unit.task = {t: UnitTaskKind.idle, until: world.tick};
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
      if (unit.task.t === UnitTaskKind.attackMove)
        resumeAttackMove(world, unit);
      continue;
    }

    // A live fight breaks formation: chases, kiting and retreats all run at
    // true speeds, because the counter table prices them there — a spearman
    // held to knight pace never catches the archers he exists to catch.
    // Guarded: this runs per fighting unit per tick, and the bare write
    // would lazily add the field (a hidden-class transition) to every
    // soldier that never marched.
    if (unit.marchSpeed !== undefined) unit.marchSpeed = undefined;

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
          targetBuilding.hp -=
            combat.damage * BUILDING_DAMAGE_MULT[combat.class];
          if (isPlayerOwner(targetBuilding.owner)) {
            const c = centerOf(targetBuilding);
            world.pendingEvents.push({
              kind: GameEventKind.damage,
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

/**
 * Manned buildings loosing on what comes into reach.
 *
 * The garrison is a count rather than units (staffing.ts consumes the man
 * the way the barracks consumes a recruit), so the tower does the shooting
 * on their behalf: each man swings on the archer's own clock, at the
 * archer's reach plus what the height adds, for the archer's damage
 * sharpened by shooting down from cover. Two men in a tower are two men's
 * worth of arrows, not one.
 *
 * Reach is measured to the footprint, not the center, so a wide tower
 * covers the ground its wall stands on rather than losing a tile to its own
 * size. Units only: a tower defends a line, it does not conduct a siege.
 *
 * The search radius IS the firing range, unlike a soldier's — a soldier
 * acquires beyond his reach because he can walk the difference, and a
 * tower cannot. Searching wider would only let it fix on a man it has no
 * shot at and hold its fire while someone else stood inside the wall.
 */
function towerFire(
  world: World,
  buildings: readonly Building[],
  units: readonly Unit[],
): void {
  for (const b of buildings) {
    if (b.dead || b.state !== BuildingState.built) continue;
    const rule = buildingDef(b.type).garrison;
    if (!rule || !b.garrison) continue;
    const volley = volleyOf(rule, b.garrisonKind, b.garrison);
    if (!volley) continue;
    // Decrement first, then fire the tick the count reaches zero — the
    // unit flow's exact rhythm (cooldownLeft comes down at the top of the
    // tick and the strike still lands at <= 0), so a garrisoned archer
    // keeps the field archer's period. Continuing on the zeroing tick too,
    // as this used to, stretched every volley to cooldownTicks + 1.
    if ((b.attackCooldown ?? 0) > 0) b.attackCooldown!--;
    if ((b.attackCooldown ?? 0) > 0) continue;
    const target = acquireForBuilding(units, b, volley.class, volley.range);
    if (!target) continue;
    const defClass = UNIT_DEFS[target.kind].combat?.class;
    // The counter table, but only ever in the tower's favor. Its penalties
    // model closing on a shooter — light infantry beat archers by getting
    // inside their reach — and that is the one thing a man behind a wall
    // cannot have done to him. Applied whole, it docked a tower 0.67 for a
    // charge the charger had no way to finish, and bandits are what every
    // early wave is made of: it left the tower weakest against exactly the
    // attack it is built to stop. The bonuses stay — height does not help
    // a knight climb.
    const mult = defClass
      ? Math.max(1, COUNTER_TABLE[volley.class][defClass])
      : 1;
    target.hp -= volley.damage * mult;
    b.attackCooldown = volley.cooldownTicks;
    if (isPlayerOwner(target.owner)) {
      world.pendingEvents.push({
        kind: GameEventKind.damage,
        player: target.owner,
        x: target.x,
        y: target.y,
        building: false,
      });
    }
    if (target.hp <= 0) killUnit(world, target);
  }
}

/** One tower's shot: who it shoots like, for how much, how often, how far. */
interface Volley {
  class: UnitClass;
  damage: number;
  cooldownTicks: number;
  range: number;
}

/**
 * What the men in a tower loose this volley, which depends entirely on who
 * they are. Soldiers shoot with their own stats, sharpened by the height and
 * multiplied because two men in a tower are two men's worth of arrows rather
 * than one. The levy throws stones: the tower's own numbers, unsharpened,
 * and still once per man.
 */
function volleyOf(
  rule: NonNullable<BuildingDef['garrison']>,
  kind: UnitTypeId | undefined,
  men: number,
): Volley | undefined {
  if (men <= 0) return undefined;
  if (kind === rule.levy.unit) {
    const {class: cls, damage, cooldownTicks, range} = rule.levy;
    return {class: cls, damage: damage * men, cooldownTicks, range};
  }
  const combat = UNIT_DEFS[rule.unit].combat;
  if (!combat) return undefined;
  return {
    class: combat.class,
    damage: combat.damage * rule.damageMult * men,
    cooldownTicks: combat.cooldownTicks,
    range: combat.range + rule.rangeBonus,
  };
}

/**
 * The tower's pick: nearest enemy in reach, favoring the class its garrison
 * counters — the same scoring `acquireUnit` does for a soldier, measured
 * from the footprint instead of from a pair of coordinates.
 */
function acquireForBuilding(
  units: readonly Unit[],
  b: Building,
  myClass: UnitClass,
  radius: number,
): Unit | undefined {
  let best: Unit | undefined;
  let bestScore = Infinity;
  // A tower used to pay a square root for every soldier, serf and bandit on
  // the map, however far off. distToFootprint's clamp is inlined here so the
  // ones plainly out of reach cost two multiplies instead — the same
  // conservative `radius + 1` reject acquireUnit already uses, which no unit
  // that could pass `dist > radius` can fail.
  const x0 = b.x;
  const y0 = b.y;
  const x1 = b.x + b.w;
  const y1 = b.y + b.h;
  const owner = b.owner;
  const counters = COUNTER_TABLE[myClass];
  const rejectSq = (radius + 1) * (radius + 1);
  for (const other of units) {
    if (other.dead || other.owner === owner) continue;
    const ox = other.x;
    const oy = other.y;
    const dx = ox - Math.max(x0, Math.min(ox, x1));
    const dy = oy - Math.max(y0, Math.min(oy, y1));
    if (dx * dx + dy * dy > rejectSq) continue;
    const dist = exactDist(dx, dy); // === distToBuilding(other, b)
    if (dist > radius) continue;
    const otherClass = UNIT_DEFS[other.kind].combat?.class;
    const advantage = otherClass ? counters[otherClass] : 1.2;
    const score = dist / advantage;
    if (score < bestScore) {
      bestScore = score;
      best = other;
    }
  }
  return best;
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
  if (unit.task.t === UnitTaskKind.move) return true;
  return (
    unit.task.t === UnitTaskKind.attackMove &&
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
  if (unit.task.t !== UnitTaskKind.attackMove || unit.path !== null) return;
  const {destX, destY} = unit.task;
  const ux = Math.floor(unit.x);
  const uy = Math.floor(unit.y);
  if (ux === destX && uy === destY) {
    unit.task = {t: UnitTaskKind.idle, until: world.tick};
    unit.marchSpeed = undefined; // the march this pace was set for is over
    return;
  }
  const path = findPath(world.map, ux, uy, destX, destY);
  if (path && path.length > 0) {
    unit.path = path;
    unit.pathIdx = 0;
  } else {
    unit.task = {t: UnitTaskKind.idle, until: world.tick};
    unit.marchSpeed = undefined;
  }
}

/**
 * A uniform bucket grid over `liveUnits`, rebuilt once per tick.
 *
 * Target acquisition was the sim's one genuinely quadratic scan: every
 * soldier without a target against every living body on the map, every
 * tick. Soldiers are a small fraction of a valley — the serfs are the
 * bulk — so the villagers were what made it expensive, and a besieging
 * army made it worse in proportion to its own size.
 *
 * CELL must be at least the largest acquireRadius plus one (the
 * conservative reject below), so that the 3x3 block of cells around a
 * unit is a superset of every candidate that reject could admit. The
 * largest acquireRadius in UNIT_DEFS is 8 and CELL is 16, so the block
 * reaches at least 16 tiles in every direction; anything outside it is
 * provably beyond `radius` and could never have been chosen.
 *
 * Positions hold still for the whole pass — movement ran before combat,
 * and nothing here writes x or y — so one build per tick stays valid.
 * Units killed mid-pass stay in their bucket and are skipped by the same
 * `dead` re-check the flat scan used.
 */
const CELL_SHIFT = 4; // 16 tiles
let cellsPerSide = 0;
let cellHead = new Int32Array(0);
let cellNext = new Int32Array(0);

function cellCoord(v: number): number {
  const c = (v | 0) >> CELL_SHIFT;
  return c < 0 ? 0 : c >= cellsPerSide ? cellsPerSide - 1 : c;
}

function buildUnitGrid(units: readonly Unit[], size: number): void {
  const per = ((size - 1) >> CELL_SHIFT) + 1;
  if (per !== cellsPerSide || cellHead.length !== per * per) {
    cellsPerSide = per;
    cellHead = new Int32Array(per * per);
  }
  cellHead.fill(-1);
  if (cellNext.length < units.length)
    cellNext = new Int32Array(units.length * 2);
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    const c = cellCoord(u.y) * cellsPerSide + cellCoord(u.x);
    cellNext[i] = cellHead[c]!;
    cellHead[c] = i;
  }
}

/**
 * Nearest enemy unit in radius, preferring countered classes.
 *
 * Scanning the grid visits candidates in bucket order rather than in
 * `liveUnits` order, so the old "first strictly-better wins" rule would
 * have handed ties to a different unit — and ties are genuinely reachable
 * (two of a kind stopped the same distance away). The tie-break is
 * therefore made explicit: lowest score, and among equal scores the lowest
 * index into `liveUnits`. That is exactly what an ascending scan with a
 * strict `<` used to produce, and unlike that scan it does not depend on
 * the order the candidates arrive in.
 */
function acquireUnit(
  units: readonly Unit[],
  unit: Unit,
  radius: number,
): Unit | undefined {
  const myClass = UNIT_DEFS[unit.kind].combat!.class;
  // Conservative squared-distance reject: anything strictly beyond
  // radius + 1 cannot pass `dist <= radius` below even after sqrt rounding,
  // so skipping it early is behavior-identical.
  const rejectSq = (radius + 1) * (radius + 1);
  // Hoisted out of the loop: this is the innermost scan in the sim — every
  // untargeted soldier against every live unit, every tick — and the row
  // and the position never change while it runs.
  const counters = COUNTER_TABLE[myClass];
  const ux = unit.x;
  const uy = unit.y;
  const owner = unit.owner;
  let best: Unit | undefined;
  let bestScore = Infinity;
  let bestIdx = 0;
  const cx = cellCoord(ux);
  const cy = cellCoord(uy);
  const gx0 = cx > 0 ? cx - 1 : 0;
  const gx1 = cx + 1 < cellsPerSide ? cx + 1 : cellsPerSide - 1;
  const gy0 = cy > 0 ? cy - 1 : 0;
  const gy1 = cy + 1 < cellsPerSide ? cy + 1 : cellsPerSide - 1;
  for (let gy = gy0; gy <= gy1; gy++) {
    const row = gy * cellsPerSide;
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let i = cellHead[row + gx]!; i >= 0; i = cellNext[i]!) {
        const other = units[i]!;
        if (other.dead || other.owner === owner) continue;
        const dx = other.x - ux;
        const dy = other.y - uy;
        if (dx * dx + dy * dy > rejectSq) continue;
        const dist = exactDist(dx, dy);
        if (dist > radius) continue;
        const otherClass = UNIT_DEFS[other.kind].combat?.class;
        // Favor targets we counter; civilians are class-less easy prey for raiders.
        const advantage = otherClass ? counters[otherClass] : 1.2;
        const score = dist / advantage;
        if (score < bestScore || (score === bestScore && i < bestIdx)) {
          bestScore = score;
          best = other;
          bestIdx = i;
        }
      }
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
      kind: GameEventKind.damage,
      player: defender.owner,
      x: defender.x,
      y: defender.y,
      building: false,
    });
  }
  // Fighting back: an idle victim with combat stats turns on its attacker —
  // and so does one hammering a wall, because the wall will keep and the man
  // cutting him down will not. Building targets never drop on their own, so
  // without this a besieger died without ever answering a blow: three camp
  // guards could carve through ten target-locked archers who never loosed a
  // shot in reply (the raid task re-acquires the camp once the threat is
  // dead, so the siege resumes rather than being abandoned). A victim
  // already fighting a unit keeps its fight, and one under a disengage order
  // is not idle — it was told to walk away, and the systems above will
  // neither chase nor swing on its behalf, so handing it a target would only
  // make it look like it is fighting back.
  if (
    !defender.dead &&
    UNIT_DEFS[defender.kind].combat &&
    (defender.targetId === undefined || defender.targetIsBuilding) &&
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
  const p = findPath(
    world.map,
    Math.floor(unit.x),
    Math.floor(unit.y),
    tileX(idx, size),
    tileY(idx, size),
  );
  if (p && p.length > 0) {
    unit.path = p;
    unit.pathIdx = 0;
  }
}

function distToBuilding(unit: Unit, b: Building): number {
  return distToFootprint(unit, b.x, b.y, b.w, b.h);
}

function nearestEnemyBuilding(
  buildings: readonly Building[],
  unit: Unit,
): Building | undefined {
  let best: Building | undefined;
  let bestDist = Infinity;
  // Conservative squared-distance reject: anything strictly beyond
  // bestDist + 1 cannot pass `dist < bestDist` below even after sqrt
  // rounding, so skipping it early is behavior-identical.
  let rejectSq = Infinity;
  // Read the position once. This runs per idle soldier per tick over every
  // building, and centerOf's `{x, y}` used to be allocated on each of those
  // — thousands of one-tick objects a second, for two additions.
  const ux = unit.x;
  const uy = unit.y;
  for (const b of buildings) {
    if (b.dead || b.owner === unit.owner) continue;
    const dx = b.x + b.w / 2 - ux; // centerOf(b), inlined: identical arithmetic
    const dy = b.y + b.h / 2 - uy;
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
