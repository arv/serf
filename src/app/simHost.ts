import { SabReader } from '../protocol/sabLayout';
import type {
  BuildingSnap,
  MainToWorker,
  MapSnapshot,
  NetStatus,
  StructuralUpdate,
  WorkerToMain,
} from '../protocol/messages';
import type { SimCommand } from '../sim/commands';
import type { GameConfig } from './gameConfig';
import type { NetInfo } from '../protocol/messages';

export interface SimInit {
  reader: SabReader;
  map: MapSnapshot;
  buildings: BuildingSnap[];
}

/**
 * The main thread's handle on the simulation. WorkerSimHost is the real
 * thing; a LocalSimHost (sim inline, for step-debugging) can implement the
 * same interface later because the sim is pure.
 */
export interface SimHost {
  start(config: GameConfig, loadData?: string, net?: NetInfo): Promise<SimInit>;
  sendCommands(commands: SimCommand[]): void;
  setSpeed(speed: number): void;
  requestSave(): Promise<string>;
  onStructural(cb: (msg: StructuralUpdate) => void): void;
  onNetStatus?(cb: (status: NetStatus) => void): void;
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
  #saveCb: ((data: string) => void) | null = null;
  #netStatusCb: ((status: NetStatus) => void) | null = null;
  /** Seat the UI's commands are issued as. */
  playerId = 0;

  constructor(kind: 'sim' | 'net' = 'sim') {
    this.#worker =
      kind === 'net'
        ? new Worker(new URL('./netWorker.ts', import.meta.url), { type: 'module' })
        : new Worker(new URL('./simWorker.ts', import.meta.url), { type: 'module' });
  }

  start(config: GameConfig, loadData?: string, net?: NetInfo): Promise<SimInit> {
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
          resolve({ reader: new SabReader(msg.sab), map: msg.map, buildings: msg.buildings });
        } else if (msg.type === 'structural') {
          this.#structuralCb?.(msg);
        } else if (msg.type === 'saved') {
          this.#saveCb?.(msg.data);
          this.#saveCb = null;
        } else if (msg.type === 'netStatus') {
          this.#netStatusCb?.(msg.status);
        } else if (msg.type === 'log') {
          console.log(msg.message);
        }
      };
      this.#worker.postMessage({ type: 'init', config, loadData, net } satisfies MainToWorker);
    });
  }

  requestSave(): Promise<string> {
    return new Promise((resolve) => {
      this.#saveCb = resolve;
      this.#post({ type: 'requestSave' });
    });
  }

  onStructural(cb: (msg: StructuralUpdate) => void): void {
    this.#structuralCb = cb;
  }

  onNetStatus(cb: (status: NetStatus) => void): void {
    this.#netStatusCb = cb;
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

  #post(msg: MainToWorker): void {
    this.#worker.postMessage(msg);
  }
}
