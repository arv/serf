import { MAX_MAP_SIZE, MIN_MAP_SIZE, tileCount } from '../shared/grid.ts';
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
 * medieval form. Version 4 made the grid size per-game data (and grew the
 * default world), so a v3 save's arrays no longer describe any world this
 * build can generate. Older saves are refused rather than silently
 * mis-loaded.
 */

interface SaveFile {
  version: 4;
  world: {
    /** Absent in saves from before the toggle existed; those ran bandits. */
    banditsEnabled?: boolean;
    tick: number;
    rngState: number;
    nextId: number;
    nextJobId: number;
    mapSize: number;
    map: Record<Exclude<keyof GameMap, 'size'>, number[]>;
    units: unknown[];
    buildings: unknown[];
    jobs: unknown[];
    ledger: World['ledger'];
    players: PlayerState[];
    raidState: World['raidState'];
    admin?: World['admin'];
    outcome: MatchOutcome;
    /** Campaign mission fields; absent on sandbox/skirmish saves (the
     * banditsEnabled precedent — optional, no version bump). */
    missionId?: World['missionId'];
    objectivesDone?: boolean[];
  };
}

export function serializeWorld(world: World): string {
  const file: SaveFile = {
    version: 4,
    world: {
      banditsEnabled: world.banditsEnabled,
      tick: world.tick,
      rngState: world.rngState,
      nextId: world.nextId,
      nextJobId: world.nextJobId,
      mapSize: world.map.size,
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
      ...(world.missionId !== undefined
        ? { missionId: world.missionId, objectivesDone: world.objectivesDone }
        : {}),
    },
  };
  return JSON.stringify(file);
}

export function deserializeWorld(json: string): World {
  const file = JSON.parse(json) as SaveFile;
  if (file.version !== 4) {
    throw new Error('save is from an older version of the game');
  }
  const w = file.world;

  const map: GameMap = {
    size: w.mapSize,
    terrain: Uint8Array.from(w.map.terrain),
    resource: Uint8Array.from(w.map.resource),
    resourceAmt: Uint8Array.from(w.map.resourceAmt),
    blocked: Uint8Array.from(w.map.blocked),
    buildingAt: Int16Array.from(w.map.buildingAt),
    wear: Float32Array.from(w.map.wear),
    pathLevel: Uint8Array.from(w.map.pathLevel),
    height: Float32Array.from(w.map.height),
  };
  if (
    !Number.isInteger(map.size) ||
    map.size < MIN_MAP_SIZE ||
    map.size > MAX_MAP_SIZE ||
    map.terrain.length !== tileCount(map.size)
  ) {
    throw new Error('corrupt save: bad map size');
  }

  return {
    banditsEnabled: w.banditsEnabled ?? true,
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
    ...(w.missionId !== undefined
      ? { missionId: w.missionId, objectivesDone: w.objectivesDone ?? [] }
      : {}),
  };
}
