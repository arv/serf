import { TILE_COUNT } from '../shared/grid.ts';
import { placeBuiltBuilding, placeSite, spawnUnit, type World } from './world.ts';
import { makePlayer } from './player.ts';
import { bindWorker } from './systems/production.ts';
import type { SimCommand } from './commands.ts';
import type { PlayerCommand } from './tick.ts';
import type { GameMap } from './map.ts';
import type { GoodAmounts } from './defs/goods.ts';
import type { Building, Owner } from './entities.ts';
import type { Unit } from './units.ts';

/** An all-grass, empty 64x64 map for deterministic logistics tests. */
export function bareMap(): GameMap {
  return {
    terrain: new Uint8Array(TILE_COUNT),
    resource: new Uint8Array(TILE_COUNT),
    resourceAmt: new Uint8Array(TILE_COUNT),
    blocked: new Uint8Array(TILE_COUNT),
    buildingAt: new Int16Array(TILE_COUNT).fill(-1),
    wear: new Float32Array(TILE_COUNT),
    pathLevel: new Uint8Array(TILE_COUNT),
    height: new Float32Array(TILE_COUNT),
  };
}

export function bareWorld(seed = 1, playerCount = 1): World {
  return {
    tick: 0,
    rngState: seed,
    nextId: 1,
    map: bareMap(),
    units: new Map(),
    buildings: new Map(),
    jobs: new Map(),
    nextJobId: 1,
    ledger: { produced: {}, consumed: {} },
    pendingDeltas: [],
    players: Array.from({ length: playerCount }, (_, i) => makePlayer(i, 'human')),
    raidState: { nextRaidTick: Number.MAX_SAFE_INTEGER, wave: 0 }, // raids opt in
    admin: { enabled: true, raidsEnabled: true, instantBuild: false },
    pendingEvents: [],
    outcome: { state: 'playing' },
    banditsEnabled: true,
  };
}

/** Wrap bare SimCommands as player-0 envelopes (the common test case). */
export function cmds(...commands: SimCommand[]): PlayerCommand[] {
  return commands.map((cmd) => ({ playerId: 0, cmd }));
}

export function addStorehouse(
  world: World,
  x: number,
  y: number,
  stock: GoodAmounts,
  owner: Owner = 0,
): Building {
  const b = placeBuiltBuilding(world, 'storehouse', owner, x, y);
  b.stock = { ...stock };
  return b;
}

export function addBuiltHut(
  world: World,
  x: number,
  y: number,
  withWorker = true,
  owner: Owner = 0,
): Building {
  const b = placeBuiltBuilding(world, 'woodcutter', owner, x, y);
  if (withWorker) {
    const worker = spawnUnit(world, 'worker', owner, x + 0.5, y + b.h + 0.5);
    bindWorker(b, worker);
  }
  return b;
}

export function addSite(world: World, x: number, y: number, owner: Owner = 0): Building {
  return placeSite(world, 'woodcutter', owner, x, y);
}

export function addSerf(world: World, x: number, y: number, owner: Owner = 0): Unit {
  return spawnUnit(world, 'serf', owner, x + 0.5, y + 0.5);
}

/** Staff a building directly (tests that don't exercise recruitment). */
export function staffBuilding(world: World, b: Building): Unit {
  const worker = spawnUnit(world, 'worker', b.owner, b.x + b.w / 2, b.y + b.h + 0.5);
  bindWorker(b, worker);
  return worker;
}
