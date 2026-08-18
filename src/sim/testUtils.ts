import { DEFAULT_MAP_SIZE, tileCount, tileIdx } from '../shared/grid.ts';
import { placeBuiltBuilding, placeSite, spawnUnit, type World } from './world.ts';
import { makePlayer } from './player.ts';
import { bindWorker } from './systems/production.ts';
import { TileResource, resourceBlocks, type TileResourceKind } from './map.ts';
import type { SimCommand } from './commands.ts';
import type { PlayerCommand } from './tick.ts';
import type { GameMap } from './map.ts';
import type { GoodAmounts } from './defs/goods.ts';
import type { Building, Owner } from './entities.ts';
import type { Unit } from './units.ts';

/** An all-grass, empty 64x64 map for deterministic logistics tests. */
export function bareMap(size = DEFAULT_MAP_SIZE): GameMap {
  const tiles = tileCount(size);
  return {
    size,
    play: size, // fully playable: logistics tests want a bare, margin-less field
    terrain: new Uint8Array(tiles),
    resource: new Uint8Array(tiles),
    resourceAmt: new Uint8Array(tiles),
    blocked: new Uint8Array(tiles),
    buildingAt: new Int16Array(tiles).fill(-1),
    wear: new Float32Array(tiles),
    pathLevel: new Uint8Array(tiles),
    height: new Float32Array(tiles),
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

/** Stand a workable resource on a tile. Gatherers may only be placed within
 * reach of one, so most hut fixtures need something to chop. */
export function addResourceTile(
  world: World,
  x: number,
  y: number,
  res: TileResourceKind = TileResource.Wood,
  amt = 6,
): void {
  const i = tileIdx(x, y, world.map.size);
  world.map.resource[i] = res;
  world.map.resourceAmt[i] = amt;
  if (resourceBlocks(res)) world.map.blocked[i] = 1;
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
