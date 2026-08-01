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
import { encodeHot, encodeInit, encodeStruct } from '../../src/protocol/state.ts';
import { snapBuilding, snapJobs, snapPlayers, unitSnapshots } from '../../src/protocol/snapshot.ts';
import { TILE_COUNT } from '../../src/shared/grid.ts';
import { Terrain, resourceBlocks } from '../../src/sim/map.ts';
import { SeatVision } from '../../src/sim/visibility.ts';
import type { UnitSnapshot } from '../../src/protocol/sabLayout.ts';
import type { BuildingSnap, PlayerSnap } from '../../src/protocol/messages.ts';
import type { EntityId } from '../../src/sim/entities.ts';
import type { GameEvent, MapDelta, World } from '../../src/sim/world.ts';
import type { Room, Seat } from './rooms.ts';

/** Ticks between structural frames when nothing else forces one. */
const MIN_STRUCT_GAP = 5;

/** Per-seat filtering state. */
export class SeatView {
  readonly vision = new SeatVision();
  /** Enemy buildings as this seat last saw them, by id. */
  readonly lastSeen = new Map<EntityId, BuildingSnap>();
  /** Map news owed to this seat, held until the next structural frame. */
  readonly owedTiles = new Set<number>();
  /** Events owed likewise. They are drained from the world once per pump,
   * so a seat that is between structural frames has to keep its own copy
   * or the raid warning is simply lost. */
  readonly owedEvents: GameEvent[] = [];
  lastStructTick = -1;
}

function send(seat: Seat, frame: Uint8Array): void {
  if (seat.connected && seat.ws) seat.ws.send(frame);
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
    // built on while we were not looking would stay wrong forever.
    for (const idx of seat.view.vision.revealed) seat.view.owedTiles.add(idx);
  }
}

/**
 * The map as this seat is allowed to know it at match start.
 *
 * Terrain, height and the natural resource layout go out whole: that is the
 * shape of the world, hiding it would mean streaming terrain geometry, and
 * the map reads as an empty void without it. Start positions come from a
 * fixed table anyone can read in the source.
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
function initialMap(world: World, view: SeatView): {
  terrain: Uint8Array;
  resource: Uint8Array;
  blocked: Uint8Array;
  pathLevel: Uint8Array;
  buildingAt: Int16Array;
  height: Float32Array;
} {
  const buildingAt = new Int16Array(TILE_COUNT).fill(-1);
  const pathLevel = new Uint8Array(TILE_COUNT);
  const blocked = new Uint8Array(TILE_COUNT);
  for (let i = 0; i < TILE_COUNT; i++) {
    if (view.vision.explored[i]) {
      buildingAt[i] = world.map.buildingAt[i]!;
      pathLevel[i] = world.map.pathLevel[i]!;
      blocked[i] = world.map.blocked[i]!;
    } else {
      blocked[i] =
        world.map.terrain[i] === Terrain.Water || resourceBlocks(world.map.resource[i]!) ? 1 : 0;
    }
  }
  return {
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
          techs: {
            researched: [],
            festivalTicksLeft: 0,
            pavingUnlocked: false,
            hasTerakoya: false,
          },
        },
  );
}

/** Raid warnings are addressed; eliminations and the result are public. */
function eventsFor(events: GameEvent[], seatId: number): GameEvent[] {
  return events.filter((e) => e.kind !== 'raidIncoming' || e.player === seatId);
}

/** Buildings this seat may see: its own and currently-observed ones live,
 * previously-seen ones frozen as they were left. */
function buildingsFor(world: World, seatId: number, view: SeatView): BuildingSnap[] {
  const out: BuildingSnap[] = [];
  const shown = new Set<EntityId>();
  for (const b of world.buildings.values()) {
    if (b.dead) continue;
    const own = b.owner === seatId;
    if (own || view.vision.canSee(b.x + b.w / 2, b.y + b.h / 2)) {
      const snap = snapBuilding(world, b);
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
  // The frame carries the whole permitted map, so anything owed is moot.
  view.owedTiles.clear();
  send(
    seat,
    encodeInit(world.tick, seat.playerId, initialMap(world, view), view.vision.explored, {
      buildings: buildingsFor(world, seat.playerId, view),
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
  const all: UnitSnapshot[] = [...unitSnapshots(world)];
  for (const seat of room.seats) {
    const view = seat.view;
    if (!view || !seat.connected || !seat.ws) continue;
    const mine: UnitSnapshot[] = [];
    for (const u of all) {
      if (u.owner === seat.playerId || view.vision.canSee(u.x, u.y)) mine.push(u);
    }
    send(seat, encodeHot(world.tick, mine));
  }
}

export function sendStruct(room: Room, deltas: MapDelta[], events: GameEvent[]): void {
  const world = room.world;
  if (!world) return;
  const players = snapPlayers(world);
  for (const seat of room.seats) {
    const view = seat.view;
    if (!view) continue;
    if (!seat.connected || !seat.ws) {
      // Nothing to hold: a reconnect is answered with a fresh init frame
      // carrying the whole map, so a growing backlog would be waste.
      view.owedTiles.clear();
      view.owedEvents.length = 0;
      continue;
    }
    // Changes on ground we can see, plus ground we just walked into.
    for (const d of deltas) {
      if (view.vision.visible[d.idx]) view.owedTiles.add(d.idx);
    }
    view.owedEvents.push(...eventsFor(events, seat.playerId));

    const due = world.tick - view.lastStructTick >= MIN_STRUCT_GAP;
    if (!due && view.owedTiles.size === 0 && view.owedEvents.length === 0) continue;
    view.lastStructTick = world.tick;
    const mapDeltas: MapDelta[] = [];
    for (const idx of view.owedTiles) mapDeltas.push(tileDelta(world, idx));
    view.owedTiles.clear();
    send(
      seat,
      encodeStruct(world.tick, {
        buildings: buildingsFor(world, seat.playerId, view),
        mapDeltas,
        players: redactPlayers(players, seat.playerId),
        admin: { ...world.admin },
        events: view.owedEvents.splice(0),
        outcome: world.outcome,
        jobs: snapJobs(world, seat.playerId),
        invariantViolations: [],
      }),
    );
  }
}
