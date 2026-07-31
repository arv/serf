import { TILE_COUNT } from '../shared/grid.ts';
import { BANDIT } from './entities.ts';
import type { GameMap } from './map.ts';
import type { PlayerState } from './player.ts';
import type { MatchOutcome, World } from './world.ts';

/**
 * Save/load. The World is serializable by construction (plain records, ID
 * links, typed arrays), so this is mechanical: Maps become entry arrays,
 * typed arrays become plain arrays. Derived caches don't exist to rebuild —
 * `blocked` is part of the map state and round-trips as data.
 */

interface SaveFile {
  version: 1 | 2;
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
    // --- version 1 fields (migrated into players[0] on load) ---
    pavingUnlocked?: boolean;
    techs?: PlayerState['techs'];
  };
}

export function serializeWorld(world: World): string {
  const file: SaveFile = {
    version: 2,
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
  if (file.version !== 1 && file.version !== 2) {
    throw new Error(`unknown save version ${String(file.version)}`);
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
    players:
      file.version === 2
        ? w.players
        : [
            // v1 saves were solo: wrap the old global tech state as player 0.
            {
              id: 0,
              kind: 'human',
              techs: w.techs ?? { researched: [], festivalTicksLeft: 0 },
              pavingUnlocked: w.pavingUnlocked ?? false,
              alive: (w.outcome as unknown as string) !== 'lost',
            },
          ],
    raidState: w.raidState,
    admin:
      file.version === 2 && w.admin
        ? w.admin
        : { enabled: true, raidsEnabled: true, instantBuild: false, ...(w.admin ?? {}) },
    pendingEvents: [],
    outcome:
      file.version === 2
        ? w.outcome
        : migrateOutcomeV1(w.outcome as unknown as 'playing' | 'won' | 'lost'),
  };
  if (file.version === 1) migrateV1(world);
  return world;
}

function migrateOutcomeV1(outcome: 'playing' | 'won' | 'lost'): MatchOutcome {
  if (outcome === 'playing') return { state: 'playing' };
  return { state: 'over', winner: outcome === 'won' ? 0 : null };
}

/** v1 entities carried string owners; jobs had no owner. */
function migrateV1(world: World): void {
  const owner = (o: unknown): number => (o === 'bandit' ? BANDIT : o === 'player' ? 0 : (o as number));
  for (const u of world.units.values()) u.owner = owner(u.owner);
  for (const b of world.buildings.values()) b.owner = owner(b.owner);
  for (const j of world.jobs.values()) j.owner ??= 0;
}
