import { TILE_COUNT } from '../shared/grid';
import { placeBuiltBuilding, placeSite, spawnUnit, type World } from './world';
import { bindWorker } from './systems/production';
import type { GameMap } from './map';
import type { GoodAmounts } from './defs/goods';
import type { Building } from './entities';
import type { Unit } from './units';

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

export function bareWorld(seed = 1): World {
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
    pavingUnlocked: false, // paving tests opt in explicitly
    techs: { researched: [], festivalTicksLeft: 0 },
    raidState: { nextRaidTick: Number.MAX_SAFE_INTEGER, wave: 0 }, // raids opt in
    admin: { raidsEnabled: true, instantBuild: false },
    pendingEvents: [],
    outcome: 'playing',
  };
}

export function addStorehouse(world: World, x: number, y: number, stock: GoodAmounts): Building {
  const b = placeBuiltBuilding(world, 'storehouse', 'player', x, y);
  b.stock = { ...stock };
  return b;
}

export function addBuiltHut(world: World, x: number, y: number, withWorker = true): Building {
  const b = placeBuiltBuilding(world, 'bambooHut', 'player', x, y);
  if (withWorker) {
    const worker = spawnUnit(world, 'worker', 'player', x + 0.5, y + b.h + 0.5);
    bindWorker(b, worker);
  }
  return b;
}

export function addSite(world: World, x: number, y: number): Building {
  return placeSite(world, 'bambooHut', 'player', x, y);
}

export function addSerf(world: World, x: number, y: number): Unit {
  return spawnUnit(world, 'serf', 'player', x + 0.5, y + 0.5);
}

/** Staff a building directly (tests that don't exercise recruitment). */
export function staffBuilding(world: World, b: Building): Unit {
  const worker = spawnUnit(world, 'worker', 'player', b.x + b.w / 2, b.y + b.h + 0.5);
  bindWorker(b, worker);
  return worker;
}
