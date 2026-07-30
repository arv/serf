import { Rng } from '../shared/rng';
import { MAP_SIZE, inBounds, tileIdx } from '../shared/grid';
import {
  Terrain,
  TileResource,
  clearResources,
  generateMap,
  rectClear,
  resourceBlocks,
  type GameMap,
  type MapView,
} from './map';
import { FIRST_RAID_TICK, START_SERFS, START_STOCK } from './defs/balance';
import { UNIT_DEFS } from './defs/units';
import { buildingDef, type BuildingTypeId } from './defs/buildings';
import { makeUnit, type Unit } from './units';
import type { GoodAmounts, GoodId } from './defs/goods';
import type { TechId } from './defs/techs';
import type { Building, EntityId, Owner } from './entities';

export interface HaulJob {
  id: number;
  good: GoodId;
  from: EntityId;
  to: EntityId;
  priority: 1 | 2 | 3;
  createdTick: number;
  phase: 'open' | 'toPickup' | 'toDropoff';
  serfId?: EntityId;
  blockedUntil?: number;
  /** Consecutive pathing failures; too many aborts the job + backs off the demand. */
  blockedCount?: number;
}

/** A tile whose render-relevant state changed; drained into the structural message. */
export interface MapDelta {
  idx: number;
  resource: number;
  blocked: number;
  pathLevel: number;
  buildingAt: number;
}

/** Goods created/destroyed counters — lets the dev ledger prove conservation. */
export interface Ledger {
  produced: GoodAmounts;
  consumed: GoodAmounts;
}

export interface World {
  tick: number;
  rngState: number;
  nextId: number;
  map: GameMap;
  units: Map<EntityId, Unit>;
  buildings: Map<EntityId, Building>;
  jobs: Map<number, HaulJob>;
  nextJobId: number;
  ledger: Ledger;
  /** Drained by the worker into structural messages. */
  pendingDeltas: MapDelta[];
  /** Stone-road paving enabled (unlocked by the Masonry tech). */
  pavingUnlocked: boolean;
  techs: TechState;
  raidState: { nextRaidTick: number; wave: number };
  /** Sandbox switches for tweaking the game (the ?admin panel). */
  admin: AdminState;
  /** One-shot events drained into structural messages (toasts, game over). */
  pendingEvents: GameEvent[];
  outcome: 'playing' | 'won' | 'lost';
}

export interface AdminState {
  /** Bandit waves spawn (default on; off = peaceful sandbox). */
  raidsEnabled: boolean;
  /** Sites complete instantly and need no materials. */
  instantBuild: boolean;
}

export type GameEvent =
  | { kind: 'raidIncoming'; text: string }
  | { kind: 'gameOver'; outcome: 'won' | 'lost' };

export interface TechState {
  researched: TechId[];
  active?: { tech: TechId; ticksLeft: number };
  /** Ticks remaining on the current festival work-speed buff. */
  festivalTicksLeft: number;
}

export function pushDelta(world: World, idx: number): void {
  world.pendingDeltas.push({
    idx,
    resource: world.map.resource[idx]!,
    blocked: world.map.blocked[idx]!,
    pathLevel: world.map.pathLevel[idx]!,
    buildingAt: world.map.buildingAt[idx]!,
  });
}

export function createWorld(seed: number): World {
  const rng = new Rng(seed | 0);
  const map = generateMap(rng);

  const world: World = {
    tick: 0,
    rngState: rng.state,
    nextId: 1,
    map,
    units: new Map(),
    buildings: new Map(),
    jobs: new Map(),
    nextJobId: 1,
    ledger: { produced: {}, consumed: {} },
    pendingDeltas: [],
    pavingUnlocked: false, // Masonry unlocks
    techs: { researched: [], festivalTicksLeft: 0 },
    raidState: { nextRaidTick: FIRST_RAID_TICK, wave: 0 },
    admin: { raidsEnabled: true, instantBuild: false },
    pendingEvents: [],
    outcome: 'playing',
  };

  // Storehouse at the center; clear anything under it.
  const shX = MAP_SIZE / 2 - 2;
  const shY = MAP_SIZE / 2 - 2;
  clearResources(map, shX - 1, shY - 1, 5, 5);
  const storehouse = placeBuiltBuilding(world, 'storehouse', 'player', shX, shY);
  storehouse.stock = { ...START_STOCK };

  // Bandit camp in a random far corner; search outward for a clear 3x3.
  const corners: [number, number][] = [
    [10, 10],
    [MAP_SIZE - 13, 10],
    [10, MAP_SIZE - 13],
    [MAP_SIZE - 13, MAP_SIZE - 13],
  ];
  // Mountains and lakes can swallow a whole corner now, so fall through
  // to the other corners rather than generating a campless (instant-win)
  // world.
  const firstCorner = rng.int(corners.length);
  outer: for (let ci = 0; ci < corners.length; ci++) {
    const [cx, cy] = corners[(firstCorner + ci) % corners.length]!;
    for (let r = 0; r < 12; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (rectClear(map, cx + dx, cy + dy, 3, 3)) {
            const camp = placeBuiltBuilding(world, 'banditCamp', 'bandit', cx + dx, cy + dy);
            // Standing guards defend the camp (auto-acquire handles the rest).
            for (let g = 0; g < 3; g++) {
              spawnUnit(world, 'bandit', 'bandit', camp.x - 0.5 + g * 2, camp.y + camp.h + 1.5);
            }
            break outer;
          }
        }
      }
    }
  }

  // Starting serfs, scattered just south of the storehouse.
  for (let i = 0; i < START_SERFS; i++) {
    const x = shX - 1 + (i % 5) + 0.5;
    const y = shY + 4 + Math.floor(i / 5) + 0.5;
    spawnUnit(world, 'serf', 'player', x, y);
  }

  world.rngState = rng.state;
  return world;
}

export function spawnUnit(
  world: World,
  kind: keyof typeof UNIT_DEFS,
  owner: Owner,
  x: number,
  y: number,
): Unit {
  const unit = makeUnit(world.nextId++, kind, owner, x, y, UNIT_DEFS[kind].hp);
  world.units.set(unit.id, unit);
  return unit;
}

function makeBuildingRecord(
  world: World,
  type: BuildingTypeId,
  owner: Owner,
  x: number,
  y: number,
): Building {
  const def = buildingDef(type);
  return {
    id: world.nextId++,
    type,
    owner,
    x,
    y,
    w: def.w,
    h: def.h,
    hp: def.hp,
    state: 'built',
    stock: {},
    inputs: {},
    inbound: {},
    reservedOut: {},
    demandSince: {},
    dead: false,
  };
}

function occupyFootprint(world: World, b: Building): void {
  const blocks = !buildingDef(b.type).noBlock;
  for (let ty = b.y; ty < b.y + b.h; ty++) {
    for (let tx = b.x; tx < b.x + b.w; tx++) {
      const i = tileIdx(tx, ty);
      world.map.buildingAt[i] = b.id;
      if (blocks) world.map.blocked[i] = 1;
      pushDelta(world, i);
    }
  }
}

/** Pre-placed, already-complete buildings (worldgen). */
export function placeBuiltBuilding(
  world: World,
  type: BuildingTypeId,
  owner: Owner,
  x: number,
  y: number,
): Building {
  const b = makeBuildingRecord(world, type, owner, x, y);
  world.buildings.set(b.id, b);
  occupyFootprint(world, b);
  return b;
}

/** Player-placed construction site: blocks tiles now, needs materials hauled. */
export function placeSite(
  world: World,
  type: BuildingTypeId,
  owner: Owner,
  x: number,
  y: number,
): Building {
  const def = buildingDef(type);
  const b = makeBuildingRecord(world, type, owner, x, y);
  b.state = 'site';
  // A bare frame is fragile; hp climbs to full as construction advances.
  b.hp = Math.max(1, Math.round(buildingDef(b.type).hp * 0.15));
  b.hp = Math.max(1, Math.round(def.hp * 0.2));
  b.siteNeeds = { ...def.cost };
  b.buildProgress = 0;
  world.buildings.set(b.id, b);
  occupyFootprint(world, b);
  return b;
}

/**
 * Placement validity: footprint on clear grass, and at least one walkable
 * ring tile so the door isn't sealed. Shared by the worker (authoritative)
 * and mirrored logic on the main thread for instant ghost feedback.
 */
export function canPlace(map: MapView, type: BuildingTypeId, x: number, y: number): boolean {
  const def = buildingDef(type);
  if (!rectClear(map, x, y, def.w, def.h)) return false;
  for (let ty = y; ty < y + def.h; ty++) {
    for (let tx = x; tx < x + def.w; tx++) {
      if (map.terrain[tileIdx(tx, ty)] !== Terrain.Grass) return false;
    }
  }

  // Mountainsides are for mines (they carve into the seam); everything
  // else needs flat-ish ground. Corner heights match the renderer's
  // bilinear ground (average of adjacent tiles), so 1x1 footprints on a
  // steep hillside are caught too.
  if (!def.nearDeposit) {
    const corner = (vx: number, vy: number): number => {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 0; dy++) {
        for (let dx = -1; dx <= 0; dx++) {
          const tx = vx + dx;
          const ty = vy + dy;
          if (!inBounds(tx, ty)) continue;
          sum += map.height[tileIdx(tx, ty)]!;
          n++;
        }
      }
      return n > 0 ? sum / n : 0;
    };
    let lo = Infinity;
    let hi = -Infinity;
    for (const [vx, vy] of [
      [x, y],
      [x + def.w, y],
      [x, y + def.h],
      [x + def.w, y + def.h],
    ] as const) {
      const h = corner(vx, vy);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    if (hi - lo > 0.5) return false;
  }
  let hasDoor = false;
  for (let tx = x - 1; tx <= x + def.w && !hasDoor; tx++) {
    for (let ty = y - 1; ty <= y + def.h && !hasDoor; ty++) {
      const onRing = tx === x - 1 || tx === x + def.w || ty === y - 1 || ty === y + def.h;
      if (!onRing || !inBounds(tx, ty)) continue;
      if (!map.blocked[tileIdx(tx, ty)]) hasDoor = true;
    }
  }
  if (!hasDoor) return false;

  // Mines must sit next to their ore seam.
  if (def.nearDeposit) {
    const code = DEPOSIT_CODE[def.nearDeposit.resource];
    const r = def.nearDeposit.radius;
    const cx = Math.floor(x + def.w / 2);
    const cy = Math.floor(y + def.h / 2);
    let found = false;
    for (let dy = -r; dy <= r && !found; dy++) {
      for (let dx = -r; dx <= r && !found; dx++) {
        const px = cx + dx;
        const py = cy + dy;
        if (!inBounds(px, py)) continue;
        const i = tileIdx(px, py);
        if (map.resource[i] === code && map.buildingAt[i] === -1) found = true;
      }
    }
    if (!found) return false;
  }
  return true;
}

const DEPOSIT_CODE: Record<string, number> = {
  bamboo: TileResource.Bamboo,
  rock: TileResource.Rock,
  ironDep: TileResource.IronDep,
  silverDep: TileResource.SilverDep,
  goldDep: TileResource.GoldDep,
};

/**
 * Kill a unit: marked dead now, removed at end of tick. A carried good dies
 * with it (ledgered); job/link cleanup happens in logistics reconcile.
 */
export function killUnit(world: World, unit: Unit): void {
  if (unit.dead) return;
  unit.dead = true;
  unit.deathTick = world.tick;
  if (unit.carrying !== undefined) {
    world.ledger.consumed[unit.carrying] = (world.ledger.consumed[unit.carrying] ?? 0) + 1;
    unit.carrying = undefined;
  }
}

/**
 * Destroy a building: frees its footprint, loses its stock (ledgered), kills
 * its resident worker. Jobs touching it are cleaned by logistics reconcile.
 */
export function destroyBuilding(world: World, b: Building): void {
  if (b.dead) return;
  b.dead = true;
  for (let ty = b.y; ty < b.y + b.h; ty++) {
    for (let tx = b.x; tx < b.x + b.w; tx++) {
      const i = tileIdx(tx, ty);
      if (world.map.buildingAt[i] === b.id) {
        world.map.buildingAt[i] = -1;
        world.map.blocked[i] =
          world.map.terrain[i] === Terrain.Water || resourceBlocks(world.map.resource[i]!)
            ? 1
            : 0;
        pushDelta(world, i);
      }
    }
  }
  for (const goods of [b.stock, b.inputs]) {
    for (const [good, n] of Object.entries(goods)) {
      if (n) {
        world.ledger.consumed[good as GoodId] = (world.ledger.consumed[good as GoodId] ?? 0) + n;
      }
    }
  }
  b.stock = {};
  b.inputs = {};
  if (b.workerId !== undefined) {
    const worker = world.units.get(b.workerId);
    if (worker) killUnit(world, worker);
  }
}

/** Deplete one unit of a tile resource; clears + unblocks the tile at zero. */
export function depleteResourceTile(world: World, idx: number): void {
  const amt = world.map.resourceAmt[idx]!;
  if (amt <= 1) {
    world.map.resource[idx] = TileResource.None;
    world.map.resourceAmt[idx] = 0;
    if (world.map.buildingAt[idx]! < 0 && world.map.terrain[idx] === Terrain.Grass) {
      world.map.blocked[idx] = 0;
    }
    pushDelta(world, idx);
  } else {
    world.map.resourceAmt[idx] = amt - 1;
  }
}
