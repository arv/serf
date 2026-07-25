import { TRAIN_QUEUE_CAP, WORKER_RESPAWN_TICKS } from '../defs/balance';
import { buildingDef } from '../defs/buildings';
import { UNIT_DEFS } from '../defs/units';
import { getModifier, isUnitUnlocked } from '../techHelpers';
import { spawnUnit, type World } from '../world';
import { bindWorker } from './production';
import { nearestWalkable } from '../path';
import { tileX, tileY } from '../../shared/grid';
import type { GoodId } from '../defs/goods';
import type { Building } from '../entities';

/**
 * Dojo training: queue items wait for their weapon+rice inputs (hauled by
 * the ordinary demand system), then a timer pops a fresh unit at the door.
 * militaryHp modifiers apply at spawn time. Also handles respawning lost
 * resident workers for producers.
 */
export function trainingSystem(world: World): void {
  for (const b of world.buildings.values()) {
    if (b.dead || b.state !== 'built') continue;
    respawnLostWorker(world, b);
    const def = buildingDef(b.type);
    if (!def.trains || !b.trainQueue || b.trainQueue.length === 0) continue;

    const head = b.trainQueue[0]!;
    const option = def.trains.find((o) => o.unit === head.unit);
    if (!option) {
      b.trainQueue.shift();
      continue;
    }

    if (!head.started) {
      const affordable = (Object.entries(option.cost) as [GoodId, number][]).every(
        ([good, n]) => (b.inputs[good] ?? 0) >= n,
      );
      if (!affordable) continue; // demands are in flight
      for (const [good, n] of Object.entries(option.cost) as [GoodId, number][]) {
        b.inputs[good] = (b.inputs[good] ?? 0) - n;
        world.ledger.consumed[good] = (world.ledger.consumed[good] ?? 0) + n;
      }
      head.started = true;
      head.ticksLeft = option.durationTicks;
      continue;
    }

    head.ticksLeft--;
    if (head.ticksLeft <= 0) {
      b.trainQueue.shift();
      const door = doorOf(world, b);
      const unit = spawnUnit(world, head.unit, b.owner, door.x, door.y);
      unit.hp = Math.round(UNIT_DEFS[head.unit].hp * getModifier(world, 'militaryHp'));
    }
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
  if (!isUnitUnlocked(world, option.unit)) return;
  b.trainQueue ??= [];
  if (b.trainQueue.length >= TRAIN_QUEUE_CAP) return;
  b.trainQueue.push({ unit: option.unit, ticksLeft: 0, started: false });
}

function respawnLostWorker(world: World, b: Building): void {
  const def = buildingDef(b.type);
  if (!def.workerKind) return;
  const worker = b.workerId !== undefined ? world.units.get(b.workerId) : undefined;
  if (worker && !worker.dead) {
    b.workerRespawnAt = undefined;
    return;
  }
  if (b.workerRespawnAt === undefined) {
    b.workerRespawnAt = world.tick + WORKER_RESPAWN_TICKS;
  } else if (world.tick >= b.workerRespawnAt) {
    const door = doorOf(world, b);
    const fresh = spawnUnit(world, def.workerKind, b.owner, door.x, door.y);
    bindWorker(b, fresh);
    b.workerRespawnAt = undefined;
  }
}

function doorOf(world: World, b: Building): { x: number; y: number } {
  const idx = nearestWalkable(world.map, Math.floor(b.x + b.w / 2), b.y + b.h, 6);
  if (idx >= 0) return { x: tileX(idx) + 0.5, y: tileY(idx) + 0.5 };
  return { x: b.x + b.w / 2, y: b.y + b.h + 0.5 };
}
