import type { GoodAmounts } from './defs/goods';
import type { BuildingTypeId } from './defs/buildings';
import type { UnitTypeId } from './defs/units';

/**
 * Entity records are plain serializable data. Cross-entity references are IDs
 * only; a failed lookup means the entity died and callers must handle it.
 */
export type EntityId = number;

/**
 * Owners are numeric: 0..MAX_PLAYERS-1 are player slots (=== the playerId in
 * command envelopes === the index into world.players), BANDIT is the neutral
 * raider faction. The value rides the SAB aux byte raw, so it must fit u8.
 */
export type Owner = number;
export const MAX_PLAYERS = 4;
export const BANDIT: Owner = 255;
/** 254 is reserved for a future neutral/gaia faction. */
export function isPlayerOwner(o: Owner): boolean {
  return o < MAX_PLAYERS;
}

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
  /**
   * Per-good tick until which this building's demand is suspended — set when
   * hauls to it keep failing to path (e.g. its doorway got walled in), so
   * reservations stop pinning supply that other demands could use.
   */
  demandBackoff?: GoodAmounts;
  /** Resident worker (staffed production buildings). */
  workerId?: EntityId;
  /** Serf currently walking here to staff the building / enlist. */
  recruitId?: EntityId;
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
