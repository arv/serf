/// <reference lib="webworker" />
import { SAB_BYTES, SabWriter, type UnitSnapshot } from '../protocol/sabLayout';
import { decodeState, encodeCmd, encodePing } from '../protocol/state';
import { MovePredictor } from '../net/predict';
import type {
  BuildingSnap,
  MainToWorker,
  MapSnapshot,
  NetInfo,
  NetStatus,
  StructuralUpdate,
  WorkerToMain,
} from '../protocol/messages';
import type { SimCommand } from '../sim/commands';
import * as CommandKind from '../sim/commandKindEnum.ts';
import * as MainToWorkerKind from '../protocol/mainToWorkerKindEnum.ts';
import * as WorkerToMainKind from '../protocol/workerToMainKindEnum.ts';
import * as NetState from '../protocol/netStateEnum.ts';

/**
 * The multiplayer client's end of the wire. It holds the socket, decodes the
 * server's state frames into the SharedArrayBuffer and the structural
 * channel, and sends orders back.
 *
 * There is no World here and no tickWorld — that is the entire point. The
 * server simulates, and this client cannot see anything the server did not
 * choose to tell it. It speaks the same worker protocol as simWorker.ts, so
 * the main thread and the whole renderer cannot tell the two apart.
 */

let sab: SharedArrayBuffer | null = null;
let writer: SabWriter | null = null;
let socket: WebSocket | null = null;
let seq = 0;
let rttMs = 0;
let lastStatus = '';
/** The `ready` handshake happens once; a reconnect re-inits the mirror. */
let started = false;
/** Our own seat, and prediction for its units' movement. */
let myPlayerId = 0;
let predictor: MovePredictor | null = null;
/** The latest server frame — where an order starts from. Indexed lazily:
 * frames arrive at 20 Hz but the index is only needed on a user command. */
let lastUnitRows: readonly UnitSnapshot[] = [];
let lastUnitsIndex: Map<number, UnitSnapshot> | null = null;

function post(msg: WorkerToMain, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(msg, transfer);
}

function postStatus(status: NetStatus): void {
  const key = JSON.stringify(status);
  if (key === lastStatus) return;
  lastStatus = key;
  post({ type: WorkerToMainKind.netStatus, status });
}

interface InitPayload {
  buildings: BuildingSnap[];
  players: StructuralUpdate['players'];
  admin: StructuralUpdate['admin'];
  outcome: StructuralUpdate['outcome'];
}

/** A structural update carrying no news but the current roster — used to
 * prime the HUD at match start and to resync the mirror after a reconnect. */
function rosterUpdate(
  tick: number,
  payload: InitPayload,
  fullMap?: StructuralUpdate['fullMap'],
): StructuralUpdate {
  return {
    type: WorkerToMainKind.structural,
    tick,
    buildings: payload.buildings,
    mapDeltas: [],
    fullMap,
    players: payload.players,
    admin: payload.admin,
    events: [],
    outcome: payload.outcome,
    jobs: [],
    invariantViolations: [],
  };
}

function onInit(tick: number, map: MapSnapshot, explored: Uint8Array, payload: InitPayload): void {
  // Prediction paths on the map we were given, with the same pathfinder the
  // server moves with. A resend means the world moved on without us, so any
  // guess in flight is stale.
  predictor = new MovePredictor(map);
  if (!started) {
    started = true;
    sab = new SharedArrayBuffer(SAB_BYTES);
    writer = new SabWriter(sab);
    post({ type: WorkerToMainKind.ready, sab, map, buildings: payload.buildings, explored });
    // The roster arrives with the map, so the HUD has stock and tech
    // immediately rather than after the first structural frame.
    post(rosterUpdate(tick, payload));
    return;
  }
  // Reconnect: the server's world moved on without us, so replace the
  // mirror's mutable map wholesale rather than trusting missed deltas.
  const update = rosterUpdate(tick, payload, {
    resource: map.resource,
    blocked: map.blocked,
    pathLevel: map.pathLevel,
    buildingAt: map.buildingAt,
  });
  update.explored = explored;
  post(update);
}

function onFrame(data: Uint8Array): void {
  const frame = decodeState(data);
  if (!frame) return;
  switch (frame.kind) {
    case 'init':
      onInit(frame.tick, frame.map, frame.explored, frame.json as InitPayload);
      return;
    case 'hot': {
      lastUnitRows = frame.units;
      lastUnitsIndex = null;
      predictor?.apply(frame.units, myPlayerId);
      writer?.publish(frame.units);
      return;
    }
    case 'struct': {
      const json = frame.json as Omit<StructuralUpdate, 'type' | 'tick'>;
      post({ ...json, type: WorkerToMainKind.structural, tick: frame.tick });
      return;
    }
    case 'pong': {
      // The echo is our own send time, truncated the same way; a negative
      // or absurd delta means the 32-bit counter wrapped mid-flight, so
      // keep the previous estimate rather than reporting nonsense.
      const rtt = (Date.now() % 0xffffffff) - frame.clientTimeEcho;
      if (rtt >= 0 && rtt < 60_000) rttMs = rtt;
      postStatus({ state: NetState.ok, rttMs });
      return;
    }
    default:
      return; // 'cmd' and 'ping' are ours, never inbound
  }
}

/** Set when the relay disowns our token: the match is gone for good. */
let gone = false;

/**
 * Page hidden (the main thread's report). The world is shared and waits for
 * no one, so unlike the solo sim nothing pauses — but this seat goes quiet:
 * the relay is told to stop streaming to it (and answers the return with a
 * full init resync), pings stop, and a socket that drops waits for the page
 * to be visible again before redialing. Worker timers are unthrottled, so
 * without this a backgrounded phone kept its radio and CPU busy decoding
 * 20 Hz frames nobody was watching.
 */
let hidden = false;
/** The connection info, kept for the redial an unhide may owe. */
let netInfo: NetInfo | null = null;

/** Debug overlay open on the main thread. The server only serializes the
 * jobs table into this seat's struct frames while it is told someone is
 * watching, so the toggle is forwarded — and re-sent on every reconnect,
 * since a restarted relay starts every seat with the overlay closed. */
let debugWanted = false;

function sendDebug(ws: WebSocket): void {
  ws.send(JSON.stringify({ t: 'debug', enabled: debugWanted }));
}

function connect(net: NetInfo, attempt: number): void {
  // Every dial funnels through here, including the reconnect loop's timers:
  // a backgrounded phone must not spend its radio retrying, so the attempt
  // is dropped and the unhide redials at once instead (see 'setHidden').
  if (hidden) return;
  // One socket at a time. The unhide redial and a retry timer scheduled
  // before the hide can both land here; whoever finds a dial already live
  // yields to it rather than opening a second socket.
  if (
    socket &&
    (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)
  ) {
    return;
  }
  const ws = new WebSocket(net.relayUrl);
  socket = ws;
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    // The lobby socket is already closed by now, so the seat is claimed by
    // token — the same path a genuine reconnect takes.
    ws.send(JSON.stringify({ t: 'rejoin', token: net.token }));
    if (debugWanted) sendDebug(ws);
    // Hidden already? The page hid while this socket was dialing — say so
    // before the relay starts streaming to a seat nobody is watching.
    if (hidden) ws.send(JSON.stringify({ t: 'hidden', hidden: true }));
    ws.send(encodePing(Date.now() % 0xffffffff));
  };
  ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
    if (typeof e.data === 'string') {
      // Two strings matter here. The relay refusing our token: the
      // reconnect loop used to skip every string frame, so a swept room
      // meant retrying forever behind a 'Reconnecting...' bar. And the
      // replay answer: the server's recording of the match, requested at
      // the end card's Save replay button (null while undecided — the
      // main thread reads the empty string as "nothing to save").
      try {
        const msg = JSON.parse(e.data) as { t?: string; data?: unknown };
        if (msg.t === 'error') {
          gone = true;
          postStatus({
            state: NetState.gone,
            message: 'The room has wound down — the match is over.',
          });
          ws.close();
        } else if (msg.t === 'replay') {
          post({
            type: WorkerToMainKind.replayData,
            data: typeof msg.data === 'string' ? msg.data : '',
          });
        }
      } catch {
        // Non-JSON lobby chatter; nothing to do.
      }
      return;
    }
    onFrame(new Uint8Array(e.data));
  };
  ws.onclose = () => {
    if (gone) return;
    postStatus({ state: NetState.disconnected });
    const delay = Math.min(500 * 2 ** attempt, 8000);
    setTimeout(() => connect(net, attempt + 1), delay);
  };
  ws.onerror = () => ws.close();
}

function init(net: NetInfo): void {
  netInfo = net;
  connect(net, 0);
  setInterval(() => {
    // Not while hidden: the RTT it measures has no reader, and each ping
    // costs a backgrounded phone a radio wake-up.
    if (!hidden && socket?.readyState === WebSocket.OPEN) {
      socket.send(encodePing(Date.now() % 0xffffffff));
    }
  }, 2000);
}

function sendCommands(commands: SimCommand[]): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  // Start moving before the server has heard the order — the dead window
  // between click and answer is the whole of what a player feels as lag.
  for (const cmd of commands) {
    if (cmd.kind === CommandKind.moveUnits) {
      lastUnitsIndex ??= new Map(lastUnitRows.map((u) => [u.id, u]));
      predictor?.order(cmd.unitIds, cmd.x, cmd.y, lastUnitsIndex);
    }
  }
  socket.send(encodeCmd(++seq, commands));
}

self.onmessage = (e: MessageEvent<MainToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case MainToWorkerKind.init:
      if (!msg.net) throw new Error('netWorker requires net info');
      myPlayerId = msg.net.playerId;
      init(msg.net);
      break;
    case MainToWorkerKind.commands:
      // The envelope's playerId is advisory here — the server stamps
      // identity from the authenticated seat.
      sendCommands(msg.commands.map((c) => c.cmd));
      break;
    case MainToWorkerKind.setDebug:
      // The server holds the jobs table, so the overlay's open/closed state
      // is relayed to it rather than handled here.
      if (debugWanted !== msg.enabled) {
        debugWanted = msg.enabled;
        if (socket?.readyState === WebSocket.OPEN) sendDebug(socket);
      }
      break;
    case MainToWorkerKind.setHidden:
      // The shared world runs on whoever looks away — but this seat's
      // stream needn't. Tell the relay; it stops sending while we are
      // hidden and answers the return with a full init resync (the same
      // frame a rejoin gets), which onInit applies wholesale.
      if (hidden === msg.hidden) break;
      hidden = msg.hidden;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ t: 'hidden', hidden }));
        // Back in view: refresh the RTT the paused pings let go stale.
        if (!hidden) socket.send(encodePing(Date.now() % 0xffffffff));
      } else if (!hidden && netInfo && !gone) {
        // Back in view without a live socket — it dropped while hidden, or
        // the match booted backgrounded and the first dial was skipped.
        // Redial now rather than wait out a retry timer's backoff; connect
        // itself yields if a dial is already in flight.
        connect(netInfo, 0);
      }
      break;
    case MainToWorkerKind.requestReplay:
      // The server holds the world, so it holds the recording too. Ask for
      // this seat's copy; the answer comes back as a {t:'replay'} string
      // frame. With no live socket, answer empty ourselves — the promise
      // behind this must resolve so the Save button can report failure.
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ t: 'replay' }));
      } else {
        post({ type: WorkerToMainKind.replayData, data: '' });
      }
      break;
    // Speed and saving are single-player affairs: a shared world runs at
    // one rate whoever looks away, and there is nothing local to
    // serialize.
    case MainToWorkerKind.setSpeed:
    case MainToWorkerKind.requestSave:
      break;
  }
};
