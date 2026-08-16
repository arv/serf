import type { GoodAmounts } from './defs/goods.ts';
import type { BuildingTypeId } from './defs/buildings.ts';
import type { UnitTypeId } from './defs/units.ts';

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
  /**
   * Quarter turns clockwise from "front faces +z", set once at placement.
   * Only shore buildings use it: the fishery turns its pier toward the
   * water it was placed against, so the pier ends in the water rather than
   * in a field. Everything else is built facing +z and stays there.
   */
  facing?: 0 | 1 | 2 | 3;
  /** Resident worker (staffed production buildings). */
  workerId?: EntityId;
  /** Serf currently walking here to staff the building / enlist. */
  recruitId?: EntityId;
  /** Convert recipe: ticks left on the current batch (undefined = not running). */
  prodTicksLeft?: number;
  /** Selected option in the def's recipeOptions (weaponsmith forge menu). */
  recipeIndex?: number;
  /** The option the running batch was started with: a switch mid-batch
   * must not change what comes out of the kiln. */
  prodRecipeIndex?: number;
  /** Military training queue (barracks). */
  trainQueue?: { unit: UnitTypeId; ticksLeft: number; started: boolean }[];
  /** Paid-for serf hires still on their way in (storehouse), and the ticks
   * left on the one at the front. Silver is taken when the order is
   * placed, so a cancelled game or a razed storehouse cannot refund it. */
  hireQueue?: number;
  hireTicksLeft?: number;
  /** Player-ordered production halt: no recipe ticks, no input demands,
   * no construction progress. The worker keeps the post; outputs still
   * evacuate to the storehouse. */
  paused?: boolean;
  /**
   * Ordered repairs (built buildings only): materials still to be hauled in,
   * exactly like a site's siteNeeds. Each one that arrives is nailed on by
   * the serf who carried it — no timer, no second builder — so a repair runs
   * as fast as the haulage pool can carry stone.
   */
  repairNeeds?: GoodAmounts;
  /** Hit points each delivered repair material buys, fixed when the order
   * was placed: the damage then, split over the bill then. Damage taken
   * *during* a repair is therefore not mended for free — the order patches
   * what was broken when it was given, and the rest wants a new one. */
  repairHpPerGood?: number;
  /** Recruiting pause after the player dismissed the worker on purpose. */
  staffBackoffUntil?: number;
  /** Since when this site has been ready for a builder and without one.
   * Staffing uses it to escalate a long wait (see BUILDER_STARVED_TICKS). */
  builderWantedSince?: number;
  /** When to respawn a lost resident worker. */
  workerRespawnAt?: number;
  dead: boolean;
}

export function centerOf(b: Building): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}
