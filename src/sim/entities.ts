import type { GoodAmounts } from './defs/goods';
import type { BuildingTypeId } from './defs/buildings';
import type { UnitTypeId } from './defs/units';

/**
 * Entity records are plain serializable data. Cross-entity references are IDs
 * only; a failed lookup means the entity died and callers must handle it.
 */
export type EntityId = number;

export type Owner = 'player' | 'bandit';

export type { BuildingTypeId };

export interface Building {
  id: EntityId;
  type: BuildingTypeId;
  owner: Owner;
  /** Footprint origin tile + size. */
  x: number;
  y: number;
  w: number;
  h: number;
  hp: number;
  state: 'site' | 'built';
  /** Remaining construction materials (site only). */
  siteNeeds?: GoodAmounts;
  /** Build timer ticks accumulated once materials are complete (site only). */
  buildProgress?: number;
  /** Output stock for producers; everything for the storehouse. */
  stock: GoodAmounts;
  /** Input stock for convert recipes (M3+). */
  inputs: GoodAmounts;
  /** Reserved incoming goods (haul jobs targeting this building). */
  inbound: GoodAmounts;
  /** Reserved outgoing goods (haul jobs picking up from this building). */
  reservedOut: GoodAmounts;
  /** First tick each good's unmet demand appeared (FIFO anti-starvation). */
  demandSince: GoodAmounts;
  /** Resident worker (gather/convert buildings). */
  workerId?: EntityId;
  /** Convert recipe: ticks left on the current batch (undefined = not running). */
  prodTicksLeft?: number;
  /** Military training queue (dojo). */
  trainQueue?: { unit: UnitTypeId; ticksLeft: number; started: boolean }[];
  /** When to respawn a lost resident worker. */
  workerRespawnAt?: number;
  dead: boolean;
}

export function centerOf(b: Building): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}
