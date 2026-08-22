import { buildingDef } from '../defs/buildings.ts';
import { UNIT_DEFS } from '../defs/units.ts';
import { getModifier, isUnitUnlocked } from '../techHelpers.ts';
import { HIRE_SERF_TICKS, TRAIN_QUEUE_CAP } from '../defs/balance.ts';
import { spawnUnit, type World } from '../world.ts';
import { popCapOf, populationOf } from '../population.ts';
import { findPath, nearestWalkable } from '../path.ts';
import { tileX, tileY } from '../../shared/grid.ts';
import type { GoodId } from '../defs/goods.ts';
import type { Building } from '../entities.ts';
import type { Unit } from '../units.ts';

/**
 * Barracks training. A queue item starts when its ingredients are in the input
 * buffer AND a serf recruit walks in (the staffing system delivers both the
 * skip-ahead pick and the person — soldiers consume population). This system
 * ticks the started item and pops the finished soldier at the door.
 */
export function trainingSystem(world: World): void {
  for (const b of world.buildings.values()) {
    if (b.dead || b.state !== 'built') continue;
    const def = buildingDef(b.type);
    if (!def.trains || !b.trainQueue || b.trainQueue.length === 0) continue;

    const head = b.trainQueue[0]!;
    const option = def.trains.find((o) => o.unit === head.unit);
    if (!option) {
      b.trainQueue.shift();
      continue;
    }
    if (!head.started) continue; // waiting on ingredients + a recruit

    head.ticksLeft--;
    if (head.ticksLeft <= 0) {
      b.trainQueue.shift();
      const door = doorOf(world, b);
      const unit = spawnUnit(world, head.unit, b.owner, door.x, door.y);
      unit.hp = Math.round(UNIT_DEFS[head.unit].hp * getModifier(world, b.owner, 'militaryHp'));
      marchToRally(world, b, unit);
    }
  }
}

/**
 * Send a fresh soldier from the door to the building's rally flag, as the
 * plain move a right-click gives: he ignores enemies on the way and stands
 * guard where the flag is (idle soldiers auto-acquire, so he defends the
 * ground he was mustered on). Deliberately not an attack-move — a flag
 * planted to collect an army must not trickle recruits into a fight one at
 * a time. No flag, or no way to walk there, and he stays at the door as
 * ever.
 */
function marchToRally(world: World, b: Building, unit: Unit): void {
  if (!b.rally) return;
  const size = world.map.size;
  // The same forgiveness a move order's target gets: a flag on ground that
  // has since been built over still means "muster near there".
  const goal = nearestWalkable(world.map, b.rally.x, b.rally.y, 6);
  if (goal < 0) return;
  const path = findPath(
    world.map,
    Math.floor(unit.x),
    Math.floor(unit.y),
    tileX(goal, size),
    tileY(goal, size),
  );
  if (!path) return;
  unit.path = path;
  unit.pathIdx = 0;
  unit.task = { t: 'move' };
}

/**
 * Hiring. Silver bought the recruit at the moment the order was placed
 * (see the hireSerf command); this walks the queue down and puts them at
 * the storehouse door, one every HIRE_SERF_TICKS.
 *
 * The hire order checked for a free bed, but the walk takes eight seconds
 * and a house can burn down inside it. A recruit who arrives to no room
 * waits at the gate — timer spent, still queued — and moves in the instant
 * one opens. Silver already paid is never quietly eaten.
 */
export function hiringSystem(world: World): void {
  for (const b of world.buildings.values()) {
    if (b.dead || b.state !== 'built' || !b.hireQueue) continue;
    b.hireTicksLeft = Math.max(0, (b.hireTicksLeft ?? HIRE_SERF_TICKS) - 1);
    if (b.hireTicksLeft > 0) continue;
    if (populationOf(world, b.owner) >= popCapOf(world, b.owner)) continue; // no bed yet
    const door = doorOf(world, b);
    spawnUnit(world, 'serf', b.owner, door.x, door.y);
    b.hireQueue--;
    b.hireTicksLeft = b.hireQueue > 0 ? HIRE_SERF_TICKS : undefined;
  }
}

/**
 * March `n` of a building's garrison back out of the door as soldiers again.
 * The men inside are a count, not units (staffing.ts consumed them), so
 * this is a spawn rather than a release — the mirror of what the barracks
 * does when a started order is cancelled.
 */
export function evictGarrison(world: World, b: Building, n: number): void {
  const rule = buildingDef(b.type).garrison;
  if (!rule) return;
  const out = Math.min(n, b.garrison ?? 0);
  if (out <= 0) return;
  // Whoever actually went up comes back down: a called-out villager returns
  // a villager, not an archer the player never trained.
  const kind = b.garrisonKind ?? rule.unit;
  const isLevy = kind === rule.levy.unit;
  // One door for the lot: spawning a man does not move it, and doorOf runs
  // a nearestWalkable search each time it is asked.
  const door = doorOf(world, b);
  for (let i = 0; i < out; i++) {
    const unit = spawnUnit(world, kind, b.owner, door.x, door.y);
    // Armour research is a soldier's; a serf goes back to work as he was.
    if (!isLevy) {
      unit.hp = Math.round(UNIT_DEFS[kind].hp * getModifier(world, b.owner, 'militaryHp'));
    }
  }
  b.garrison = (b.garrison ?? 0) - out || undefined;
  // Empty towers have no kind — that is what lets the next man set it.
  if (b.garrison === undefined) b.garrisonKind = undefined;
}

/** Sum of goods the building's training queue still needs (for the matcher). */
export function trainingDemand(b: Building): Partial<Record<GoodId, number>> {
  const def = buildingDef(b.type);
  const need: Partial<Record<GoodId, number>> = {};
  if (!def.trains || !b.trainQueue) return need;
  for (const item of b.trainQueue) {
    if (item.started) continue;
    const option = def.trains.find((o) => o.unit === item.unit);
    if (!option) continue;
    for (const [good, n] of Object.entries(option.cost) as [GoodId, number][]) {
      need[good] = (need[good] ?? 0) + n;
    }
  }
  return need;
}

export function enqueueTraining(world: World, b: Building, unit: string): void {
  const def = buildingDef(b.type);
  const option = def.trains?.find((o) => o.unit === unit);
  if (!option || b.state !== 'built' || b.dead) return;
  if (!isUnitUnlocked(world, b.owner, option.unit)) return;
  b.trainQueue ??= [];
  if (b.trainQueue.length >= TRAIN_QUEUE_CAP) return;
  b.trainQueue.push({ unit: option.unit, ticksLeft: 0, started: false });
}

/**
 * Remove the queue item the player pointed at. `unit` rides along as a
 * guard: the click aimed at a snapshot a few ticks stale, and the queue can
 * shift underneath it (an item finishing, the skip-ahead reorder). A
 * mismatch means the slot no longer holds what the player saw — drop the
 * order rather than cancel a different one.
 *
 * An unstarted item owes nothing: its ingredients are still in the input
 * buffer (or still on a serf's back) and stay at the barracks for whatever
 * is ordered next. A started item has already eaten its ingredients and its
 * recruit, and both walk back out — goods into the input buffer, the person
 * out the door as a serf. Only the training time already spent is lost.
 */
export function cancelTraining(world: World, b: Building, index: number, unit: string): void {
  const item = b.trainQueue?.[index];
  if (!item || item.unit !== unit) return;
  b.trainQueue!.splice(index, 1);
  if (!item.started) return;
  const option = buildingDef(b.type).trains?.find((o) => o.unit === item.unit);
  if (option) {
    for (const [good, n] of Object.entries(option.cost) as [GoodId, number][]) {
      b.inputs[good] = (b.inputs[good] ?? 0) + n;
      world.ledger.consumed[good] = (world.ledger.consumed[good] ?? 0) - n;
    }
  }
  const door = doorOf(world, b);
  spawnUnit(world, 'serf', b.owner, door.x, door.y);
}

export function doorOf(world: World, b: Building): { x: number; y: number } {
  const idx = nearestWalkable(world.map, Math.floor(b.x + b.w / 2), b.y + b.h, 6);
  const size = world.map.size;
  if (idx >= 0) return { x: tileX(idx, size) + 0.5, y: tileY(idx, size) + 0.5 };
  return { x: b.x + b.w / 2, y: b.y + b.h + 0.5 };
}