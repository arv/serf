/// <reference lib="webworker" />
import { SAB_BYTES, SabWriter } from '../protocol/sabLayout';
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
import type { UnitSnapshot } from '../protocol/sabLayout';

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
/** The latest server frame, indexed — where an order starts from. */
let lastUnits = new Map<number, UnitSnapshot>();

function post(msg: WorkerToMain, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(msg, transfer);
}

function postStatus(status: NetStatus): void {
  const key = JSON.stringify(status);
  if (key === lastStatus) return;
  lastStatus = key;
  post({ type: 'netStatus', status });
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
    type: 'structural',
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
    post({ type: 'ready', sab, map, buildings: payload.buildings, explored });
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
      lastUnits = new Map(frame.units.map((u) => [u.id, u]));
      predictor?.apply(frame.units, myPlayerId);
      writer?.publish(frame.units);
      return;
    }
    case 'struct': {
      const json = frame.json as Omit<StructuralUpdate, 'type' | 'tick'>;
      post({ ...json, type: 'structural', tick: frame.tick });
      return;
    }
    case 'pong': {
      // The echo is our own send time, truncated the same way; a negative
      // or absurd delta means the 32-bit counter wrapped mid-flight, so
      // keep the previous estimate rather than reporting nonsense.
      const rtt = (Date.now() % 0xffffffff) - frame.clientTimeEcho;
      if (rtt >= 0 && rtt < 60_000) rttMs = rtt;
      postStatus({ state: 'ok', rttMs });
      return;
    }
    default:
      return; // 'cmd' and 'ping' are ours, never inbound
  }
}

function connect(net: NetInfo, attempt: number): void {
  const ws = new WebSocket(net.relayUrl);
  socket = ws;
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    // The lobby socket is already closed by now, so the seat is claimed by
    // token — the same path a genuine reconnect takes.
    ws.send(JSON.stringify({ t: 'rejoin', token: net.token }));
    ws.send(encodePing(Date.now() % 0xffffffff));
  };
  ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
    if (typeof e.data === 'string') return; // lobby chatter; nothing to do
    onFrame(new Uint8Array(e.data));
  };
  ws.onclose = () => {
    postStatus({ state: 'disconnected' });
    const delay = Math.min(500 * 2 ** attempt, 8000);
    setTimeout(() => connect(net, attempt + 1), delay);
  };
  ws.onerror = () => ws.close();
}

function init(net: NetInfo): void {
  connect(net, 0);
  setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(encodePing(Date.now() % 0xffffffff));
  }, 2000);
}

function sendCommands(commands: SimCommand[]): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  // Start moving before the server has heard the order — the dead window
  // between click and answer is the whole of what a player feels as lag.
  for (const cmd of commands) {
    if (cmd.kind === 'moveUnits') predictor?.order(cmd.unitIds, cmd.x, cmd.y, lastUnits);
  }
  socket.send(encodeCmd(++seq, commands));
}

self.onmessage = (e: MessageEvent<MainToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      if (!msg.net) throw new Error('netWorker requires net info');
      myPlayerId = msg.net.playerId;
      init(msg.net);
      break;
    case 'commands':
      // The envelope's playerId is advisory here — the server stamps
      // identity from the authenticated seat.
      sendCommands(msg.commands.map((c) => c.cmd));
      break;
    // Speed and save are single-player affairs: a shared world runs at one
    // rate, and there is nothing local to serialize.
    case 'setSpeed':
    case 'requestSave':
      break;
  }
};
