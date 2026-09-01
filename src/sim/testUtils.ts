import {DEFAULT_MAP_SIZE, tileCount, tileIdx} from '../shared/grid.ts';
import type {SimCommand} from './commands.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as GoodId from './defs/goodIdEnum.ts';
import type {GoodAmounts} from './defs/goods.ts';
import * as UnitTypeId from './defs/unitTypeIdEnum.ts';
import type {Building, Owner} from './entities.ts';
import {resourceBlocks, type TileResourceKind, type GameMap} from './map.ts';
import * as MatchState from './matchStateEnum.ts';
import {makePlayer} from './player.ts';
import * as PlayerKind from './playerKindEnum.ts';
import {bindWorker} from './systems/production.ts';
import type {PlayerCommand} from './tick.ts';
import * as TileResource from './tileResourceEnum.ts';
import type {Unit} from './units.ts';
import {placeBuiltBuilding, placeSite, spawnUnit, type World} from './world.ts';

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
    ledger: {produced: {}, consumed: {}},
    pendingDeltas: [],
    players: Array.from({length: playerCount}, (_, i) =>
      makePlayer(i, PlayerKind.human),
    ),
    // A bare world has no worldgen and no castles; the fixtures that want
    // seats standing somewhere place them by hand. Empty rather than the
    // real table, so nothing reads a doorstep this map never built.
    starts: [],
    raidState: {nextRaidTick: Number.MAX_SAFE_INTEGER, wave: 0}, // raids opt in
    admin: {enabled: true, raidsEnabled: true, instantBuild: false},
    pendingEvents: [],
    outcome: {state: MatchState.playing},
    banditsEnabled: true,
  };
}

/** Wrap bare SimCommands as player-0 envelopes (the common test case). */
export function cmds(...commands: SimCommand[]): PlayerCommand[] {
  return commands.map(cmd => ({playerId: 0, cmd}));
}

/**
 * The fixture village's tool shed, merged under every storehouse's stock:
 * a real village always ships one (START_STOCK), and without it every
 * fixture that stands a site or recruits a worker would first have to
 * remember that sites borrow hammers and posts consume tools. A test about
 * the tool economy itself overrides these per good ({ hammer: 0 }).
 */
export const FIXTURE_TOOLS: GoodAmounts = {
  [GoodId.axe]: 4,
  [GoodId.pickaxe]: 4,
  [GoodId.scythe]: 4,
  [GoodId.hammer]: 4,
  [GoodId.cauldron]: 4,
  [GoodId.rod]: 4,
};

/**
 * A seat's castle. The FIRST one a seat is given also becomes its start
 * spot (World.starts), the way worldgen plants a castle on the spot it
 * dealt — the AI steers scouts by that table, and a fixture that stood a
 * rival's castle without one left the doorstep unreachable.
 */
export function addStorehouse(
  world: World,
  x: number,
  y: number,
  stock: GoodAmounts,
  owner: Owner = 0,
): Building {
  const b = placeBuiltBuilding(world, BuildingTypeId.storehouse, owner, x, y);
  b.stock = {...FIXTURE_TOOLS, ...stock};
  // Filled, never sparse: a hole in `starts` destructures as undefined in
  // everything that walks the table (searchLandmarks in systems/ai.ts), so
  // a fixture that stands seat 1's castle and no one else's would crash the
  // brain rather than merely leave seat 0 homeless.
  for (let i = world.starts.length; i < owner; i++)
    world.starts[i] = {x: 0, y: 0};
  world.starts[owner] ??= {x, y};
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
  const b = placeBuiltBuilding(world, BuildingTypeId.woodcutter, owner, x, y);
  if (withWorker) {
    const worker = spawnUnit(
      world,
      UnitTypeId.worker,
      owner,
      x + 0.5,
      y + b.h + 0.5,
    );
    bindWorker(b, worker);
  }
  return b;
}

export function addSite(
  world: World,
  x: number,
  y: number,
  owner: Owner = 0,
): Building {
  return placeSite(world, BuildingTypeId.woodcutter, owner, x, y);
}

export function addSerf(
  world: World,
  x: number,
  y: number,
  owner: Owner = 0,
): Unit {
  return spawnUnit(world, UnitTypeId.serf, owner, x + 0.5, y + 0.5);
}

/** Staff a building directly (tests that don't exercise recruitment). */
export function staffBuilding(world: World, b: Building): Unit {
  const worker = spawnUnit(
    world,
    UnitTypeId.worker,
    b.owner,
    b.x + b.w / 2,
    b.y + b.h + 0.5,
  );
  bindWorker(b, worker);
  return worker;
}
