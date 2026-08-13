import { SabReader } from '../protocol/sabLayout';
import type {
  BuildingSnap,
  MainToWorker,
  MapSnapshot,
  NetStatus,
  StructuralUpdate,
  WorkerToMain,
} from '../protocol/messages';
import type { AiWorldSummary } from '../ai/summary';
import type { SimCommand } from '../sim/commands';
import type { AiStrategy } from '../sim/defs/aiStrategies';
import type { GameConfig } from './gameConfig';
import type { NetInfo } from '../protocol/messages';
import type { ReplayData } from './replay';

export interface SimInit {
  reader: SabReader;
  map: MapSnapshot;
  buildings: BuildingSnap[];
  /** Multiplayer: the seat's ever-seen grid, seeding the fog's memory. */
  explored?: Uint8Array;
}

/**
 * The main thread's handle on the simulation. WorkerSimHost is the real
 * thing; a LocalSimHost (sim inline, for step-debugging) can implement the
 * same interface later because the sim is pure.
 */
export interface SimHost {
  start(config: GameConfig, loadData?: string, net?: NetInfo, replay?: ReplayData): Promise<SimInit>;
  sendCommands(commands: SimCommand[]): void;
  setSpeed(speed: number): void;
  /** Tell the worker whether the debug overlay is watching (jobs feed). */
  setDebug(enabled: boolean): void;
  /** Tell the worker whether the page is hidden (freezes the solo sim). */
  setHidden(hidden: boolean): void;
  requestSave(): Promise<string>;
  /** The match's replay log, serialized (solo sim only). `explored` is
   * the packed fog memory the match booted with, for a replay that will
   * resume from a save. */
  requestReplay?(explored?: string): Promise<string>;
  onStructural(cb: (msg: StructuralUpdate) => void): void;
  /** Playback reached the recording's end and the sim paused itself. */
  onReplayEnded?(cb: () => void): void;
  onNetStatus?(cb: (status: NetStatus) => void): void;
  /** LLM strategist plumbing (solo, when the config asked for it): seat
   * summaries coming up, validated advice going down. */
  onAiSummary?(cb: (playerId: number, summary: AiWorldSummary) => void): void;
  sendAiAdvice?(playerId: number, override: Partial<AiStrategy>): void;
}

export class WorkerSimHost implements SimHost {
  /**
   * Two workers speak this exact protocol, so the main thread and the whole
   * renderer never learn which one they are talking to:
   * - 'sim' owns a World and runs it (single player)
   * - 'net' owns a socket and renders what the server sends (multiplayer,
   *   where holding a World client-side would be holding the enemy's too)
   */
  #worker: Worker;
  #structuralCb: ((msg: StructuralUpdate) => void) | null = null;
  /** Structural frames that arrived before anyone listened, oldest first.
   * The worker posts its first one right after 'ready', and it dispatches
   * while runMatch is still awaiting the asset loads — before onStructural
   * has registered. Losing them is invisible at speed 1 (the next frame is
   * 250 ms away) but a mission match starts paused, and the first frame is
   * then the only one carrying stock and the mission block. A queue rather
   * than a latest-wins slot: sections (players, buildings) ship only when
   * changed and events are one-shot, so a later partial frame must not
   * replace the full first one — every missed frame replays, in order. */
  #pendingStructural: StructuralUpdate[] = [];
  #saveCb: ((data: string) => void) | null = null;
  /** Waiting requestReplay callers, oldest first. A queue rather than one
   * slot: both Save replay buttons stay clickable while a request is in
   * flight, and a second click used to overwrite the first's resolver —
   * leaving that promise pending forever, so the save it belonged to
   * never reported anything at all. Answers arrive in request order. */
  #replayCbs: ((data: string) => void)[] = [];
  #replayEndedCb: (() => void) | null = null;
  /** Playback ended before anyone registered for it. The worker posts
   * this the moment it reaches the log's end, which for a replay booted
   * at its own end tick is before runMatch finishes loading assets and
   * registers — and an unlatched signal left the HUD with no end card. */
  #replayEndedPending = false;
  #netStatusCb: ((status: NetStatus) => void) | null = null;
  #aiSummaryCb: ((playerId: number, summary: AiWorldSummary) => void) | null = null;
  /** Seat the UI's commands are issued as. */
  playerId = 0;

  constructor(kind: 'sim' | 'net' = 'sim') {
    this.#worker =
      kind === 'net'
        ? new Worker(new URL('./netWorker.ts', import.meta.url), { type: 'module' })
        : new Worker(new URL('./simWorker.ts', import.meta.url), { type: 'module' });
  }

  start(config: GameConfig, loadData?: string, net?: NetInfo, replay?: ReplayData): Promise<SimInit> {
    this.playerId = config.myPlayerId;
    return new Promise((resolve, reject) => {
      // A worker that dies after start would otherwise fail silently: the
      // promise is already resolved, so surface the error loudly too.
      this.#worker.onerror = (e) => {
        console.error(`[sim worker] ${e.message} (${e.filename}:${e.lineno})`);
        reject(new Error(`sim worker failed: ${e.message}`));
      };
      this.#worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
        const msg = e.data;
        if (msg.type === 'ready') {
          resolve({
            reader: new SabReader(msg.sab),
            map: msg.map,
            buildings: msg.buildings,
            explored: msg.explored,
          });
        } else if (msg.type === 'structural') {
          if (this.#structuralCb) this.#structuralCb(msg);
          else this.#pendingStructural.push(msg);
        } else if (msg.type === 'saved') {
          this.#saveCb?.(msg.data);
          this.#saveCb = null;
        } else if (msg.type === 'replayData') {
          this.#replayCbs.shift()?.(msg.data);
        } else if (msg.type === 'replayEnded') {
          if (this.#replayEndedCb) this.#replayEndedCb();
          else this.#replayEndedPending = true;
        } else if (msg.type === 'netStatus') {
          this.#netStatusCb?.(msg.status);
        } else if (msg.type === 'aiSummary') {
          this.#aiSummaryCb?.(msg.playerId, msg.summary);
        } else if (msg.type === 'log') {
          console.log(msg.message);
        }
      };
      this.#worker.postMessage({
        type: 'init',
        config,
        loadData,
        net,
        llm: config.llmOpponent,
        replay,
      } satisfies MainToWorker);
    });
  }

  requestSave(): Promise<string> {
    return new Promise((resolve) => {
      this.#saveCb = resolve;
      this.#post({ type: 'requestSave' });
    });
  }

  requestReplay(explored?: string): Promise<string> {
    return new Promise((resolve) => {
      this.#replayCbs.push(resolve);
      this.#post({ type: 'requestReplay', explored });
    });
  }

  onReplayEnded(cb: () => void): void {
    this.#replayEndedCb = cb;
    if (this.#replayEndedPending) {
      this.#replayEndedPending = false;
      cb();
    }
  }

  onStructural(cb: (msg: StructuralUpdate) => void): void {
    this.#structuralCb = cb;
    const pending = this.#pendingStructural;
    this.#pendingStructural = [];
    for (const msg of pending) cb(msg);
  }

  onNetStatus(cb: (status: NetStatus) => void): void {
    this.#netStatusCb = cb;
  }

  onAiSummary(cb: (playerId: number, summary: AiWorldSummary) => void): void {
    this.#aiSummaryCb = cb;
  }

  sendAiAdvice(playerId: number, override: Partial<AiStrategy>): void {
    this.#post({ type: 'aiAdvice', playerId, override });
  }

  sendCommands(commands: SimCommand[]): void {
    if (commands.length > 0) {
      this.#post({
        type: 'commands',
        commands: commands.map((cmd) => ({ playerId: this.playerId, cmd })),
      });
    }
  }

  setSpeed(speed: number): void {
    this.#post({ type: 'setSpeed', speed });
  }

  setDebug(enabled: boolean): void {
    this.#post({ type: 'setDebug', enabled });
  }

  setHidden(hidden: boolean): void {
    this.#post({ type: 'setHidden', hidden });
  }

  #post(msg: MainToWorker): void {
    this.#worker.postMessage(msg);
  }
}
