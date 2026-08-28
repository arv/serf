import type { GoodAmounts } from './defs/goods.ts';
import type { BuildingTypeId } from './defs/buildings.ts';
import type { UnitTypeId } from './defs/units.ts';
import type { Enum } from '../shared/enum.ts';
import * as BuildingStateNs from './buildingStateEnum.ts';

export * as BuildingState from './buildingStateEnum.ts';
export type BuildingState = Enum<typeof BuildingStateNs>;

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
  state: BuildingState;
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
  /** Standing order in the def's recipeOptions (the Smith's forge menu).
   * Undefined = auto: forge whatever tool the village most lacks. */
  recipeIndex?: number;
  /** The option the running batch was started with: a switch mid-batch
   * must not change what comes out of the kiln. */
  prodRecipeIndex?: number;
  /** Military training queue (barracks). */
  trainQueue?: { unit: UnitTypeId; ticksLeft: number; started: boolean }[];
  /** Rally point (buildings that train): the tile a fresh soldier marches
   * to as he steps out of the door. Absent = he stands at the door as
   * ever. Only ever set on a building whose def trains, and deliberately a
   * tile rather than an entity id: a flag planted on ground that later
   * gets built over still means "muster near there". */
  rally?: { x: number; y: number };
  /** Forge orders (Smith): recipeOptions indices worked in order, ahead of
   * the standing recipeIndex. Mirrors trainQueue — an item is marked
   * started when its batch takes the fire and removed when it lands, so a
   * pause or a standing-order switch never loses an order. */
  forgeQueue?: { recipeIndex: number; started: boolean }[];
  /**
   * Men manning this building (guard tower). A count, not ids: an archer who
   * walks in is consumed the way a barracks recruit is, so there is no unit
   * left on the map — which is exactly why a garrison cannot be shot at
   * except by bringing the tower down. They still count as this seat's
   * people (see populationOf), and they walk back out if the tower is sold
   * — or, for the levy, when it is paused (that is the stand-down order).
   */
  garrison?: number;
  /**
   * Which kind is up there. A tower holds soldiers or the levy, never a mix
   * — `garrison` is a count and a count cannot say who is shooting, and the
   * two shoot nothing alike. Undefined exactly when the tower is empty.
   */
  garrisonKind?: UnitTypeId;
  /**
   * What each man walked in with, in the order they climbed up, so that the
   * one who walks back out is the man who went in rather than a fresh one.
   * Without it the roof was a field hospital: a wounded archer climbed up,
   * the tower was stood down, and he came back at full strength for the
   * price of a lever — free and instant, now that the lever gives soldiers
   * back at all.
   *
   * Kept in step with `garrison` (pushed as a man is consumed, popped as he
   * is evicted) and undefined exactly when the tower is empty. A save from
   * a build before this has none, and its men come out at full health as
   * they always did.
   */
  garrisonHp?: number[];
  /** Ticks before this building's garrison can loose again. */
  attackCooldown?: number;
  /** Paid-for serf hires still on their way in (storehouse), and the ticks
   * left on the one at the front. Silver is taken when the order is
   * placed, so a cancelled game or a razed storehouse cannot refund it. */
  hireQueue?: number;
  hireTicksLeft?: number;
  /** Player-ordered production halt: no recipe ticks, no input demands,
   * no construction progress. The post is emptied too — the resident
   * rejoins the serf pool, and unpausing recruits a new one. Outputs
   * still evacuate to the storehouse. */
  paused?: boolean;
  /**
   * Ordered repairs (built buildings only): materials still to be hauled in,
   * exactly like a site's siteNeeds. No second builder — the serf who
   * carries the stone hands it to the post that is already there.
   */
  repairNeeds?: GoodAmounts;
  /** Hit points each delivered repair material buys, fixed when the order
   * was placed: the damage then, split over the bill then. Damage taken
   * *during* a repair is therefore not mended for free — the order patches
   * what was broken when it was given, and the rest wants a new one. */
  repairHpPerGood?: number;
  /** Hit points bought and not yet on the walls. A delivered material is
   * work booked, not work done: it banks its hp here and the masons put
   * them on at REPAIR_MEND_TICKS' pace (constructionSystem). Outlives
   * repairNeeds — the last plank lands well before the mend is finished. */
  repairPending?: number;
  /** Recruiting hold: staffing found the post walled off and waits before
   * re-pathing to it (see UNREACHABLE_BACKOFF). */
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
