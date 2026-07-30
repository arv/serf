/// <reference lib="webworker" />
import { createWorld, type World } from '../sim/world';
import { deserializeWorld, serializeWorld } from '../sim/save';
import { tickWorld } from '../sim/tick';
import { UNIT_DEFS, carryingCode } from '../sim/defs/units';
import { MATCHER_INTERVAL, TICK_MS } from '../sim/defs/balance';
import { buildingDef } from '../sim/defs/buildings';
import { TECH_DEFS } from '../sim/defs/techs';
import { checkInvariants, checkLedger, countGoods } from '../sim/debug/invariants';
import { findStorehouse } from '../sim/systems/logistics';
import { GOODS, type GoodAmounts } from '../sim/defs/goods';
import type { PlayerCommand } from '../sim/tick';
import {
  ACTION,
  PROFESSION,
  SAB_BYTES,
  SabWriter,
  WORK,
  type UnitSnapshot,
} from '../protocol/sabLayout';
import type { Building } from '../sim/entities';
import type { Unit } from '../sim/units';
import type {
  BuildingSnap,
  MainToWorker,
  NetInfo,
  NetStatus,
  PlayerSnap,
  WorkerToMain,
} from '../protocol/messages';
import { RollbackSession } from '../net/rollback';
import { decodeFrame, encodeHash, encodePing, encodeTurnSubmit } from '../protocol/net';
import { hashWorld } from '../sim/hash';
import type { GameEvent } from '../sim/world';

/**
 * Worker entry: owns the World and the fixed-timestep loop. Publishes unit
 * state to the SAB once per interval; structural state goes over postMessage
 * every few ticks.
 */

let world: World | null = null;
let writer: SabWriter | null = null;
let speed = 1; // ticks per interval; 0 = paused
let pendingCommands: PlayerCommand[] = [];
let initialGoods: GoodAmounts = {};
let lastInvariantViolations: string[] = [];

// --- Networked-match state (absent in single-player) ----------------------
let session: RollbackSession | null = null;
let socket: WebSocket | null = null;
let confirmedEvents: GameEvent[] = [];
let needFullRefresh = false;
let netInfo: NetInfo | null = null;
let worldBlob: string | null = null;
// Server clock estimate from the latest PONG.
let pongClosedTick = -1;
let pongAtMs = 0;
let rttMs = 120;
let lastStatus = '';
const HASH_INTERVAL = 20; // confirmed ticks between HASH reports

const post = (msg: WorkerToMain): void => {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
};

self.onmessage = (e: MessageEvent<MainToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      init(msg.config, msg.loadData, msg.net);
      break;
    case 'commands':
      if (session && socket) {
        // Networked: wrap as an envelope, schedule optimistically, ship it.
        const envelope = session.submitLocal(msg.commands.map((c) => c.cmd));
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(encodeTurnSubmit(envelope));
        }
      } else {
        pendingCommands.push(...msg.commands);
      }
      break;
    case 'setSpeed':
      if (!session) speed = msg.speed; // lockstep runs at 1x, always
      break;
    case 'requestSave':
      if (world) post({ type: 'saved', data: serializeWorld(world) });
      break;
  }
};

function snapBuilding(b: Building): BuildingSnap {
  const def = buildingDef(b.type);
  let staffing: BuildingSnap['staffing'];
  const wantsStaff =
    b.state === 'built' ? def.workerKind !== undefined : b.state === 'site' && !def.isRoad;
  if (wantsStaff) {
    const worker = b.workerId !== undefined ? world?.units.get(b.workerId) : undefined;
    staffing = worker && !worker.dead ? 'staffed' : b.recruitId !== undefined ? 'recruiting' : 'needed';
  }
  return {
    staffing,
    id: b.id,
    type: b.type,
    owner: b.owner,
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
    hp: b.hp,
    maxHp: def.hp,
    state: b.state,
    siteNeeds: b.siteNeeds ? { ...b.siteNeeds } : undefined,
    progress01:
      b.state === 'site' && def.buildTicks > 0
        ? (b.buildProgress ?? 0) / def.buildTicks
        : undefined,
    stock: { ...b.stock },
    inputs: { ...b.inputs },
    inbound: { ...b.inbound },
    reservedOut: { ...b.reservedOut },
    trainQueue: b.trainQueue?.map((q) => ({ unit: q.unit, started: q.started })),
  };
}

function init(config: import('../sim/world').WorldConfig, loadData?: string, net?: NetInfo): void {
  world = loadData !== undefined ? deserializeWorld(loadData) : createWorld(config);
  if (net) {
    netInfo = net;
    worldBlob = loadData ?? null;
    session = makeSession(world, net.playerId);
    world = session.predicted; // the renderer's world
    openSocket(net);
  }
  initialGoods = countGoods(world);
  const sab = new SharedArrayBuffer(SAB_BYTES);
  writer = new SabWriter(sab);

  post({
    type: 'ready',
    sab,
    map: {
      terrain: world.map.terrain.slice(),
      resource: world.map.resource.slice(),
      blocked: world.map.blocked.slice(),
      buildingAt: world.map.buildingAt.slice(),
      pathLevel: world.map.pathLevel.slice(),
      height: world.map.height.slice(),
    },
    buildings: [...world.buildings.values()].map(snapBuilding),
  });

  publish();
  postStructural();
  // Dedicated-worker timers are not throttled like main-thread timers, so a
  // plain interval keeps the sim running even when the tab is hidden. The
  // fine-grained pump + accumulator (instead of one 50ms interval) is the
  // lockstep foundation: tick timing follows accumulated time, and
  // `rateAdjust` lets the netcode nudge the clock to track the relay.
  lastPump = performance.now();
  setInterval(pump, 10);
}

/** Netcode drift-correction knob (1.0 in single-player). */
let rateAdjust = 1.0;
let lastPump = 0;
let acc = 0;
/** Cap banked time so a debugger pause doesn't unleash a tick avalanche. */
const MAX_CATCHUP_QUANTA = 10;

function makeSession(base: World, playerId: number): RollbackSession {
  const s = new RollbackSession(base, playerId);
  s.onConfirmedTick = (_w, events) => {
    confirmedEvents.push(...events);
  };
  s.onRollback = () => {
    needFullRefresh = true;
  };
  return s;
}

/**
 * Desync recovery: determinism makes the blob + closed history the
 * authoritative state, so rebuild from scratch and let the reconnect
 * stream replay everything. Costs a "rejoining" moment, never a guess.
 */
function resyncFromHistory(): void {
  if (!worldBlob || !netInfo || !session) return;
  const base = deserializeWorld(worldBlob);
  session = makeSession(base, netInfo.playerId);
  world = session.predicted;
  lastHashedTick = 0;
  needFullRefresh = true;
  socket?.close(); // the reconnect handler streams the full history
}

/** Server tick the relay has closed by now, per the latest PONG. */
function estimatedClosedTick(now: number): number {
  if (pongClosedTick < 0) return -1;
  return pongClosedTick + Math.floor((now - pongAtMs + rttMs / 2) / TICK_MS);
}

function postStatus(status: NetStatus): void {
  const key = JSON.stringify(status);
  if (key === lastStatus) return;
  lastStatus = key;
  post({ type: 'netStatus', status });
}

let lastHashedTick = 0;

function netPump(): void {
  if (!world || !writer || !session) return;
  const now = performance.now();
  // Aim prediction just past the server's closed frontier so submissions
  // arrive before their desired tick closes.
  const lead = Math.ceil(rttMs / 2 / TICK_MS) + 1;
  const target = estimatedClosedTick(now) + lead;
  session.advancePredicted(Math.min(target, session.predictedTick + 10));
  world = session.predicted; // rollback replaces the object — re-point
  if (session.stalled) {
    postStatus({ state: 'stalled', behindTicks: session.lead });
  } else {
    postStatus({ state: 'ok', rttMs: Math.round(rttMs), behindTicks: session.lead });
  }
  // Predicted events never surface (confirmed is the exactly-once source).
  world.pendingEvents.length = 0;
  publish();
  if (
    needFullRefresh ||
    world.pendingDeltas.length > 0 ||
    world.tick % MATCHER_INTERVAL === 0
  ) {
    postStructural();
  }
}

function openSocket(net: NetInfo): void {
  // One ping timer across reconnects.
  setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(encodePing(performance.now() >>> 0));
    }
  }, 2000);
  connectSocket(net, 0);
}

function connectSocket(net: NetInfo, attempt: number): void {
  const ws = new WebSocket(net.relayUrl);
  ws.binaryType = 'arraybuffer';
  socket = ws;
  ws.onopen = () => {
    // Bind this socket to our seat; the server streams the closed history
    // (empty at match start, everything since on a reconnect — confirmed
    // catches up by replay) and then live TURN frames.
    ws.send(JSON.stringify({ t: 'rejoin', token: net.token }));
    ws.send(encodePing(performance.now() >>> 0));
  };
  ws.onmessage = (e: MessageEvent) => {
    if (typeof e.data === 'string') {
      const msg = JSON.parse(e.data) as { t: string; tick?: number };
      if (msg.t === 'desync') {
        postStatus({ state: 'desync', tick: msg.tick ?? 0 });
        resyncFromHistory();
      }
      return;
    }
    const frame = decodeFrame(new Uint8Array(e.data as ArrayBuffer));
    if (frame.kind === 'turn' && session) {
      session.ingestTurns(frame.firstTick, frame.tickCount, frame.records);
      // Report confirmed-world hashes on a fixed cadence.
      while (session.confirmedTick >= lastHashedTick + HASH_INTERVAL) {
        lastHashedTick += HASH_INTERVAL;
        if (session.confirmedTick === lastHashedTick && ws.readyState === WebSocket.OPEN) {
          ws.send(encodeHash(lastHashedTick, hashWorld(session.confirmed)));
        }
      }
    } else if (frame.kind === 'pong') {
      const now = performance.now();
      rttMs = Math.max(1, (now >>> 0) - frame.clientTimeEcho);
      pongClosedTick = frame.serverClosedTick === 0xffffffff ? -1 : frame.serverClosedTick;
      pongAtMs = now;
    }
  };
  ws.onclose = () => {
    postStatus({ state: 'disconnected' });
    // Same token, exponential-ish backoff — the relay keeps the seat warm.
    const delay = Math.min(500 * 2 ** attempt, 8000);
    setTimeout(() => connectSocket(net, attempt + 1), delay);
  };
}

function pump(): void {
  if (!world || !writer) return;
  if (session) {
    netPump();
    return;
  }
  const now = performance.now();
  acc = Math.min(acc + (now - lastPump) * rateAdjust, TICK_MS * MAX_CATCHUP_QUANTA);
  lastPump = now;
  // While paused, commands stay queued and apply on unpause — the classic
  // "issue orders during pause" affordance. Banked time is dropped.
  if (speed <= 0) {
    acc = 0;
    return;
  }
  let ran = false;
  while (acc >= TICK_MS) {
    acc -= TICK_MS;
    // One 50ms quantum = `speed` ticks (0/1/3), commands on its first tick —
    // byte-compatible with the old fixed-interval loop.
    const commands = pendingCommands;
    pendingCommands = [];
    for (let i = 0; i < speed; i++) {
      tickWorld(world, i === 0 ? commands : []);
      if (import.meta.env.DEV && world.tick % 20 === 0) {
        const report = checkInvariants(world);
        const ledger = checkLedger(world, initialGoods);
        lastInvariantViolations = [...report.violations, ...ledger];
        for (const v of lastInvariantViolations) console.warn(`[invariant] t${world.tick} ${v}`);
      }
    }
    ran = true;
  }
  if (ran) {
    publish();
    if (world.tick % MATCHER_INTERVAL === 0 || world.pendingDeltas.length > 0) {
      postStructural();
    }
  }
}

function snapPlayers(w: import('../sim/world').World): PlayerSnap[] {
  return w.players.map((p) => {
    const storehouse = findStorehouse(w, p.id);
    let hasTerakoya = false;
    for (const b of w.buildings.values()) {
      if (!b.dead && b.type === 'terakoya' && b.state === 'built' && b.owner === p.id) {
        hasTerakoya = true;
      }
    }
    return {
      id: p.id,
      kind: p.kind,
      alive: p.alive,
      stock: storehouse ? { ...storehouse.stock } : {},
      techs: {
        researched: [...p.techs.researched],
        active: p.techs.active
          ? {
              tech: p.techs.active.tech,
              ticksLeft: p.techs.active.ticksLeft,
              totalTicks: TECH_DEFS[p.techs.active.tech].durationTicks,
            }
          : undefined,
        festivalTicksLeft: p.techs.festivalTicksLeft,
        pavingUnlocked: p.pavingUnlocked,
        hasTerakoya,
      },
    };
  });
}

function postStructural(): void {
  if (!world) return;
  const fullMap = needFullRefresh
    ? {
        resource: world.map.resource.slice(),
        blocked: world.map.blocked.slice(),
        pathLevel: world.map.pathLevel.slice(),
        buildingAt: world.map.buildingAt.slice(),
      }
    : undefined;
  needFullRefresh = false;
  post({
    type: 'structural',
    tick: world.tick,
    buildings: [...world.buildings.values()].filter((b) => !b.dead).map(snapBuilding),
    mapDeltas: world.pendingDeltas.splice(0),
    fullMap,
    players: snapPlayers(world),
    admin: { ...world.admin },
    // Networked: events and the match outcome speak only confirmed truth —
    // prediction never shows a toast or a game-over it might take back.
    events: session ? confirmedEvents.splice(0) : world.pendingEvents.splice(0),
    outcome: session ? session.confirmed.outcome : world.outcome,
    jobs: [...world.jobs.values()].map((j) => ({
      id: j.id,
      good: j.good,
      from: j.from,
      to: j.to,
      priority: j.priority,
      phase: j.phase,
      serfId: j.serfId,
      age: world!.tick - j.createdTick,
    })),
    invariantViolations: lastInvariantViolations,
  });
}

/** What is this unit visibly doing? Drives limb animation in the renderer. */
function actionOf(w: World, u: Unit): number {
  if (u.dead) return ACTION.dead;
  // Engaged fighters swing (the renderer overrides with a walk while moving).
  if (UNIT_DEFS[u.kind].combat && u.targetId !== undefined) return ACTION.fight;
  // Gather workers swinging at a resource tile.
  if (u.task.t === 'gatherWork') return ACTION.work;
  // Resident workers: builders hammering up their site once materials are
  // in, or convert-building staff mid-batch (hoeing, hammering...).
  if (u.homeId !== undefined && u.task.t === 'idle') {
    const home = w.buildings.get(u.homeId);
    if (home && !home.dead) {
      if (home.state === 'site') {
        const waiting = GOODS.some((g) => ((home.siteNeeds ?? {})[g] ?? 0) > 0);
        return waiting ? ACTION.idle : ACTION.work;
      }
      if (home.prodTicksLeft !== undefined) return ACTION.work;
    }
  }
  return ACTION.idle;
}

/** Which tool animation fits this unit's work site? */
/** Workplace flavor for themed worker bodies (the farmer's straw hat). */
function professionOf(w: World, u: Unit): number {
  if (u.kind !== 'worker' || u.homeId === undefined) return PROFESSION.none;
  const home = w.buildings.get(u.homeId);
  if (!home || home.dead) return PROFESSION.none;
  if (home.type === 'ricePaddy') return PROFESSION.farmer;
  if (
    home.type === 'quarry' ||
    home.type === 'ironMine' ||
    home.type === 'silverMine' ||
    home.type === 'goldMine'
  ) {
    return PROFESSION.miner;
  }
  return PROFESSION.none;
}

function workKindOf(w: World, u: Unit): number {
  const home = u.homeId !== undefined ? w.buildings.get(u.homeId) : undefined;
  if (!home) return WORK.tend;
  if (home.state === 'site') return WORK.hammer; // builder at the frame
  const def = buildingDef(home.type);
  if (def.recipe?.kind === 'gather') {
    return def.recipe.resource === 'bamboo' ? WORK.chop : WORK.pickaxe;
  }
  if (home.type === 'swordsmith' || home.type === 'spearmaker' || home.type === 'bowyer') {
    return WORK.hammer;
  }
  if (home.type === 'ricePaddy') return WORK.dig;
  if (home.type === 'well') return WORK.draw; // cranking the bucket up
  return WORK.tend;
}

function* unitSnapshots(w: World): Generator<UnitSnapshot> {
  for (const u of w.units.values()) {
    // Combat corpses (deathTick set) stay visible for the death animation;
    // other dead units (dojo consumption) vanish immediately.
    if (u.dead && u.deathTick === undefined) continue;
    const action = actionOf(w, u);
    yield {
      id: u.id,
      x: u.x,
      y: u.y,
      kind: UNIT_DEFS[u.kind].kindCode,
      owner: u.owner, // numeric owner rides the aux byte raw
      hpPct:
        action === ACTION.dead
          ? 0
          : Math.max(0, Math.min(255, Math.round((u.hp / UNIT_DEFS[u.kind].hp) * 255))),
      carrying: action === ACTION.dead ? 0 : carryingCode(u.carrying),
      action,
      workKind: action === ACTION.work ? workKindOf(w, u) : WORK.none,
      profession: professionOf(w, u),
    };
  }
}

function publish(): void {
  if (!world || !writer) return;
  writer.publish(unitSnapshots(world));
}
