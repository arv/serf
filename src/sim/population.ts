import * as BuildingState from './buildingStateEnum.ts';
import {buildingDef} from './defs/buildings.ts';
import type {Owner} from './entities.ts';
import type {World} from './world.ts';

/**
 * Population and its ceiling.
 *
 * Population is *people*, not serfs: a serf who takes a post at the well is
 * still one of yours, and so is the knight the barracks made out of him.
 * Counting only the idle pool would make the cap something you could dodge
 * by putting everyone to work, and would make training soldiers free.
 *
 * The ceiling is beds. The castle brings ten, every house another ten, and
 * only a finished roof counts — a house under construction houses nobody,
 * which is what stops the cap from being raised by placing a site you never
 * pay for.
 *
 * Both are derived from the world rather than stored on it: nothing to keep
 * in step across save/load, rollback or a rebuilt unit map, and nothing new
 * for the determinism hash to disagree about. The cost is a scan, so the
 * per-tick caller (the hire gate) is the only one that runs it hot — the
 * snapshot and the AI brain both already walk these collections anyway.
 */

/** Living people this seat owns: serfs, resident workers and soldiers —
 * including the ones a tower has swallowed. A garrisoned archer is not a
 * unit on the map any more (staffing.ts consumes him the way the barracks
 * consumes a recruit), so he has to be counted from the building or manning
 * a tower would quietly free the bed he sleeps in. */
export function populationOf(world: World, owner: Owner): number {
  let n = 0;
  for (const u of world.units.values()) {
    if (!u.dead && u.owner === owner) n++;
  }
  for (const b of world.buildings.values()) {
    if (!b.dead && b.owner === owner) n += b.garrison ?? 0;
  }
  return n;
}

/** Beds this seat has standing. Sites do not count. */
export function popCapOf(world: World, owner: Owner): number {
  let cap = 0;
  for (const b of world.buildings.values()) {
    if (b.dead || b.state !== BuildingState.built || b.owner !== owner)
      continue;
    cap += buildingDef(b.type).housing ?? 0;
  }
  return cap;
}

/**
 * Beds the seat has standing *or* has broken ground on — what a builder
 * should plan against, so it doesn't order five houses while the first one
 * is still a frame.
 */
export function plannedPopCapOf(world: World, owner: Owner): number {
  let cap = 0;
  for (const b of world.buildings.values()) {
    if (b.dead || b.owner !== owner) continue;
    cap += buildingDef(b.type).housing ?? 0;
  }
  return cap;
}

/** Hires already paid for and walking in, across all of this seat's queues. */
export function pendingHiresOf(world: World, owner: Owner): number {
  let n = 0;
  for (const b of world.buildings.values()) {
    if (b.dead || b.owner !== owner) continue;
    n += b.hireQueue ?? 0;
  }
  return n;
}

/** Is there a bed for one more? Recruits already on the road hold theirs. */
export function hasRoomToHire(world: World, owner: Owner): boolean {
  return (
    populationOf(world, owner) + pendingHiresOf(world, owner) <
    popCapOf(world, owner)
  );
}
