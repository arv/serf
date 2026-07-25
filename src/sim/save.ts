import { TILE_COUNT } from '../shared/grid';
import type { GameMap } from './map';
import type { World } from './world';

/**
 * Save/load. The World is serializable by construction (plain records, ID
 * links, typed arrays), so this is mechanical: Maps become entry arrays,
 * typed arrays become plain arrays. Derived caches don't exist to rebuild —
 * `blocked` is part of the map state and round-trips as data.
 */

interface SaveFile {
  version: 1;
  world: {
    tick: number;
    rngState: number;
    nextId: number;
    nextJobId: number;
    map: Record<keyof GameMap, number[]>;
    units: unknown[];
    buildings: unknown[];
    jobs: unknown[];
    ledger: World['ledger'];
    pavingUnlocked: boolean;
    techs: World['techs'];
    raidState: World['raidState'];
    admin?: World['admin'];
    outcome: World['outcome'];
  };
}

export function serializeWorld(world: World): string {
  const file: SaveFile = {
    version: 1,
    world: {
      tick: world.tick,
      rngState: world.rngState,
      nextId: world.nextId,
      nextJobId: world.nextJobId,
      map: {
        terrain: [...world.map.terrain],
        resource: [...world.map.resource],
        resourceAmt: [...world.map.resourceAmt],
        blocked: [...world.map.blocked],
        buildingAt: [...world.map.buildingAt],
        wear: [...world.map.wear],
        pathLevel: [...world.map.pathLevel],
        height: [...world.map.height],
      },
      units: [...world.units.values()],
      buildings: [...world.buildings.values()],
      jobs: [...world.jobs.values()],
      ledger: world.ledger,
      pavingUnlocked: world.pavingUnlocked,
      techs: world.techs,
      raidState: world.raidState,
      admin: world.admin,
      outcome: world.outcome,
    },
  };
  return JSON.stringify(file);
}

export function deserializeWorld(json: string): World {
  const file = JSON.parse(json) as SaveFile;
  if (file.version !== 1) throw new Error(`unknown save version ${String(file.version)}`);
  const w = file.world;

  const map: GameMap = {
    terrain: Uint8Array.from(w.map.terrain),
    resource: Uint8Array.from(w.map.resource),
    resourceAmt: Uint8Array.from(w.map.resourceAmt),
    blocked: Uint8Array.from(w.map.blocked),
    buildingAt: Int16Array.from(w.map.buildingAt),
    wear: Float32Array.from(w.map.wear),
    pathLevel: Uint8Array.from(w.map.pathLevel),
    // Saves from before elevation existed load as a flat valley.
    height: w.map.height ? Float32Array.from(w.map.height) : new Float32Array(TILE_COUNT),
  };
  if (map.terrain.length !== TILE_COUNT) throw new Error('corrupt save: bad map size');

  const world: World = {
    tick: w.tick,
    rngState: w.rngState,
    nextId: w.nextId,
    nextJobId: w.nextJobId,
    map,
    units: new Map((w.units as { id: number }[]).map((u) => [u.id, u])) as World['units'],
    buildings: new Map(
      (w.buildings as { id: number }[]).map((b) => [b.id, b]),
    ) as World['buildings'],
    jobs: new Map((w.jobs as { id: number }[]).map((j) => [j.id, j])) as World['jobs'],
    ledger: w.ledger,
    pendingDeltas: [],
    pavingUnlocked: w.pavingUnlocked,
    techs: w.techs,
    raidState: w.raidState,
    admin: w.admin ?? { raidsEnabled: true, instantBuild: false },
    pendingEvents: [],
    outcome: w.outcome,
  };
  return world;
}
