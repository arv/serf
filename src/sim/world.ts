import { Rng } from '../shared/rng.ts';
import { MAP_SIZE, inBounds, tileIdx } from '../shared/grid.ts';
import {
  RESOURCE_CODE,
  Terrain,
  TileResource,
  clearResources,
  findResourceNear,
  generateMap,
  rectClear,
  resourceBlocks,
  type GameMap,
  type MapView,
} from './map.ts';
import { FIRST_RAID_TICK, START_SERFS, START_STOCK } from './defs/balance.ts';
import { UNIT_DEFS } from './defs/units.ts';
import {
  buildingDef,
  gatherOrigin,
  gatherRecipeOf,
  type BuildingTypeId,
} from './defs/buildings.ts';
import { dealStrategies, type AiStrategyId } from './defs/aiStrategies.ts';
import { MISSION_DEFS, type MissionId } from './defs/missions.ts';
import { makeUnit, type Unit } from './units.ts';
import { nearestWalkable } from './path.ts';
import type { GoodAmounts, GoodId } from './defs/goods.ts';
import type { TechId } from './defs/techs.ts';
import { BANDIT, type Building, type EntityId, type Owner } from './entities.ts';
import { makePlayer, type PlayerState } from './player.ts';

export interface HaulJob {
  id: number;
  good: GoodId;
  from: EntityId;
  to: EntityId;
  /** Faction the haul belongs to — jobs never cross owners (invariant). */
  owner: Owner;
  priority: 1 | 2 | 3;
  createdTick: number;
  phase: 'open' | 'toPickup' | 'toDropoff';
  serfId?: EntityId;
  /**
   * Set on arrival at a source with `drawTicks` (the well): the tick the
   * hauler finishes drawing and the good is finally in its hands. Lives on
   * the job rather than the building so two haulers at one well each pay
   * their own six seconds instead of queueing on a shared timer.
   */
  drawUntil?: number;
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
  /** Faction state per seat; index === owner id === command playerId. */
  players: PlayerState[];
  raidState: { nextRaidTick: number; wave: number };
  /** Sandbox switches for tweaking the game (the ?admin panel). */
  admin: AdminState;
  /** Whether this world was generated with a bandit faction; gates the
   * solo raze-the-camp win so a peaceful sandbox never auto-ends. */
  banditsEnabled: boolean;
  /** One-shot events drained into structural messages (toasts, game over). */
  pendingEvents: GameEvent[];
  outcome: MatchOutcome;
  /** Campaign mission this world is playing, if any. The id rides the world
   * (and the save) rather than the URL, so a loaded game still knows. */
  missionId?: MissionId;
  /** Latch bits, one per mission objective: a stock objective met and then
   * spent stays met, and the completion event fires exactly once. The latch
   * is why this is world state — it must survive save/load. */
  objectivesDone?: boolean[];
}

export type MatchOutcome =
  | { state: 'playing' }
  /** winner null = the last player fell too (solo loss / mutual destruction). */
  | { state: 'over'; winner: Owner | null };

export interface AdminState {
  /** Admin commands are honored at all (set once at world creation, so every
   * lockstep client agrees; networked matches create worlds with this off). */
  enabled: boolean;
  /** Bandit waves spawn (default on; off = peaceful sandbox). */
  raidsEnabled: boolean;
  /** Sites complete instantly and need no materials. */
  instantBuild: boolean;
}

export type GameEvent =
  | { kind: 'raidIncoming'; text: string; player: Owner }
  | { kind: 'playerEliminated'; player: Owner }
  | { kind: 'gameOver'; winner: Owner | null }
  | { kind: 'objectiveComplete'; index: number; player: Owner }
  /** A player's building or unit lost hp. One event per strike, addressed
   * to the victim's owner; the client aggregates them into alerts. */
  | { kind: 'damage'; player: Owner; x: number; y: number; building: boolean };

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

export interface WorldConfig {
  seed: number;
  /** 1..4 seats; index = playerId. An AI seat may name the playbook it
   * wants; the ones that don't are dealt from the seed. */
  players: { kind: 'human' | 'ai'; strategy?: AiStrategyId }[];
  /** Admin (cheat) commands honored. Default true — networked games pass false. */
  adminEnabled?: boolean;
  /** Bandits exist. Default true; false places no camp, no guards, and
   * runs no raids — a peaceful sandbox (solo never auto-wins there). */
  banditsEnabled?: boolean;
  /** Campaign mission recipe to apply (defs/missions.ts). The id, not the
   * spec: config and save stay small, and two hosts resolving the same id
   * read the same table. */
  mission?: MissionId;
}

/** The full WorldConfig a mission def prescribes. Callers may override
 * seats (the headless tests put an AI in the human's chair). */
export function missionWorldConfig(id: MissionId): WorldConfig {
  const def = MISSION_DEFS[id];
  return {
    seed: def.seed,
    players: def.players.map((p) => ({ ...p })),
    banditsEnabled: def.bandits,
    mission: id,
  };
}

/**
 * Storehouse footprint origins per player count. Solo keeps the classic
 * center start; 2-4 players sit symmetrically on a ring around the middle
 * (the contested ore ring stays equidistant). Integer literals on purpose —
 * worldgen must not depend on runtime trig.
 *
 * Exported as public knowledge: the server tells every seat this much (see
 * sync.ts — "start positions come from a fixed table anyone can read in
 * the source"), so the AI brain may aim its scouts at rival doorsteps
 * without cheating.
 */
export const START_LAYOUTS: Record<number, [number, number][]> = {
  1: [[MAP_SIZE / 2 - 2, MAP_SIZE / 2 - 2]],
  2: [
    [18, 18],
    [44, 44],
  ],
  3: [
    [30, 49],
    [14, 20],
    [46, 20],
  ],
  4: [
    [18, 18],
    [44, 44],
    [44, 18],
    [18, 44],
  ],
};

export function createWorld(seedOrConfig: number | WorldConfig): World {
  const config: WorldConfig =
    typeof seedOrConfig === 'number'
      ? { seed: seedOrConfig, players: [{ kind: 'human' }] }
      : seedOrConfig;
  const seed = config.seed | 0;
  const mission = config.mission ? MISSION_DEFS[config.mission] : undefined;
  const layout = START_LAYOUTS[config.players.length];
  if (!layout) throw new Error(`no start layout for ${config.players.length} players`);
  const starts = layout.map(([x, y]) => ({ x, y }));

  const deal = dealStrategies(seed, config.players);

  const rng = new Rng(seed);
  const map = generateMap(rng, starts);

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
    // The seed deals the AI seats their playbooks here, once, and the
    // world carries the result from then on (see PlayerState.strategy).
    players: config.players.map((p, i) => makePlayer(i, p.kind, deal[i])),
    raidState: { nextRaidTick: mission?.firstRaidTick ?? FIRST_RAID_TICK, wave: 0 },
    admin: {
      enabled: config.adminEnabled ?? true,
      raidsEnabled: config.banditsEnabled ?? true,
      instantBuild: false,
    },
    pendingEvents: [],
    outcome: { state: 'playing' },
    banditsEnabled: config.banditsEnabled ?? true,
  };

  // Each faction's storehouse on its plateau; clear anything under it.
  // (Entity-id order — storehouses, camp, serfs — matches the classic solo
  // worldgen exactly.)
  for (let p = 0; p < starts.length; p++) {
    const { x: shX, y: shY } = starts[p]!;
    clearResources(map, shX - 1, shY - 1, 5, 5);
    const storehouse = placeBuiltBuilding(world, 'storehouse', p, shX, shY);
    // Mission overrides apply to the human's seat only (seat 0); a mission
    // rival opens with the standard larder.
    storehouse.stock = { ...(p === 0 && mission?.startStock ? mission.startStock : START_STOCK) };
  }

  // Bandit camp. Solo: a random far corner (the classic campaign). With
  // rivals on the map the barbarians hold the middle instead — an
  // equidistant menace standing guard over the contested gold that
  // worldgen put there. Corners stay on the list as fallbacks, farthest
  // from any doorstep first, for seeds whose middle is all lake.
  const corners: [number, number][] = [
    [10, 10],
    [MAP_SIZE - 13, 10],
    [10, MAP_SIZE - 13],
    [MAP_SIZE - 13, MAP_SIZE - 13],
  ];
  let campSeeds: [number, number][];
  if (starts.length === 1) {
    const first = rng.int(corners.length);
    campSeeds = corners.map((_, ci) => corners[(first + ci) % corners.length]!);
  } else {
    const nearestStart = ([cx, cy]: [number, number]): number => {
      let best = Infinity;
      for (const st of starts) {
        const d = Math.max(Math.abs(cx + 1 - (st.x + 1)), Math.abs(cy + 1 - (st.y + 1)));
        if (d < best) best = d;
      }
      return best;
    };
    const middle: [number, number] = [MAP_SIZE / 2 - 1, MAP_SIZE / 2 - 1];
    campSeeds = [middle, ...corners.sort((a, z) => nearestStart(z) - nearestStart(a))];
  }
  // Mountains and lakes can swallow a whole seed area, so widen the search
  // rather than generate a campless (instant-win) world.
  if (config.banditsEnabled === false) campSeeds = [];
  outer: for (const [cx, cy] of campSeeds) {
    for (let r = 0; r < 16; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (rectClear(map, cx + dx, cy + dy, 3, 3)) {
            const camp = placeBuiltBuilding(world, 'banditCamp', BANDIT, cx + dx, cy + dy);
            // Standing guards defend the camp (auto-acquire handles the rest).
            for (let g = 0; g < 3; g++) {
              spawnUnitNearby(world, 'bandit', BANDIT, camp.x - 0.5 + g * 2, camp.y + camp.h + 1.5);
            }
            break outer;
          }
        }
      }
    }
  }

  // Starting serfs, scattered just south of each storehouse.
  for (let p = 0; p < starts.length; p++) {
    const { x: shX, y: shY } = starts[p]!;
    const serfs = p === 0 && mission?.startSerfs !== undefined ? mission.startSerfs : START_SERFS;
    for (let i = 0; i < serfs; i++) {
      const x = shX - 1 + (i % 5) + 0.5;
      const y = shY + 4 + Math.floor(i / 5) + 0.5;
      spawnUnit(world, 'serf', p, x, y);
    }
  }

  // Mission dressing, after the classic worldgen so a mission with no
  // overrides (the finale) is tile- and id-identical to the solo game the
  // winnable test proves takeable.
  if (mission) {
    world.missionId = mission.id;
    world.objectivesDone = mission.objectives.map(() => false);
    if (mission.startTechs) {
      const techs = world.players[0]!.techs;
      for (const tech of mission.startTechs) {
        if (!techs.researched.includes(tech)) techs.researched.push(tech);
        // Of the techs the campaign grants none carries a side flag; only
        // masonry would need pavingUnlocked mirrored here if a mission ever
        // grants it.
      }
    }
    if (mission.prebuilt) {
      const origin = starts[0]!;
      for (const spec of mission.prebuilt) {
        placePrebuiltNear(world, spec.type, origin.x + spec.dx, origin.y + spec.dy);
      }
    }
  }

  world.rngState = rng.state;
  return world;
}

/**
 * Stand a mission's pre-built building at the requested spot, or the nearest
 * one the ordinary placement rules accept — the same ring-spiral search the
 * bandit camp placement uses, and deterministic for the same reason: no rng
 * draw, fixed scan order. A gatherer spirals until its resource is in reach
 * (canPlace enforces that), so a woodcutter asked for at an offset lands
 * where the trees actually are. Tiles under a standing unit are refused so
 * worldgen never walls a starting serf in. Silently places nothing when 15
 * rings find no ground — the mission tests assert every prebuilt landed.
 */
function placePrebuiltNear(
  world: World,
  type: BuildingTypeId,
  cx: number,
  cy: number,
): Building | undefined {
  const def = buildingDef(type);
  const occupied = new Set<number>();
  for (const u of world.units.values()) {
    if (!u.dead) occupied.add(tileIdx(Math.floor(u.x), Math.floor(u.y)));
  }
  const footprintFree = (x: number, y: number): boolean => {
    for (let ty = y; ty < y + def.h; ty++) {
      for (let tx = x; tx < x + def.w; tx++) {
        if (!inBounds(tx, ty) || occupied.has(tileIdx(tx, ty))) return false;
      }
    }
    return true;
  };
  for (let r = 0; r < 15; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (canPlace(world.map, type, x, y) && footprintFree(x, y)) {
          return placeBuiltBuilding(world, type, 0, x, y);
        }
      }
    }
  }
  return undefined;
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

/**
 * Spawn on dry, walkable ground: the requested spot if it is clear, else the
 * nearest tile that is. Lakes and mountains can sit right where a camp wants
 * to muster its raiders, and a unit dropped on water wades in place forever
 * (the grid it paths on says that tile is blocked).
 */
export function spawnUnitNearby(
  world: World,
  kind: keyof typeof UNIT_DEFS,
  owner: Owner,
  x: number,
  y: number,
): Unit {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (inBounds(tx, ty) && !world.map.blocked[tileIdx(tx, ty)]) {
    return spawnUnit(world, kind, owner, x, y);
  }
  const idx = nearestWalkable(world.map, tx, ty, 8);
  if (idx < 0) return spawnUnit(world, kind, owner, x, y); // nowhere dry nearby
  return spawnUnit(world, kind, owner, (idx % MAP_SIZE) + 0.5, Math.floor(idx / MAP_SIZE) + 0.5);
}

/**
 * Which way the nearest water lies from a footprint, as quarter turns from
 * +z. Equal distances keep the first tile the scan reaches — lowest y, then
 * lowest x, so a footprint with water squared off on two sides faces -z
 * before -x before anything else. Arbitrary, but it has to be *decided*:
 * two hosts placing the same fishery must turn it the same way or their
 * renders — and their save hashes — diverge. Scan order is what makes that
 * true, so the loop bounds below are load-bearing, not incidental.
 */
function waterFacing(
  map: World['map'],
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): 0 | 1 | 2 | 3 {
  const cx = x + w / 2;
  const cy = y + h / 2;
  let best: 0 | 1 | 2 | 3 = 0;
  let bestD = Infinity;
  for (let ty = y - radius; ty < y + h + radius; ty++) {
    for (let tx = x - radius; tx < x + w + radius; tx++) {
      if (!inBounds(tx, ty)) continue;
      if (map.terrain[tileIdx(tx, ty)] !== Terrain.Water) continue;
      const dx = tx + 0.5 - cx;
      const dy = ty + 0.5 - cy;
      const d = dx * dx + dy * dy;
      if (d >= bestD) continue;
      bestD = d;
      best = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 0 : 2;
    }
  }
  return best;
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
    ...(def.nearWater
      ? { facing: waterFacing(world.map, x, y, def.w, def.h, def.nearWater.radius) }
      : {}),
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

  // Mountainsides are for mines (they carve into the seam) and shorelines
  // are for the fishery (a bank is a slope by definition, and a fishery
  // that can only stand on a dead-level beach can stand almost nowhere);
  // everything else needs flat-ish ground. Corner heights match the
  // renderer's bilinear ground (average of adjacent tiles), so 1x1
  // footprints on a steep hillside are caught too.
  if (!def.mine && !def.nearWater) {
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

  // A gatherer has to be within reach of something to gather. The mine's
  // seam is the obvious case, but the woodcutter and the quarry answer to
  // the same rule: a hut raised out of range of every tree is six wood
  // spent on a worker who walks out, finds nothing, and comes home — so
  // the refusal happens here, while it is still a ghost under the cursor,
  // rather than three minutes later when the wood never arrives. The
  // search is the worker's own, run from the footprint it would stand on.
  const gather = gatherRecipeOf(def);
  if (gather) {
    const c = gatherOrigin(def, x, y);
    if (findResourceNear(map, c.x, c.y, RESOURCE_CODE[gather.resource]!, gather.radius) < 0) {
      return false;
    }
  }

  // The fishery has to reach the water it fishes. The footprint runs
  // x..x+w-1, so `r` tiles beyond it ends at x+w-1+r — the exclusive bound
  // below. It used to be `<= x + def.w + r`, one tile too far, which let a
  // fishery stand two tiles off the water on its south and east sides; the
  // facing search (waterFacing, which has always used the tighter box)
  // then found no water at all and left the pier pointing at dry land.
  if (def.nearWater) {
    const r = def.nearWater.radius;
    let found = false;
    for (let ty = y - r; ty < y + def.h + r && !found; ty++) {
      for (let tx = x - r; tx < x + def.w + r && !found; tx++) {
        if (!inBounds(tx, ty)) continue;
        if (map.terrain[tileIdx(tx, ty)] === Terrain.Water) found = true;
      }
    }
    if (!found) return false;
  }
  return true;
}

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

/**
 * Nail one repair material onto a building: the hp it buys was fixed when
 * the order was placed, and the last of the bill is what clears the order.
 *
 * Lives here beside the other world mutations because both ends of a repair
 * reach for it — the hauler arriving with a plank (logistics) and the
 * building spending one it already had in its own stores (construction).
 */
export function applyRepairMaterial(world: World, b: Building, good: GoodId): void {
  if ((b.repairNeeds?.[good] ?? 0) <= 0) return;
  b.repairNeeds![good] = (b.repairNeeds![good] ?? 0) - 1;
  b.hp = Math.min(buildingDef(b.type).hp, b.hp + (b.repairHpPerGood ?? 0));
  world.ledger.consumed[good] = (world.ledger.consumed[good] ?? 0) + 1;
  const bill = Object.keys(b.repairNeeds!) as GoodId[];
  for (const g of bill) {
    if ((b.repairNeeds![g] ?? 0) > 0) return;
  }
  clearRepairOrder(b, bill);
}

/**
 * Drop a repair order and the FIFO clocks it was keeping. The age of an
 * unmet demand lives per (building, good) — leave a finished repair's behind
 * and the next thing that building asks for inherits it, jumping a queue it
 * never stood in.
 */
export function clearRepairOrder(b: Building, bill: GoodId[]): void {
  delete b.repairNeeds;
  delete b.repairHpPerGood;
  for (const g of bill) delete b.demandSince[g];
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
