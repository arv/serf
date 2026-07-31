/**
 * Turning the authoritative world into per-client frames.
 *
 * Right now every seat gets the same picture — this phase only moves the
 * simulation, it does not yet hide anything. Per-player visibility filtering
 * lands here next, which is why frame construction lives in its own module
 * rather than inside the room's tick loop.
 *
 * One rule already matters: `pendingDeltas` and `pendingEvents` on the world
 * are drain-once outboxes, so they are emptied a single time per broadcast
 * and the result is fanned out. Draining per seat would hand seat 0 the map
 * deltas and leave everyone else with a stale mirror.
 */
import { encodeHot, encodeInit, encodeStruct } from '../../src/protocol/state.ts';
import {
  snapBuildings,
  snapJobs,
  snapPlayers,
  unitSnapshots,
} from '../../src/protocol/snapshot.ts';
import type { World } from '../../src/sim/world.ts';
import type { Room, Seat } from './rooms.ts';

function send(seat: Seat, frame: Uint8Array): void {
  if (seat.connected && seat.ws) seat.ws.send(frame);
}

/** Everything a client needs to stand up its mirror: the immutable map plus
 * the current roster. Sent on match start and again on rejoin. */
export function sendInit(room: Room, seat: Seat): void {
  const world = room.world;
  if (!world) return;
  send(
    seat,
    encodeInit(
      world.tick,
      seat.playerId,
      {
        terrain: world.map.terrain,
        resource: world.map.resource,
        blocked: world.map.blocked,
        pathLevel: world.map.pathLevel,
        buildingAt: world.map.buildingAt,
        height: world.map.height,
      },
      {
        buildings: snapBuildings(world),
        players: snapPlayers(world),
        admin: { ...world.admin },
        outcome: world.outcome,
        seats: room.seats.map((s) => ({ kind: s.kind })),
      },
    ),
  );
}

/** The 20 Hz frame. Built once and fanned out while every seat sees the
 * same units; per-seat construction arrives with visibility filtering. */
export function sendHot(room: Room): void {
  const world = room.world;
  if (!world) return;
  const frame = encodeHot(world.tick, unitSnapshots(world));
  for (const seat of room.seats) send(seat, frame);
}

export function sendStruct(room: Room): void {
  const world = room.world;
  if (!world) return;
  // Drain once, fan out — see the note at the top of this file.
  const mapDeltas = world.pendingDeltas.splice(0);
  const events = world.pendingEvents.splice(0);
  const buildings = snapBuildings(world);
  const players = snapPlayers(world);
  const admin = { ...world.admin };
  for (const seat of room.seats) {
    if (!seat.connected || !seat.ws) continue;
    send(
      seat,
      encodeStruct(world.tick, {
        buildings,
        mapDeltas,
        players,
        admin,
        events,
        outcome: world.outcome,
        // A player's own hauls only. The debug overlay carries no owner on
        // the wire, so unfiltered it hands over a rival's production chain.
        jobs: snapJobs(world, seat.playerId),
        invariantViolations: [],
      }),
    );
  }
}

/** True when the world has news worth a structural frame this tick. */
export function structuralDue(world: World, lastSentTick: number, everyTicks: number): boolean {
  return world.tick - lastSentTick >= everyTicks || world.pendingDeltas.length > 0;
}
