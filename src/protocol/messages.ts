import type { EntityId, Owner } from '../sim/entities.ts';
import type { BuildingTypeId } from '../sim/defs/buildings.ts';
import type { GoodAmounts } from '../sim/defs/goods.ts';
import type { TechId } from '../sim/defs/techs.ts';
import type { PlayerCommand } from '../sim/tick.ts';
import type { GameEvent, MapDelta, WorldConfig } from '../sim/world.ts';

/** Tech-tree state for the UI. */
export interface TechSnap {
  researched: TechId[];
  active?: { tech: TechId; ticksLeft: number; totalTicks: number };
  festivalTicksLeft: number;
  pavingUnlocked: boolean;
  hasAbbey: boolean;
}

/** Per-player faction block; the main thread picks its own by myPlayerId. */
export interface PlayerSnap {
  id: Owner;
  kind: 'human' | 'ai';
  alive: boolean;
  /** This player's storehouse stock ({} once eliminated). */
  stock: GoodAmounts;
  techs: TechSnap;
  /** Living people this seat owns — serfs, workers and soldiers alike. */
  pop: number;
  /** Beds standing: the castle's ten plus ten per finished house. */
  popCap: number;
}

export type OutcomeSnap = { state: 'playing' } | { state: 'over'; winner: Owner | null };

/** Serializable snapshot of a building for the main thread's mirror. */
export interface BuildingSnap {
  id: EntityId;
  type: BuildingTypeId;
  owner: Owner;
  x: number;
  y: number;
  w: number;
  h: number;
  hp: number;
  state: 'site' | 'built';
  /** Remaining materials, present for sites. */
  siteNeeds?: GoodAmounts;
  /** Build timer progress 0..1 once materials are complete. */
  progress01?: number;
  stock: GoodAmounts;
  inputs: GoodAmounts;
  inbound: GoodAmounts;
  reservedOut: GoodAmounts;
  maxHp: number;
  /** Barracks orders in queue order; the started one carries its progress 0..1. */
  trainQueue?: { unit: string; started: boolean; progress01?: number }[];
  /** Serf hires paid for and still walking in, and the leader's progress 0..1. */
  hireQueue?: number;
  hireProgress01?: number;
  /** Quarter turns from "front faces +z" — shore buildings only. */
  facing?: 0 | 1 | 2 | 3;
  /** Staffing state (undefined = building needs no worker). */
  staffing?: 'staffed' | 'recruiting' | 'needed';
  paused?: boolean;
  /** Active recipeOptions index (weaponsmith forge menu). */
  recipeIndex?: number;
}

/** Debug-overlay row for a haul job. */
export interface JobSnap {
  id: number;
  good: string;
  from: EntityId;
  to: EntityId;
  priority: number;
  phase: string;
  serfId?: EntityId;
  age: number;
}

/** Copies of the map's typed arrays for the main-thread mirror (worldgen). */
export interface MapSnapshot {
  terrain: Uint8Array;
  resource: Uint8Array;
  blocked: Uint8Array;
  buildingAt: Int16Array;
  pathLevel: Uint8Array;
  height: Float32Array;
}

/** How the worker reaches the relay in a networked match. */
export interface NetInfo {
  relayUrl: string;
  token: string;
  playerId: number;
}

/**
 * Connection state. Under lockstep there were also 'stalled' (prediction ran
 * too far ahead of the relay) and 'desync' (clients disagreed); neither can
 * happen now that one machine simulates and the rest render what it sends.
 */
export type NetStatus =
  | { state: 'ok'; rttMs: number }
  | { state: 'disconnected' }
  /** The room no longer knows us (swept, or the relay restarted): the
   * match is unreachable for good — stop reconnecting, say so. */
  | { state: 'gone'; message: string };

export type MainToWorker =
  | {
      type: 'init';
      config: WorldConfig;
      loadData?: string;
      net?: NetInfo;
    }
  | { type: 'commands'; commands: PlayerCommand[] }
  | { type: 'setSpeed'; speed: number }
  /** Debug overlay visibility: the worker only serializes its jobs table
   * into structural updates while someone is actually watching. */
  | { type: 'setDebug'; enabled: boolean }
  | { type: 'requestSave' };

/**
 * Low-frequency structural state (every 5 ticks / on change): building
 * mirror, map deltas, per-player faction blocks, debug info. The hot
 * per-tick unit state rides the SharedArrayBuffer instead.
 */
export interface StructuralUpdate {
  type: 'structural';
  tick: number;
  buildings: BuildingSnap[];
  mapDeltas: MapDelta[];
  /** Wholesale replacement for the mirror's mutable map arrays, sent when
   * a reconnecting client cannot be caught up with deltas it missed. */
  fullMap?: {
    resource: Uint8Array;
    blocked: Uint8Array;
    pathLevel: Uint8Array;
    buildingAt: Int16Array;
  };
  /** The seat's ever-seen grid, riding reconnect resyncs so the fog's
   * memory (and the build gate behind it) survives a dropped socket. */
  explored?: Uint8Array;
  /** One block per seat; the main thread reads its own via myPlayerId. */
  players: PlayerSnap[];
  admin: { enabled: boolean; raidsEnabled: boolean; instantBuild: boolean };
  events: GameEvent[];
  outcome: OutcomeSnap;
  jobs: JobSnap[];
  invariantViolations: string[];
}

export type WorkerToMain =
  | {
      type: 'ready';
      sab: SharedArrayBuffer;
      map: MapSnapshot;
      buildings: BuildingSnap[];
      /** Multiplayer only: the seat's ever-seen grid from the server, so
       * the fog boots with its memory instead of blank. Solo omits it —
       * a fresh world has nothing explored yet. */
      explored?: Uint8Array;
    }
  | StructuralUpdate
  | { type: 'saved'; data: string }
  | { type: 'netStatus'; status: NetStatus }
  | { type: 'log'; message: string };
