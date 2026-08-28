import type { AiWorldSummary } from '../ai/summary.ts';
import type { EntityId, Owner, BuildingState } from '../sim/entities.ts';
import type { AiStrategy } from '../sim/defs/aiStrategies.ts';
import type { UnitTypeId } from '../sim/defs/units.ts';
import type { MatchOutcome, HaulPhase, GameEvent, MapDelta, WorldConfig } from '../sim/world.ts';
import type { PlayerKind } from '../sim/player.ts';
import type { BuildingTypeId } from '../sim/defs/buildings.ts';
import type { GoodAmounts, GoodId } from '../sim/defs/goods.ts';
import type { MissionId } from '../sim/defs/missions.ts';
import type { TechId } from '../sim/defs/techs.ts';
import type { PlayerCommand } from '../sim/tick.ts';
import type { Enum } from '../shared/enum.ts';
import * as MainToWorkerKindNs from './mainToWorkerKindEnum.ts';
import * as WorkerToMainKindNs from './workerToMainKindEnum.ts';
import * as NetStateNs from './netStateEnum.ts';
import * as StaffingStateNs from './staffingStateEnum.ts';

export type MainToWorkerKind = Enum<typeof MainToWorkerKindNs>;
export type WorkerToMainKind = Enum<typeof WorkerToMainKindNs>;
export type NetState = Enum<typeof NetStateNs>;
export type StaffingState = Enum<typeof StaffingStateNs>;

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
  kind: PlayerKind;
  alive: boolean;
  /** This player's storehouse stock ({} once eliminated). */
  stock: GoodAmounts;
  /** Open tool-gated posts per tool, plus sites still owed their hammer —
   * what the HUD's "wants" chip and the ledger's task column report. */
  toolWants: GoodAmounts;
  techs: TechSnap;
  /** Living people this seat owns — serfs, workers and soldiers alike. */
  pop: number;
  /** Beds standing: the castle's ten plus ten per finished house. */
  popCap: number;
}

/** The match outcome as the client mirror sees it — the sim's own type,
 * which serializes as-is now that the state is a number. */
export type OutcomeSnap = MatchOutcome;

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
  state: BuildingState;
  /** Remaining materials, present for sites. */
  siteNeeds?: GoodAmounts;
  /** Remaining materials of an ordered repair; absent when none is running. */
  repairNeeds?: GoodAmounts;
  /** Hit points delivered materials have bought that the masons have still
   * to put on. Outlasts repairNeeds: the mend runs on after the last haul. */
  repairPending?: number;
  /** Build timer progress 0..1 once materials are complete. */
  progress01?: number;
  stock: GoodAmounts;
  inputs: GoodAmounts;
  inbound: GoodAmounts;
  reservedOut: GoodAmounts;
  maxHp: number;
  /** Barracks orders in queue order; the started one carries its progress 0..1. */
  trainQueue?: { unit: UnitTypeId; started: boolean; progress01?: number }[];
  /** The rally flag fresh soldiers march to (barracks); absent when none stands. */
  rally?: { x: number; y: number };
  /** Serf hires paid for and still walking in, and the leader's progress 0..1. */
  hireQueue?: number;
  hireProgress01?: number;
  /** Quarter turns from "front faces +z" — shore buildings only. */
  facing?: 0 | 1 | 2 | 3;
  /** Staffing state (undefined = building needs no worker). */
  staffing?: StaffingState;
  /** Present (as `true`) only while a convert batch is mid-grind and not
   * paused; omitted otherwise — `false` is never sent. The cue for decor
   * that moves with production rather than with staff (the mill's sails,
   * which have no resident to key off). */
  working?: true;
  paused?: boolean;
  /** Standing order into the def's recipeOptions; undefined = auto. */
  recipeIndex?: number;
  /** The option the batch on the fire was started with. */
  prodRecipeIndex?: number;
  /** Forge orders waiting (Smith), worked ahead of the standing order. */
  forgeQueue?: { recipeIndex: number; started: boolean }[];
  /** Men manning this building, and how many it holds. Present only for
   * buildings that are manned at all (the guard tower). */
  garrison?: number;
  garrisonCap?: number;
  /** True when the men on the roof are the levy rather than soldiers. */
  levied?: true;
  /** Present (as `true`) only while a manned building is between volleys —
   * the cue for the archers on the roof to be drawing rather than idling.
   * Same convention as `working` above: `false` is never sent. */
  firing?: true;
  /**
   * Loads still standing on the ground this gatherer can reach — the sum
   * of what every workable tile inside its search square holds. Present
   * only for buildings that work the land (woodcutter, quarry, the three
   * mines); the amounts themselves are sim-only and reach the client
   * nowhere else.
   */
  resourceLeft?: number;
}

/** Debug-overlay row for a haul job. */
export interface JobSnap {
  id: number;
  good: GoodId;
  from: EntityId;
  to: EntityId;
  priority: number;
  phase: HaulPhase;
  serfId?: EntityId;
  age: number;
}

/** Copies of the map's typed arrays for the main-thread mirror (worldgen). */
export interface MapSnapshot {
  /** Full grid side length in tiles — how the render side learns it. */
  size: number;
  /** Playable side length (a centered square; the ring outside is scenery). */
  play: number;
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
  | { state: NetStateNs.ok; rttMs: number }
  | { state: NetStateNs.disconnected }
  /** The room no longer knows us (swept, or the relay restarted): the
   * match is unreachable for good — stop reconnecting, say so. */
  | { state: NetStateNs.gone; message: string };

export type MainToWorker =
  | {
      type: MainToWorkerKindNs.init;
      config: WorldConfig;
      loadData?: string;
      net?: NetInfo;
      /** Solo only: post aiSummary messages so the main thread's LLM
       * strategist (src/ai/) can advise the AI seats. */
      llm?: boolean;
      /** Play back a recorded match instead of a live one: the sim feeds
       * itself from the log and ignores incoming commands. config/loadData
       * above are ignored — the replay carries its own. */
      replay?: import('../app/replay.ts').ReplayData;
    }
  | { type: MainToWorkerKindNs.commands; commands: PlayerCommand[] }
  /** Strategist advice for one AI seat: playbook knobs to lay over its
   * strategy. Validated and clamped on the main thread (src/ai/advice.ts)
   * before it is ever posted. */
  | { type: MainToWorkerKindNs.aiAdvice; playerId: number; override: Partial<AiStrategy> }
  | { type: MainToWorkerKindNs.setSpeed; speed: number }
  /** Debug overlay visibility: the worker only serializes its jobs table
   * into structural updates while someone is actually watching. */
  | { type: MainToWorkerKindNs.setDebug; enabled: boolean }
  /** Page visibility: hidden freezes the single-player sim (and its pump
   * timer) so a backgrounded phone stops burning battery on a valley
   * nobody is watching. Multiplayer ignores it — the server's world keeps
   * running either way, and the socket has to stay warm. */
  | { type: MainToWorkerKindNs.setHidden; hidden: boolean }
  | { type: MainToWorkerKindNs.requestSave }
  /** Solo only: serialize the recording so the main thread can write it to
   * OPFS. Answered with 'replayData'. `explored` is the packed fog memory
   * the match booted with (a loaded save's), which the worker cannot know
   * — fog is render-side — and carries into the file unread, so playback
   * from that save resumes with the ground the player had scouted. */
  | { type: MainToWorkerKindNs.requestReplay; explored?: string };

/**
 * Low-frequency structural state (every 5 ticks / on change): building
 * mirror, map deltas, per-player faction blocks, debug info. The hot
 * per-tick unit state rides the SharedArrayBuffer instead.
 */
export interface StructuralUpdate {
  type: WorkerToMainKindNs.structural;
  tick: number;
  /** Absent = unchanged since the last frame (the mirror keeps what it has). */
  buildings?: BuildingSnap[];
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
  /** One block per seat; the main thread reads its own via myPlayerId.
   * Like `buildings`, absent = unchanged since the last frame: the server
   * ships each roster only when it differs, so a frame carrying two tiles
   * of trail wear is a few dozen bytes, not the whole village. */
  players?: PlayerSnap[];
  admin: { enabled: boolean; raidsEnabled: boolean; instantBuild: boolean };
  events: GameEvent[];
  outcome: OutcomeSnap;
  /** Campaign mission riding this world, latch bits included. From the
   * worker rather than the URL on purpose: a loaded save reboots on
   * ?seed=…, but the world remembers which mission it is. */
  mission?: { id: MissionId; done: boolean[] };
  /** Debug-overlay rows; absent while nobody is watching. */
  jobs?: JobSnap[];
  invariantViolations: string[];
}

export type WorkerToMain =
  | {
      type: WorkerToMainKindNs.ready;
      sab: SharedArrayBuffer;
      map: MapSnapshot;
      buildings: BuildingSnap[];
      /** Multiplayer only: the seat's ever-seen grid from the server, so
       * the fog boots with its memory instead of blank. Solo omits it —
       * a fresh world has nothing explored yet. */
      explored?: Uint8Array;
    }
  | StructuralUpdate
  | { type: WorkerToMainKindNs.saved; data: string }
  /** The recording, serialized — the answer to 'requestReplay'. */
  | { type: WorkerToMainKindNs.replayData; data: string }
  /** Replay playback reached the log's end tick; the sim has paused itself. */
  | { type: WorkerToMainKindNs.replayEnded }
  | { type: WorkerToMainKindNs.netStatus; status: NetStatus }
  /** One AI seat's folded-down view of the match, on the advice cadence
   * (~45 s) — the input the LLM strategist prompts from. Only sent when
   * init asked with `llm`. */
  | { type: WorkerToMainKindNs.aiSummary; playerId: number; summary: AiWorldSummary }
  | { type: WorkerToMainKindNs.log; message: string };
