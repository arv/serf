import { SabReader } from '../protocol/sabLayout';
import type {
  BuildingSnap,
  MainToWorker,
  MapSnapshot,
  StructuralUpdate,
  WorkerToMain,
} from '../protocol/messages';
import type { SimCommand } from '../sim/commands';
import type { GameConfig } from './gameConfig';

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
  start(config: GameConfig, loadData?: string): Promise<SimInit>;
  sendCommands(commands: SimCommand[]): void;
  setSpeed(speed: number): void;
  requestSave(): Promise<string>;
  onStructural(cb: (msg: StructuralUpdate) => void): void;
}

export class WorkerSimHost implements SimHost {
  #worker = new Worker(new URL('./simWorker.ts', import.meta.url), { type: 'module' });
  #structuralCb: ((msg: StructuralUpdate) => void) | null = null;
  #saveCb: ((data: string) => void) | null = null;
  /** Seat the UI's commands are issued as (always 0 until lobbies land). */
  playerId = 0;

  start(config: GameConfig, loadData?: string): Promise<SimInit> {
    this.playerId = config.myPlayerId;
    return new Promise((resolve, reject) => {
      this.#worker.onerror = (e) => reject(new Error(`sim worker failed: ${e.message}`));
      this.#worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
        const msg = e.data;
        if (msg.type === 'ready') {
          resolve({ reader: new SabReader(msg.sab), map: msg.map, buildings: msg.buildings });
        } else if (msg.type === 'structural') {
          this.#structuralCb?.(msg);
        } else if (msg.type === 'saved') {
          this.#saveCb?.(msg.data);
          this.#saveCb = null;
        }
      };
      this.#post({ type: 'init', config, loadData });
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
