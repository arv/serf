import { tileX, tileY } from '../../shared/grid.ts';
import { Rng } from '../../shared/rng.ts';
import { WOOD_MAX_AMT, REGROW_INTERVAL } from '../defs/balance.ts';
import {
  OUTPUT_CAP,
  buildingDef,
  convertRecipeOf,
  gatherOrigin,
  type BuildingDef,
  type Recipe,
} from '../defs/buildings.ts';
import { RESOURCE_CODE, TileResource, findResourcesNear } from '../map.ts';
import { atBuilding, atTile, walkToBuilding, walkToTile } from '../arrival.ts';
import type { Building } from '../entities.ts';
import { findPathToAdjacent } from '../path.ts';
import { depleteResourceTile, type World } from '../world.ts';
import { getModifier } from '../techHelpers.ts';
import type { GoodId } from '../defs/goods.ts';
import type { Unit } from '../units.ts';

/**
 * How many nearby resource tiles one trip-start will try to path to before
 * giving up until the next attempt. Enough to see past a walled-in pocket
 * of its own seam; small enough that a fully shut-in hut costs a bounded
 * handful of path searches per 40-tick retry.
 */
const GATHER_REACH_TRIES = 8;

/**
 * Gather production: each producer's resident worker commutes to resource
 * tiles, works them, and carries the yield home into the building's output
 * stock. Convert recipes (M3) will join here.
 */
export function productionSystem(world: World, rng: Rng): void {
  for (const b of world.buildings.values()) {
    if (b.dead || b.state !== 'built' || b.paused) continue;
    const def = buildingDef(b.type);
    const recipe = def.recipe ?? convertRecipeOf(def, b);
    if (!recipe) continue;
    // Population economy: no worker at the post, no production. (Gather
    // recipes are inherently worker-driven; converts pause too, mid-batch
    // included, until the staffing system delivers a replacement.)
    if (def.workerKind !== undefined) {
      const worker = b.workerId !== undefined ? world.units.get(b.workerId) : undefined;
      if (!worker || worker.dead) continue;
    }
    if (recipe.kind === 'gather') gatherStep(world, b, recipe);
    else convertStep(world, b, def, recipe);
  }

  if (world.tick > 0 && world.tick % REGROW_INTERVAL === 0) regrow(world, rng);
}

/**
 * Convert recipes: consume inputs at batch start, emit outputs at batch end.
 * Full output buffers stall the next batch (Settlers rule).
 */
function convertStep(
  world: World,
  b: Building,
  def: BuildingDef,
  recipe: Recipe & { kind: 'convert' },
): void {
  if (b.prodTicksLeft !== undefined) {
    b.prodTicksLeft--;
    if (b.prodTicksLeft <= 0) {
      // The batch finishes as what it started as: a forge switched from
      // spears to swords mid-batch still turns out the spear it was
      // hammering (prodRecipeIndex is stamped at batch start).
      const started =
        b.prodRecipeIndex !== undefined
          ? (def.recipeOptions?.[b.prodRecipeIndex]?.recipe ?? recipe)
          : recipe;
      for (const [good, n] of Object.entries(started.outputs) as [GoodId, number][]) {
        b.stock[good] = (b.stock[good] ?? 0) + n;
        world.ledger.produced[good] = (world.ledger.produced[good] ?? 0) + n;
      }
      b.prodTicksLeft = undefined;
      b.prodRecipeIndex = undefined;
    }
    return;
  }

  for (const [good, n] of Object.entries(recipe.outputs) as [GoodId, number][]) {
    if ((b.stock[good] ?? 0) + n > OUTPUT_CAP) return; // output full — stall
  }
  for (const [good, n] of Object.entries(recipe.inputs) as [GoodId, number][]) {
    if ((b.inputs[good] ?? 0) < n) return; // waiting on ingredients
  }
  for (const [good, n] of Object.entries(recipe.inputs) as [GoodId, number][]) {
    b.inputs[good] = (b.inputs[good] ?? 0) - n;
    world.ledger.consumed[good] = (world.ledger.consumed[good] ?? 0) + n;
  }
  const speedup =
    getModifier(world, b.owner, 'workSpeed') *
    (b.type === 'wheatFarm' ? getModifier(world, b.owner, 'farmSpeed') : 1) *
    (b.type === 'mill' || b.type === 'bakery' ? getModifier(world, b.owner, 'foodSpeed') : 1) *
    (b.type === 'weaponsmith' ? getModifier(world, b.owner, 'forgeSpeed') : 1);
  b.prodTicksLeft = Math.max(1, Math.round(recipe.durationTicks / speedup));
  if (def.recipeOptions) b.prodRecipeIndex = b.recipeIndex ?? 0;
}

function gatherStep(world: World, b: Building, recipe: Recipe & { kind: 'gather' }): void {
  const worker = b.workerId !== undefined ? world.units.get(b.workerId) : undefined;
  if (!worker || worker.dead) return;

  switch (worker.task.t) {
    case 'idle': {
      if (world.tick < worker.task.until) return;
      // Still holding the last trip's output — the walk home gave up short.
      // Get it in before starting another trip: gatherWork writes `carrying`
      // outright, so a second load would overwrite the first and the
      // conservation ledger would come up a good short.
      if (worker.carrying !== undefined) {
        if (!walkToBuilding(world.map, worker, b)) {
          worker.task = { t: 'idle', until: world.tick + 40 };
          return;
        }
        worker.task = { t: 'gatherHome' };
        return;
      }
      // Output full? Wait — full buffers stall production (Settlers rule).
      if ((b.stock[recipe.output] ?? 0) >= OUTPUT_CAP) {
        worker.task = { t: 'idle', until: world.tick + 20 };
        return;
      }
      const c = gatherOrigin(buildingDef(b.type), b.x, b.y);
      // Nearest first, but never nearest only. The nearest tile can be
      // permanently unreachable — a tree walled in by its own grove was
      // enough — and retrying it alone idled the worker 40 ticks at a
      // time forever while workable tiles sat in radius, starving the
      // village of the good everything else is built from. The trip goes
      // to the nearest tile a path actually reaches; the candidate cap
      // bounds the pathfinding bill on beats where everything is shut.
      const candidates = findResourcesNear(
        world.map,
        c.x,
        c.y,
        RESOURCE_CODE[recipe.resource]!,
        recipe.radius,
        GATHER_REACH_TRIES,
      );
      let tile = -1;
      let path: number[] | null = null;
      for (const cand of candidates) {
        path = findPathToAdjacent(
          world.map,
          Math.floor(worker.x),
          Math.floor(worker.y),
          tileX(cand, world.map.size),
          tileY(cand, world.map.size),
          1,
          1,
        );
        if (path) {
          tile = cand;
          break;
        }
      }
      if (tile < 0 || !path) {
        worker.task = { t: 'idle', until: world.tick + 40 };
        return;
      }
      worker.path = path;
      worker.pathIdx = 0;
      worker.task = { t: 'gatherOut', tile };
      return;
    }
    case 'gatherOut': {
      if (worker.path !== null) return; // walking
      const tile = worker.task.tile;
      // Only a worker standing at the tile may work it — a walk cut short by
      // new construction would otherwise fell a tree from across the valley.
      if (!atTile(worker, tile, world.map.size)) {
        if (!walkToTile(world.map, worker, tile)) {
          worker.task = { t: 'idle', until: world.tick + 40 };
        }
        return;
      }
      if (
        world.map.resource[tile] !== RESOURCE_CODE[recipe.resource] ||
        world.map.resourceAmt[tile]! <= 0
      ) {
        worker.task = { t: 'idle', until: world.tick }; // someone else finished it
        return;
      }
      const speedup =
        getModifier(world, b.owner, 'workSpeed') *
        (buildingDef(b.type).mine ? getModifier(world, b.owner, 'mineSpeed') : 1);
      worker.task = {
        t: 'gatherWork',
        tile,
        until: world.tick + Math.max(1, Math.round(recipe.workTicks / speedup)),
      };
      return;
    }
    case 'gatherWork': {
      if (world.tick < worker.task.until) return;
      const tile = worker.task.tile;
      if (world.map.resource[tile] === RESOURCE_CODE[recipe.resource]) {
        depleteResourceTile(world, tile);
        worker.carrying = recipe.output;
        // The good exists from the moment it's chopped (it's on the worker's
        // shoulders and countable) — ledger it here, not at deposit.
        world.ledger.produced[recipe.output] =
          (world.ledger.produced[recipe.output] ?? 0) + 1;
      }
      const path = findPathToAdjacent(
        world.map,
        Math.floor(worker.x),
        Math.floor(worker.y),
        b.x,
        b.y,
        b.w,
        b.h,
      );
      worker.path = path;
      worker.pathIdx = 0;
      worker.task = { t: 'gatherHome' };
      return;
    }
    case 'gatherHome': {
      if (worker.path !== null) return; // walking
      // Not home yet: the load goes in the hut's stock, not through its wall.
      // Idling with it in hand is safe — the idle case above walks him back
      // rather than sending him out again on top of it.
      if (!atBuilding(worker, b)) {
        if (!walkToBuilding(world.map, worker, b)) {
          worker.task = { t: 'idle', until: world.tick + 40 };
        }
        return;
      }
      if (worker.carrying !== undefined) {
        b.stock[worker.carrying] = (b.stock[worker.carrying] ?? 0) + 1;
        worker.carrying = undefined;
      }
      worker.task = { t: 'idle', until: world.tick + 10 };
      return;
    }
    default:
      return;
  }
}

/** Tree groves slowly regrow on standing (uncleared) tiles. */
function regrow(world: World, rng: Rng): void {
  const map = world.map;
  for (let i = 0; i < map.resource.length; i++) {
    if (map.resource[i] === TileResource.Wood && map.resourceAmt[i]! < WOOD_MAX_AMT) {
      if (rng.next() < 0.1) map.resourceAmt[i] = map.resourceAmt[i]! + 1;
    }
  }
}

/** Assign a freshly spawned worker to its completed building (units.ts hook). */
export function bindWorker(b: Building, worker: Unit): void {
  b.workerId = worker.id;
  worker.homeId = b.id;
}

/**
 * The inverse: the worker walks off the job and rejoins the serf pool, and
 * the building goes back to wanting one (staffing will recruit again). Both
 * sides are cleared together — the invariants check that workerId and homeId
 * always point at each other.
 */
export function unbindWorker(world: World, worker: Unit): void {
  const home = worker.homeId !== undefined ? world.buildings.get(worker.homeId) : undefined;
  if (home && home.workerId === worker.id) home.workerId = undefined;
  worker.homeId = undefined;
  worker.kind = 'serf';
}
