import {
  bytesFromBase64,
  bytesToBase64,
  float32FromBase64,
  float32ToBase64,
  int16FromBase64,
  int16ToBase64,
} from '../shared/base64.ts';
import { MAX_MAP_SIZE, MIN_MAP_SIZE, gridFor, tileCount } from '../shared/grid.ts';
import type { GameMap } from './map.ts';
import type { PlayerState } from './player.ts';
import type { MatchOutcome, World } from './world.ts';
import { WORLD_SAVE_VERSION, canReadSave } from '../shared/saveVersion.ts';

/**
 * Save/load. The World is serializable by construction (plain records, ID
 * links, typed arrays), so this is mechanical: Maps become entry arrays,
 * and the map's tile grids become base64 (shared/base64.ts). Derived
 * caches don't exist to rebuild — `blocked` is part of the map state and
 * round-trips as data.
 *
 * The grids are base64 for the reason the map file's are (sim/mapFile.ts),
 * only more so: a save is its map — 99% of the bytes — and a float32
 * height printed as decimal digits costs seventeen of them. The eight
 * grids of a 192² world measured 1.27 MB spelled out and 0.62 MB packed,
 * which is every save file, the sessionStorage handoff the editor's Play
 * uses, the relay's room snapshot, and every replay that boots from a
 * save.
 *
 * What each version meant, and why an older one is refused rather than
 * silently mis-loaded, is with the number itself in
 * shared/saveVersion.ts.
 */

interface SaveFile {
  /** WORLD_SAVE_VERSION as of the write — or 4, which is still read. */
  version: number;
  world: {
    /** Absent in saves from before the toggle existed; those ran bandits. */
    banditsEnabled?: boolean;
    tick: number;
    rngState: number;
    nextId: number;
    nextJobId: number;
    mapSize: number;
    /** Playable side; absent in saves from before the margin existed —
     * those worlds were playable wall to wall. */
    mapPlay?: number;
    /** The tile grids: base64 in this format, plain number arrays in a
     * version 4 file (and `wear`, which is still written that way).
     * Either spelling reads. */
    map: Record<Exclude<keyof GameMap, 'size' | 'play'>, string | number[]>;
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
    version: WORLD_SAVE_VERSION,
    world: {
      banditsEnabled: world.banditsEnabled,
      tick: world.tick,
      rngState: world.rngState,
      nextId: world.nextId,
      nextJobId: world.nextJobId,
      mapSize: world.map.size,
      mapPlay: world.map.play,
      map: {
        terrain: bytesToBase64(world.map.terrain),
        resource: bytesToBase64(world.map.resource),
        resourceAmt: bytesToBase64(world.map.resourceAmt),
        blocked: bytesToBase64(world.map.blocked),
        buildingAt: int16ToBase64(world.map.buildingAt),
        // The one grid still spelled in digits, because measuring said so:
        // wear is a float per tile and nearly every tile is 0 (a couple of
        // hundred worn out of 36 864, an hour into a match). `0,` is two
        // characters where a float32 is five and a third of base64, so the
        // array stays smaller until about a twentieth of the map is worn.
        wear: [...world.map.wear],
        pathLevel: bytesToBase64(world.map.pathLevel),
        height: float32ToBase64(world.map.height),
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

/** A grid from either spelling — base64, or the number array a version 4
 * file (and `wear`) carries. */
function bytes(raw: string | number[]): Uint8Array {
  return typeof raw === 'string' ? bytesFromBase64(raw) : Uint8Array.from(raw);
}

function int16s(raw: string | number[]): Int16Array {
  return typeof raw === 'string' ? int16FromBase64(raw) : Int16Array.from(raw);
}

function float32s(raw: string | number[]): Float32Array {
  return typeof raw === 'string' ? float32FromBase64(raw) : Float32Array.from(raw);
}

export function deserializeWorld(json: string): World {
  const file = JSON.parse(json) as SaveFile;
  if (!canReadSave(file.version)) {
    throw new Error('save is from an older version of the game');
  }
  const w = file.world;

  let map: GameMap;
  try {
    map = {
      size: w.mapSize,
      play: w.mapPlay ?? w.mapSize,
      terrain: bytes(w.map.terrain),
      resource: bytes(w.map.resource),
      resourceAmt: bytes(w.map.resourceAmt),
      blocked: bytes(w.map.blocked),
      buildingAt: int16s(w.map.buildingAt),
      wear: float32s(w.map.wear),
      pathLevel: bytes(w.map.pathLevel),
      height: float32s(w.map.height),
    };
  } catch {
    // A grid that is not base64 at all; the size check below catches the
    // grid that decodes to the wrong number of tiles.
    throw new Error('corrupt save: unreadable map grids');
  }
  if (
    !Number.isInteger(map.size) ||
    !Number.isInteger(map.play) ||
    map.play < MIN_MAP_SIZE ||
    map.play > MAX_MAP_SIZE ||
    map.play % 2 !== 0 || // play sizes are even by contract (resolveMapSize)
    map.play > map.size ||
    (map.size - map.play) % 2 !== 0 ||
    map.size > gridFor(MAX_MAP_SIZE) ||
    // Every grid, not just terrain: a base64 one decodes to whatever
    // length it was given, and a short height array is a world of NaN.
    [
      map.terrain,
      map.resource,
      map.resourceAmt,
      map.blocked,
      map.buildingAt,
      map.wear,
      map.pathLevel,
      map.height,
    ].some((grid) => grid.length !== tileCount(map.size))
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
