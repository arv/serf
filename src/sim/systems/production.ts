import { inBounds, tileIdx, tileX, tileY } from '../../shared/grid';
import { Rng } from '../../shared/rng';
import { BAMBOO_MAX_AMT, REGROW_INTERVAL } from '../defs/balance';
import { OUTPUT_CAP, buildingDef, type Recipe } from '../defs/buildings';
import { TileResource, type TileResourceKind } from '../map';
import { centerOf, type Building } from '../entities';
import { findPathToAdjacent } from '../path';
import { depleteResourceTile, type World } from '../world';
import { getModifier } from '../techHelpers';
import type { GoodId } from '../defs/goods';
import type { Unit } from '../units';

const RESOURCE_CODE: Record<string, TileResourceKind> = {
  bamboo: TileResource.Bamboo,
  rock: TileResource.Rock,
  ironDep: TileResource.IronDep,
  silverDep: TileResource.SilverDep,
  goldDep: TileResource.GoldDep,
};

/**
 * Gather production: each producer's resident worker commutes to resource
 * tiles, works them, and carries the yield home into the building's output
 * stock. Convert recipes (M3) will join here.
 */
export function productionSystem(world: World, rng: Rng): void {
  for (const b of world.buildings.values()) {
    if (b.dead || b.state !== 'built') continue;
    const def = buildingDef(b.type);
    const recipe = def.recipe;
    if (!recipe) continue;
    // Population economy: no worker at the post, no production. (Gather
    // recipes are inherently worker-driven; converts pause too, mid-batch
    // included, until the staffing system delivers a replacement.)
    if (def.workerKind !== undefined) {
      const worker = b.workerId !== undefined ? world.units.get(b.workerId) : undefined;
      if (!worker || worker.dead) continue;
    }
    if (recipe.kind === 'gather') gatherStep(world, b, recipe);
    else convertStep(world, b, recipe);
  }

  if (world.tick > 0 && world.tick % REGROW_INTERVAL === 0) regrow(world, rng);
}

/**
 * Convert recipes: consume inputs at batch start, emit outputs at batch end.
 * Full output buffers stall the next batch (Settlers rule).
 */
function convertStep(world: World, b: Building, recipe: Recipe & { kind: 'convert' }): void {
  if (b.prodTicksLeft !== undefined) {
    b.prodTicksLeft--;
    if (b.prodTicksLeft <= 0) {
      for (const [good, n] of Object.entries(recipe.outputs) as [GoodId, number][]) {
        b.stock[good] = (b.stock[good] ?? 0) + n;
        world.ledger.produced[good] = (world.ledger.produced[good] ?? 0) + n;
      }
      b.prodTicksLeft = undefined;
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
    getModifier(world, 'workSpeed') *
    (b.type === 'ricePaddy' ? getModifier(world, 'paddySpeed') : 1);
  b.prodTicksLeft = Math.max(1, Math.round(recipe.durationTicks / speedup));
}

function gatherStep(world: World, b: Building, recipe: Recipe & { kind: 'gather' }): void {
  const worker = b.workerId !== undefined ? world.units.get(b.workerId) : undefined;
  if (!worker || worker.dead) return;

  switch (worker.task.t) {
    case 'idle': {
      if (world.tick < worker.task.until) return;
      // Output full? Wait — full buffers stall production (Settlers rule).
      if ((b.stock[recipe.output] ?? 0) >= OUTPUT_CAP) {
        worker.task = { t: 'idle', until: world.tick + 20 };
        return;
      }
      const tile = findResourceTile(world, b, RESOURCE_CODE[recipe.resource]!, recipe.radius);
      if (tile < 0) {
        worker.task = { t: 'idle', until: world.tick + 40 };
        return;
      }
      const path = findPathToAdjacent(
        world.map,
        Math.floor(worker.x),
        Math.floor(worker.y),
        tileX(tile),
        tileY(tile),
        1,
        1,
      );
      if (!path) {
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
      if (
        world.map.resource[tile] !== RESOURCE_CODE[recipe.resource] ||
        world.map.resourceAmt[tile]! <= 0
      ) {
        worker.task = { t: 'idle', until: world.tick }; // someone else finished it
        return;
      }
      const speedup =
        getModifier(world, 'workSpeed') *
        (buildingDef(b.type).nearDeposit ? getModifier(world, 'mineSpeed') : 1);
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

/** Nearest matching resource tile within radius of the building center. */
function findResourceTile(
  world: World,
  b: Building,
  code: TileResourceKind,
  radius: number,
): number {
  const c = centerOf(b);
  const cx = Math.floor(c.x);
  const cy = Math.floor(c.y);
  for (let r = 1; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (!inBounds(x, y)) continue;
        const i = tileIdx(x, y);
        if (world.map.resource[i] === code && world.map.resourceAmt[i]! > 0) return i;
      }
    }
  }
  return -1;
}

/** Bamboo groves slowly regrow on standing (uncleared) tiles. */
function regrow(world: World, rng: Rng): void {
  const map = world.map;
  for (let i = 0; i < map.resource.length; i++) {
    if (map.resource[i] === TileResource.Bamboo && map.resourceAmt[i]! < BAMBOO_MAX_AMT) {
      if (rng.next() < 0.1) map.resourceAmt[i] = map.resourceAmt[i]! + 1;
    }
  }
}

/** Assign a freshly spawned worker to its completed building (units.ts hook). */
export function bindWorker(b: Building, worker: Unit): void {
  b.workerId = worker.id;
  worker.homeId = b.id;
}
