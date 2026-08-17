/**
 * Turning the authoritative world into per-seat frames.
 *
 * This is the file that ends information cheating. A client is not trusted
 * to hide what it has been told — it is never told. Everything a seat
 * receives passes through the filters here, so a maphack has nothing to
 * reveal and a debugger attached to the browser finds only what that seat
 * has legitimately observed.
 *
 * Two rules, lifted from how the renderer used to hide things:
 * - units by *current* visibility — a raider you saw a minute ago is gone
 * - buildings by *exploration*, frozen at last sight — a camp does not walk
 *   away, but nor do you watch it being built from across the map
 *
 * `pendingDeltas` and `pendingEvents` on the world are drain-once outboxes,
 * so they are emptied a single time per pump and then distributed. Draining
 * per seat would hand seat 0 the map deltas and leave everyone else stale.
 */
import { encodeHot, encodeInit, encodeStructBody } from '../../src/protocol/state.ts';
import { snapBuilding, snapJobs, snapPlayers, unitSnapshots } from '../../src/protocol/snapshot.ts';
import { tileCount } from '../../src/shared/grid.ts';
import { tileBlocks } from '../../src/sim/map.ts';
import { SeatVision } from '../../src/sim/visibility.ts';
import type { UnitSnapshot } from '../../src/protocol/sabLayout.ts';
import type { BuildingSnap, MapSnapshot, PlayerSnap } from '../../src/protocol/messages.ts';
import type { EntityId } from '../../src/sim/entities.ts';
import type { GameEvent, MapDelta, World } from '../../src/sim/world.ts';
import type { Room, Seat } from './rooms.ts';

/** Ticks between structural-frame *checks* — a cadence cap, not a schedule:
 * a checked frame identical to the last one sent goes nowhere. */
const MIN_STRUCT_GAP = 5;

/**
 * Backpressure. A client whose TCP has stalled — a locked phone, a radio
 * drop — fires no 'close' for potentially minutes, while ws buffers every
 * frame in process memory. Hot frames are disposable (the renderer diffs
 * the two newest, and a gap reads as standing still), so they stop first;
 * a socket that keeps falling behind is not a client anymore and is cut,
 * which the rejoin-by-token path recovers from cleanly.
 */
const HOT_DROP_BUFFERED = 64 * 1024;
const STALLED_BUFFERED = 1024 * 1024;

/** Per-seat filtering state, sized to the room's world. */
export class SeatView {
  readonly vision: SeatVision;
  /** Enemy buildings as this seat last saw them, by id. */
  readonly lastSeen = new Map<EntityId, BuildingSnap>();
  /** Map news owed to this seat, held until the next structural frame. */
  readonly owedTiles = new Set<number>();
  /** Events owed likewise. They are drained from the world once per pump,
   * so a seat that is between structural frames has to keep its own copy
   * or the raid warning is simply lost. */
  readonly owedEvents: GameEvent[] = [];
  lastStructTick = -1;
  /** The rosters as last sent, stringified — how an unchanged section is
   * recognized and left out of the frame (and an entirely news-less frame
   * skipped). Reset by sendInit: the init frame re-baselines the client. */
  lastBuildingsBody = '';
  lastPlayersBody = '';
  lastMiscBody = '';
  /** When each tile's contents were last sent to this seat, stored as
   * `tick + 1` so 0 means "never" even for a send at tick 0. Compared
   * against Room.tileChangedTick (same offset) when ground is re-revealed,
   * so a tile the seat already knows correctly owes it nothing. */
  readonly tileSentTick: Uint32Array;

  constructor(size: number) {
    this.vision = new SeatVision(size);
    this.tileSentTick = new Uint32Array(tileCount(size));
  }
}

function send(seat: Seat, frame: Uint8Array, droppable = false): void {
  const ws = seat.ws;
  if (!seat.connected || !ws) return;
  if (ws.bufferedAmount >= STALLED_BUFFERED) {
    // Marked disconnected before the terminate so nothing else queues onto
    // the dead socket this pump; the 'close' handler does the rest of the
    // seat bookkeeping when the terminate lands.
    seat.connected = false;
    ws.terminate();
    return;
  }
  if (droppable && ws.bufferedAmount >= HOT_DROP_BUFFERED) return;
  ws.send(frame);
}

function tileDelta(world: World, idx: number): MapDelta {
  return {
    idx,
    resource: world.map.resource[idx]!,
    blocked: world.map.blocked[idx]!,
    pathLevel: world.map.pathLevel[idx]!,
    buildingAt: world.map.buildingAt[idx]!,
  };
}

/** Refresh every seat's vision and note what each one newly observed. */
export function recomputeVision(room: Room): void {
  const world = room.world;
  if (!world) return;
  for (const seat of room.seats) {
    if (!seat.view) continue;
    seat.view.vision.recompute(world, seat.playerId);
    // Newly lit ground: a delta only fires when a tile *changes*, so land
    // built on while we were not looking would stay wrong forever. Ground
    // that has not changed since this seat last received it owes nothing,
    // though — wandering sight circles re-reveal the same quiet tiles all
    // match long.
    for (const idx of seat.view.vision.revealed) {
      if (room.tileChangedTick[idx]! > seat.view.tileSentTick[idx]!) {
        seat.view.owedTiles.add(idx);
      }
    }
  }
}

/**
 * The map as this seat is allowed to know it at match start.
 *
 * Terrain, height and the natural resource layout go out whole: that is the
 * shape of the world, hiding it would mean streaming terrain geometry, and
 * the map reads as an empty void without it. Start positions come from a
 * fixed function of the map size and seat count anyone can read in the
 * source (startLayout in world.ts).
 *
 * What is withheld is the part that carries ongoing intelligence:
 * `buildingAt` and `pathLevel` — what a rival has built, and where they
 * walk. Those arrive tile by tile as ground is observed.
 *
 * `blocked` has to be rebuilt rather than merely copied, because it is
 * derived from both. A tile that is blocked while being grass with nothing
 * growing on it is a building footprint by elimination, so shipping the
 * grid whole handed over every rival structure on the map — and sendInit
 * runs again on every rejoin, which made disconnecting and reconnecting a
 * repeatable full-map scan. Unexplored ground gets only the landscape's
 * share of it (water and standing resources, exactly what recomputeBlocked
 * derives from the arrays already sent); the building share arrives with
 * the map deltas, as ground is explored.
 */
function initialMap(world: World, view: SeatView): MapSnapshot {
  const tiles = tileCount(world.map.size);
  const buildingAt = new Int16Array(tiles).fill(-1);
  const pathLevel = new Uint8Array(tiles);
  const blocked = new Uint8Array(tiles);
  for (let i = 0; i < tiles; i++) {
    if (view.vision.explored[i]) {
      buildingAt[i] = world.map.buildingAt[i]!;
      pathLevel[i] = world.map.pathLevel[i]!;
      blocked[i] = world.map.blocked[i]!;
    } else {
      blocked[i] = tileBlocks(world.map.terrain[i]!, world.map.resource[i]!) ? 1 : 0;
    }
  }
  return {
    size: world.map.size,
    terrain: world.map.terrain,
    resource: world.map.resource,
    blocked,
    pathLevel,
    buildingAt,
    height: world.map.height,
  };
}

/** Every seat's block, but only our own carries stock and tech. Rival
 * economies are exactly the thing scouting is supposed to cost. */
function redactPlayers(players: PlayerSnap[], seatId: number): PlayerSnap[] {
  return players.map((p) =>
    p.id === seatId
      ? p
      : {
          id: p.id,
          kind: p.kind,
          alive: p.alive,
          stock: {},
          // A rival's head count is their army size and their build plan in
          // one number — exactly what scouting is meant to cost.
          pop: 0,
          popCap: 0,
          techs: {
            researched: [],
            festivalTicksLeft: 0,
            pavingUnlocked: false,
            hasAbbey: false,
          },
        },
  );
}

/** Raid warnings and damage are addressed; eliminations and the result are
 * public. Damage stays private so fights don't leak through rivals' fog. */
function eventsFor(events: GameEvent[], seatId: number): GameEvent[] {
  return events.filter((e) =>
    (e.kind === 'raidIncoming' || e.kind === 'damage') ? e.player === seatId : true,
  );
}

/** Every live building snapped once, shared by all seats in a pump — the
 * frames serialize the snaps immediately and nothing mutates them, so per
 * seat there is nothing left to build. */
function snapLiveBuildings(world: World): Map<EntityId, BuildingSnap> {
  const out = new Map<EntityId, BuildingSnap>();
  for (const b of world.buildings.values()) {
    if (!b.dead) out.set(b.id, snapBuilding(world, b));
  }
  return out;
}

/** Buildings this seat may see: its own and currently-observed ones live,
 * previously-seen ones frozen as they were left. */
function buildingsFor(
  world: World,
  seatId: number,
  view: SeatView,
  snaps: Map<EntityId, BuildingSnap>,
): BuildingSnap[] {
  const out: BuildingSnap[] = [];
  const shown = new Set<EntityId>();
  // The fallen see everything: an eliminated seat can act on nothing, so
  // there is nothing left to hide — and spectating a black map is no
  // consolation prize.
  const spectator = world.players[seatId]?.alive === false;
  for (const b of world.buildings.values()) {
    if (b.dead) continue;
    const own = b.owner === seatId;
    if (own || spectator || view.vision.canSee(b.x + b.w / 2, b.y + b.h / 2)) {
      const snap = snaps.get(b.id)!;
      if (!own) view.lastSeen.set(b.id, snap);
      out.push(snap);
      shown.add(b.id);
    }
  }
  // Remembered buildings: still standing but unobserved, or destroyed while
  // we were not watching. Either way the memory holds until we look again.
  for (const [id, snap] of view.lastSeen) {
    if (shown.has(id)) continue;
    const live = world.buildings.get(id);
    const centerX = snap.x + snap.w / 2;
    const centerY = snap.y + snap.h / 2;
    if (view.vision.canSee(centerX, centerY)) {
      // We are looking right at it and the world says it is gone.
      if (!live || live.dead) view.lastSeen.delete(id);
      continue;
    }
    if (view.vision.hasExplored(centerX, centerY)) out.push(snap);
  }
  return out;
}

export function sendInit(room: Room, seat: Seat): void {
  const world = room.world;
  const view = seat.view;
  if (!world || !view) return;
  // The frame carries the whole permitted map, so anything owed is moot —
  // explored ground is current as of this tick, unexplored ground has
  // never been sent and owes its first reveal.
  view.owedTiles.clear();
  for (let i = 0; i < tileCount(world.map.size); i++) {
    view.tileSentTick[i] = view.vision.explored[i] ? world.tick + 1 : 0;
  }
  // The rosters ride the init frame itself, so the next struct frame must
  // compare against nothing and resend whatever has news.
  view.lastBuildingsBody = '';
  view.lastPlayersBody = '';
  view.lastMiscBody = '';
  send(
    seat,
    encodeInit(world.tick, seat.playerId, initialMap(world, view), view.vision.explored, {
      buildings: buildingsFor(world, seat.playerId, view, snapLiveBuildings(world)),
      players: redactPlayers(snapPlayers(world), seat.playerId),
      admin: { ...world.admin },
      outcome: world.outcome,
      seats: room.seats.map((s) => ({ kind: s.kind })),
    }),
  );
}

/** The 20 Hz frame, built per seat: our own units, plus whoever is lit. */
export function sendHot(room: Room): void {
  const world = room.world;
  if (!world) return;
  // Nobody on the line, nothing to snapshot. Rooms restored after a deploy
  // simulate with every seat disconnected for up to five minutes before the
  // sweep — snapping every unit at 20 Hz for them was pure waste. Hidden
  // seats count as off the line too: a backgrounded phone told us not to
  // spend its radio on frames nobody is watching.
  if (!room.seats.some((s) => s.view && s.connected && s.ws && !s.hidden)) return;
  const all: UnitSnapshot[] = [...unitSnapshots(world)];
  for (const seat of room.seats) {
    const view = seat.view;
    if (!view || !seat.connected || !seat.ws || seat.hidden) continue;
    const spectator = world.players[seat.playerId]?.alive === false;
    const mine: UnitSnapshot[] = [];
    for (const u of all) {
      if (spectator || u.owner === seat.playerId || view.vision.canSee(u.x, u.y)) mine.push(u);
    }
    send(seat, encodeHot(world.tick, mine), true);
  }
}

export function sendStruct(room: Room, deltas: MapDelta[], events: GameEvent[]): void {
  const world = room.world;
  if (!world) return;
  // Lazy, and shared: seats only take struct frames every few ticks, and
  // when they do, the players (a building scan per player) and the building
  // snaps are built once for the whole room, not once per seat.
  let players: PlayerSnap[] | undefined;
  let snaps: Map<EntityId, BuildingSnap> | undefined;
  for (const seat of room.seats) {
    const view = seat.view;
    if (!view) continue;
    if (!seat.connected || !seat.ws || seat.hidden) {
      // Nothing to hold: a reconnect — and an unhide, which works the same
      // way — is answered with a fresh init frame carrying the whole map,
      // so a growing backlog would be waste.
      view.owedTiles.clear();
      view.owedEvents.length = 0;
      continue;
    }
    // Changes on ground we can see, plus ground we just walked into.
    // Spectators (eliminated seats) are owed everything.
    const spectator = world.players[seat.playerId]?.alive === false;
    for (const d of deltas) {
      if (spectator || view.vision.visible[d.idx]) view.owedTiles.add(d.idx);
    }
    view.owedEvents.push(...eventsFor(events, seat.playerId));

    const due = world.tick - view.lastStructTick >= MIN_STRUCT_GAP;
    if (!due && view.owedTiles.size === 0 && view.owedEvents.length === 0) continue;
    players ??= snapPlayers(world);
    snaps ??= snapLiveBuildings(world);
    view.lastStructTick = world.tick;
    const mapDeltas: MapDelta[] = [];
    for (const idx of view.owedTiles) {
      mapDeltas.push(tileDelta(world, idx));
      view.tileSentTick[idx] = world.tick + 1;
    }
    view.owedTiles.clear();
    const owedEvents = view.owedEvents.splice(0);
    // Each roster ships only when it differs from what this seat already
    // has: a frame carrying two tiles of trail wear used to drag the whole
    // building list and every player block along at 4 Hz, which was most
    // of the room's bandwidth. The frame is assembled from the compared
    // strings directly, so nothing is stringified twice.
    const buildingsBody = JSON.stringify(buildingsFor(world, seat.playerId, view, snaps));
    const playersBody = JSON.stringify(redactPlayers(players, seat.playerId));
    const miscBody = JSON.stringify([world.admin, world.outcome]);
    const buildingsChanged = buildingsBody !== view.lastBuildingsBody;
    const playersChanged = playersBody !== view.lastPlayersBody;
    const miscChanged = miscBody !== view.lastMiscBody;
    // Debug-overlay rows only while this seat's overlay is open (the
    // {t:'debug'} lobby message) — every job at 4 Hz for an overlay nobody
    // has open was the heaviest line in the frame. Open, it counts as news
    // every interval: watching the ages tick is the point of the overlay.
    const jobs = seat.wantsJobs ? snapJobs(world, seat.playerId) : undefined;
    if (
      mapDeltas.length === 0 &&
      owedEvents.length === 0 &&
      !buildingsChanged &&
      !playersChanged &&
      !miscChanged &&
      jobs === undefined
    ) {
      continue; // a quiet interval — the seat already knows all of this
    }
    view.lastBuildingsBody = buildingsBody;
    view.lastPlayersBody = playersBody;
    view.lastMiscBody = miscBody;
    let body =
      `{"mapDeltas":${JSON.stringify(mapDeltas)}` +
      `,"admin":${JSON.stringify(world.admin)}` +
      `,"events":${JSON.stringify(owedEvents)}` +
      `,"outcome":${JSON.stringify(world.outcome)}` +
      `,"invariantViolations":[]`;
    if (buildingsChanged) body += `,"buildings":${buildingsBody}`;
    if (playersChanged) body += `,"players":${playersBody}`;
    if (jobs) body += `,"jobs":${JSON.stringify(jobs)}`;
    body += '}';
    send(seat, encodeStructBody(world.tick, body));
  }
}
