import * as MainToWorkerKind from '../protocol/mainToWorkerKindEnum.ts';
import type {
  BuildingSnap,
  MainToWorker,
  MapSnapshot,
  NetStatus,
  StructuralUpdate,
  WorkerToMain,
} from '../protocol/messages';
import type {NetInfo} from '../protocol/messages';
import {SabReader} from '../protocol/sabLayout';
import * as WorkerToMainKind from '../protocol/workerToMainKindEnum.ts';
import type {SimCommand} from '../sim/commands';
import type {GameConfig} from './gameConfig';
import type {ReplayData} from './replay';

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
  start(
    config: GameConfig,
    loadData?: string,
    net?: NetInfo,
    replay?: ReplayData,
  ): Promise<SimInit>;
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
  /** A line of chat from the table (multiplayer only). */
  onChat?(cb: (playerId: number, text: string) => void): void;
  /** Say one line to every seat; a host with nobody to tell may omit it. */
  sendChat?(text: string): void;
  /**
   * The sim broke after the match came up, and the HUD is no longer being
   * told what the world looks like. Called at most once. Registering is
   * optional only in the type: a screen that skips it is a screen that can
   * freeze without saying so.
   */
  onFatal?(cb: (message: string) => void): void;
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
  #chatCb: ((playerId: number, text: string) => void) | null = null;
  /** Lines that arrived before anyone registered for them, held the way
   * structural frames are: a replay starts ticking the moment the worker
   * is up, while runMatch is still awaiting its assets, so a line said in
   * the opening seconds would otherwise land with no listener and vanish. */
  #chatPending: {playerId: number; text: string}[] = [];
  #fatalCb: ((message: string) => void) | null = null;
  /** Whether 'ready' has landed — which is what decides where a worker
   * failure is reported (see onerror). */
  #started = false;
  /** A fatal already told, so a worker failing on a timer says it once.
   * The worker suppresses its own repeats; onerror has no such memory, and
   * an error thrown from an interval fires as often as the interval. */
  #fatalTold = false;
  /** Seat the UI's commands are issued as. */
  playerId = 0;

  /** A failure that landed before anyone registered for it, latched the way
   * replayEnded is: the worker posts 'ready' and then draws its first
   * structural frame immediately, while runMatch is still awaiting its
   * asset loads — so the very failure most worth reporting, the one in the
   * opening frame, is the one that arrives with no listener. Dropped, it
   * left the HUD frozen from the first tick with nothing said. */
  #fatalPending: string | null = null;

  /** Report a mid-match failure to whoever registered for it, once. */
  #fatal(message: string): void {
    if (this.#fatalTold) return;
    this.#fatalTold = true;
    if (this.#fatalCb) this.#fatalCb(message);
    else this.#fatalPending = message;
  }

  constructor(kind: 'sim' | 'net' = 'sim') {
    this.#worker =
      kind === 'net'
        ? new Worker(new URL('./netWorker.ts', import.meta.url), {
            type: 'module',
          })
        : new Worker(new URL('./simWorker.ts', import.meta.url), {
            type: 'module',
          });
  }

  start(
    config: GameConfig,
    loadData?: string,
    net?: NetInfo,
    replay?: ReplayData,
  ): Promise<SimInit> {
    this.playerId = config.myPlayerId;
    return new Promise((resolve, reject) => {
      // Two different failures wear one event. Before 'ready' the start
      // promise is still pending, so rejecting it is the report, and the
      // caller draws the screen that says the match could not begin.
      //
      // After 'ready' that promise has settled, and rejecting a settled
      // promise does nothing at all — which is how a worker that broke
      // mid-match used to leave one console line and no other trace, while
      // the player sat looking at a HUD that had quietly stopped being
      // true. So past that point the failure goes to #fatalCb instead,
      // which is the half of the app that can actually say so on the glass.
      this.#worker.onerror = e => {
        const where = `[sim worker] ${e.message} (${e.filename}:${e.lineno})`;
        if (!this.#started) {
          console.error(where);
          reject(new Error(`sim worker failed: ${e.message}`));
          return;
        }
        // Once, however often the interval that threw comes round again.
        // The worker's pump is a timer, and an error thrown out of it
        // fires this every time it ticks — a thousand copies of one line,
        // with the first (the only one that names anything) scrolled off
        // the top. Asked before #fatal rather than inside it, because a
        // fatal the worker reported itself has already written its own
        // line over there and does not want a second here.
        if (this.#fatalTold) return;
        console.error(where);
        this.#fatal(e.message);
      };
      this.#worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
        const msg = e.data;
        if (msg.type === WorkerToMainKind.ready) {
          this.#started = true;
          resolve({
            reader: new SabReader(msg.sab),
            map: msg.map,
            buildings: msg.buildings,
            explored: msg.explored,
          });
        } else if (msg.type === WorkerToMainKind.fatal) {
          this.#fatal(msg.message);
        } else if (msg.type === WorkerToMainKind.structural) {
          if (this.#structuralCb) this.#structuralCb(msg);
          else this.#pendingStructural.push(msg);
        } else if (msg.type === WorkerToMainKind.saved) {
          this.#saveCb?.(msg.data);
          this.#saveCb = null;
        } else if (msg.type === WorkerToMainKind.replayData) {
          this.#replayCbs.shift()?.(msg.data);
        } else if (msg.type === WorkerToMainKind.replayEnded) {
          if (this.#replayEndedCb) this.#replayEndedCb();
          else this.#replayEndedPending = true;
        } else if (msg.type === WorkerToMainKind.netStatus) {
          this.#netStatusCb?.(msg.status);
        } else if (msg.type === WorkerToMainKind.chat) {
          if (this.#chatCb) this.#chatCb(msg.playerId, msg.text);
          else this.#chatPending.push({playerId: msg.playerId, text: msg.text});
        } else if (msg.type === WorkerToMainKind.log) {
          console.log(msg.message);
        }
      };
      this.#worker.postMessage({
        type: MainToWorkerKind.init,
        config,
        loadData,
        net,
        replay,
      } satisfies MainToWorker);
    });
  }

  /**
   * End the match this host was speaking for. Terminating rather than
   * asking politely: the sim worker's timers are deliberately unthrottled,
   * so one left running behind a menu would go on simulating a world
   * nobody can see, and the net worker's socket would hold a seat in a
   * room the player has left.
   *
   * Callbacks are dropped first. A worker can post one last frame between
   * the terminate call and the thread actually stopping, and delivering it
   * would write a dead match's stock into a live HUD.
   */
  dispose(): void {
    this.#structuralCb = null;
    this.#saveCb = null;
    this.#replayCbs = [];
    this.#replayEndedCb = null;
    this.#netStatusCb = null;
    this.#chatCb = null;
    this.#chatPending = [];
    this.#worker.onmessage = null;
    this.#worker.onerror = null;
    this.#worker.terminate();
  }

  requestSave(): Promise<string> {
    return new Promise(resolve => {
      this.#saveCb = resolve;
      this.#post({type: MainToWorkerKind.requestSave});
    });
  }

  requestReplay(explored?: string): Promise<string> {
    return new Promise(resolve => {
      this.#replayCbs.push(resolve);
      this.#post({type: MainToWorkerKind.requestReplay, explored});
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

  /** A line of chat arrived from the table, or off a replay's log. Lines
   * that came before this registration are delivered now, in order. */
  onChat(cb: (playerId: number, text: string) => void): void {
    this.#chatCb = cb;
    const pending = this.#chatPending;
    this.#chatPending = [];
    for (const line of pending) cb(line.playerId, line.text);
  }

  /** Say one line to every seat. The solo worker drops it; the net worker
   * relays it and the answer comes back through onChat like anyone's. */
  sendChat(text: string): void {
    this.#post({type: MainToWorkerKind.chat, text});
  }

  onFatal(cb: (message: string) => void): void {
    this.#fatalCb = cb;
    const pending = this.#fatalPending;
    this.#fatalPending = null;
    if (pending !== null) cb(pending);
  }

  sendCommands(commands: SimCommand[]): void {
    if (commands.length > 0) {
      this.#post({
        type: MainToWorkerKind.commands,
        commands: commands.map(cmd => ({playerId: this.playerId, cmd})),
      });
    }
  }

  setSpeed(speed: number): void {
    this.#post({type: MainToWorkerKind.setSpeed, speed});
  }

  setDebug(enabled: boolean): void {
    this.#post({type: MainToWorkerKind.setDebug, enabled});
  }

  setHidden(hidden: boolean): void {
    this.#post({type: MainToWorkerKind.setHidden, hidden});
  }

  #post(msg: MainToWorker): void {
    this.#worker.postMessage(msg);
  }
}
