import { TILE_COUNT } from '../shared/grid.ts';
import type { GameMap } from './map.ts';
import type { PlayerState } from './player.ts';
import type { MatchOutcome, World } from './world.ts';

/**
 * Save/load. The World is serializable by construction (plain records, ID
 * links, typed arrays), so this is mechanical: Maps become entry arrays,
 * typed arrays become plain arrays. Derived caches don't exist to rebuild —
 * `blocked` is part of the map state and round-trips as data.
 *
 * Version 3 renamed every sim id (goods, buildings, units, techs) to its
 * medieval form. Older saves store the old id strings, so they are refused
 * rather than silently mis-loaded.
 */

interface SaveFile {
  version: 3;
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
    players: PlayerState[];
    raidState: World['raidState'];
    admin?: World['admin'];
    outcome: MatchOutcome;
  };
}

export function serializeWorld(world: World): string {
  const file: SaveFile = {
    version: 3,
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
      players: world.players,
      raidState: world.raidState,
      admin: world.admin,
      outcome: world.outcome,
    },
  };
  return JSON.stringify(file);
}

export function deserializeWorld(json: string): World {
  const file = JSON.parse(json) as SaveFile;
  if (file.version !== 3) {
    throw new Error('save is from an older version of the game');
  }
  const w = file.world;

  const map: GameMap = {
    terrain: Uint8Array.from(w.map.terrain),
    resource: Uint8Array.from(w.map.resource),
    resourceAmt: Uint8Array.from(w.map.resourceAmt),
    blocked: Uint8Array.from(w.map.blocked),
    buildingAt: Int16Array.from(w.map.buildingAt),
    wear: Float32Array.from(w.map.wear),
    pathLevel: Uint8Array.from(w.map.pathLevel),
    height: Float32Array.from(w.map.height),
  };
  if (map.terrain.length !== TILE_COUNT) throw new Error('corrupt save: bad map size');

  return {
    banditsEnabled: (w as { banditsEnabled?: boolean }).banditsEnabled ?? true,
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
    players: w.players,
    raidState: w.raidState,
    admin: w.admin ?? { enabled: true, raidsEnabled: true, instantBuild: false },
    pendingEvents: [],
    outcome: w.outcome,
  };
}
