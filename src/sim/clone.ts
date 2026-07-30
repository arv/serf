import type { World } from './world';
import type { Building } from './entities';
import type { Unit } from './units';
import type { HaulJob } from './world';
import type { GoodAmounts } from './defs/goods';
import type { PlayerState } from './player';

/**
 * Deep-copy a World for rollback snapshots — the netcode's confirmed world
 * is cloned into a fresh predicted world on every misprediction. Hand-rolled
 * (structuredClone is 2-4x slower on the entity maps) and therefore brittle
 * against new fields: when World or its records grow, update THIS, save.ts,
 * and hash.ts together (clone.test.ts pins them to each other).
 *
 * `terrain` and `height` are shared by reference on purpose — they are
 * written only by worldgen (see map.ts) and never change mid-match.
 */
export function cloneWorld(world: World): World {
  const goods = (g: GoodAmounts): GoodAmounts => ({ ...g });
  const units = new Map<number, Unit>();
  for (const [id, u] of world.units) {
    units.set(id, { ...u, path: u.path ? [...u.path] : null, task: { ...u.task } });
  }
  const buildings = new Map<number, Building>();
  for (const [id, b] of world.buildings) {
    buildings.set(id, {
      ...b,
      stock: goods(b.stock),
      inputs: goods(b.inputs),
      inbound: goods(b.inbound),
      reservedOut: goods(b.reservedOut),
      demandSince: goods(b.demandSince),
      demandBackoff: b.demandBackoff ? goods(b.demandBackoff) : undefined,
      siteNeeds: b.siteNeeds ? goods(b.siteNeeds) : undefined,
      trainQueue: b.trainQueue?.map((q) => ({ ...q })),
    });
  }
  const jobs = new Map<number, HaulJob>();
  for (const [id, j] of world.jobs) jobs.set(id, { ...j });

  const players: PlayerState[] = world.players.map((p) => ({
    ...p,
    techs: {
      researched: [...p.techs.researched],
      active: p.techs.active ? { ...p.techs.active } : undefined,
      festivalTicksLeft: p.techs.festivalTicksLeft,
    },
    ai: p.ai ? { ...p.ai } : undefined,
  }));

  return {
    tick: world.tick,
    rngState: world.rngState,
    nextId: world.nextId,
    nextJobId: world.nextJobId,
    map: {
      terrain: world.map.terrain, // worldgen-only: shared
      height: world.map.height, // worldgen-only: shared
      resource: world.map.resource.slice(),
      resourceAmt: world.map.resourceAmt.slice(),
      blocked: world.map.blocked.slice(),
      buildingAt: world.map.buildingAt.slice(),
      wear: world.map.wear.slice(),
      pathLevel: world.map.pathLevel.slice(),
    },
    units,
    buildings,
    jobs,
    ledger: {
      produced: goods(world.ledger.produced),
      consumed: goods(world.ledger.consumed),
    },
    pendingDeltas: [],
    pendingEvents: [],
    players,
    raidState: { ...world.raidState },
    admin: { ...world.admin },
    outcome: { ...world.outcome },
  };
}
