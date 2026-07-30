import { buildingDef } from '../defs/buildings';
import { UNIT_DEFS } from '../defs/units';
import { getModifier, isUnitUnlocked } from '../techHelpers';
import { HIRE_SERF_TICKS, TRAIN_QUEUE_CAP } from '../defs/balance';
import { spawnUnit, type World } from '../world';
import { nearestWalkable } from '../path';
import { tileX, tileY } from '../../shared/grid';
import type { GoodId } from '../defs/goods';
import type { Building } from '../entities';

/**
 * Dojo training. A queue item starts when its ingredients are in the input
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
    }
  }
}

/**
 * Hiring. Silver bought the recruit at the moment the order was placed
 * (see the hireSerf command); this walks the queue down and puts them at
 * the storehouse door, one every HIRE_SERF_TICKS.
 */
export function hiringSystem(world: World): void {
  for (const b of world.buildings.values()) {
    if (b.dead || b.state !== 'built' || !b.hireQueue) continue;
    b.hireTicksLeft = (b.hireTicksLeft ?? HIRE_SERF_TICKS) - 1;
    if (b.hireTicksLeft > 0) continue;
    const door = doorOf(world, b);
    spawnUnit(world, 'serf', b.owner, door.x, door.y);
    b.hireQueue--;
    b.hireTicksLeft = b.hireQueue > 0 ? HIRE_SERF_TICKS : undefined;
  }
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

function doorOf(world: World, b: Building): { x: number; y: number } {
  const idx = nearestWalkable(world.map, Math.floor(b.x + b.w / 2), b.y + b.h, 6);
  if (idx >= 0) return { x: tileX(idx) + 0.5, y: tileY(idx) + 0.5 };
  return { x: b.x + b.w / 2, y: b.y + b.h + 0.5 };
}