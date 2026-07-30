import type { EntityId, Owner } from '../sim/entities';
import type { BuildingTypeId } from '../sim/defs/buildings';
import type { GoodAmounts } from '../sim/defs/goods';
import type { TechId } from '../sim/defs/techs';
import type { PlayerCommand } from '../sim/tick';
import type { GameEvent, MapDelta, WorldConfig } from '../sim/world';

/** Tech-tree state for the UI. */
export interface TechSnap {
  researched: TechId[];
  active?: { tech: TechId; ticksLeft: number; totalTicks: number };
  festivalTicksLeft: number;
  pavingUnlocked: boolean;
  hasTerakoya: boolean;
}

/** Per-player faction block; the main thread picks its own by myPlayerId. */
export interface PlayerSnap {
  id: Owner;
  kind: 'human' | 'ai';
  alive: boolean;
  /** This player's storehouse stock ({} once eliminated). */
  stock: GoodAmounts;
  techs: TechSnap;
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
  trainQueue?: { unit: string; started: boolean }[];
  /** Staffing state (undefined = building needs no worker). */
  staffing?: 'staffed' | 'recruiting' | 'needed';
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

export type NetStatus =
  | { state: 'ok'; rttMs: number; behindTicks: number }
  | { state: 'stalled'; behindTicks: number }
  | { state: 'desync'; tick: number }
  | { state: 'disconnected' };

export type MainToWorker =
  | {
      type: 'init';
      config: WorldConfig;
      loadData?: string;
      net?: NetInfo;
      /** Single-player AI seats: one MessagePort per brain worker — the sim
       * streams executed ticks out and receives that seat's commands back. */
      aiPorts?: { playerId: number; port: MessagePort }[];
    }
  | { type: 'commands'; commands: PlayerCommand[] }
  | { type: 'setSpeed'; speed: number }
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
  /** After a rollback: wholesale replacement for the mirror's mutable map
   * arrays (incremental deltas shipped for re-simulated ticks are void). */
  fullMap?: {
    resource: Uint8Array;
    blocked: Uint8Array;
    pathLevel: Uint8Array;
    buildingAt: Int16Array;
  };
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
    }
  | StructuralUpdate
  | { type: 'saved'; data: string }
  | { type: 'netStatus'; status: NetStatus }
  | { type: 'log'; message: string };
