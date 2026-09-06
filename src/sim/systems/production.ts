import type {Enum} from '../../shared/enum.ts';
import {tileX, tileY} from '../../shared/grid.ts';
import {Rng} from '../../shared/rng.ts';
import {atBuilding, atTile, walkToBuilding, walkToTile} from '../arrival.ts';
import * as BuildingState from '../buildingStateEnum.ts';
import {WOOD_MAX_AMT, REGROW_INTERVAL} from '../defs/balance.ts';
import {
  OUTPUT_CAP,
  TOOL_GOODS,
  TOOL_OF,
  buildingDef,
  convertRecipeOf,
  gatherOrigin,
  type BuildingDef,
  type Recipe,
} from '../defs/buildings.ts';
import * as BuildingTypeId from '../defs/buildingTypeIdEnum.ts';
import * as GoodId from '../defs/goodIdEnum.ts';
import {goodEntries} from '../defs/goods.ts';
import * as ModifierKey from '../defs/modifierKeyEnum.ts';
import * as RecipeKind from '../defs/recipeKindEnum.ts';
import * as UnitTypeId from '../defs/unitTypeIdEnum.ts';
import type {Building} from '../entities.ts';
import {findResourcesNear} from '../map.ts';
import {findPathToAdjacent} from '../path.ts';
import {getModifier} from '../techHelpers.ts';
import * as TileResource from '../tileResourceEnum.ts';
import type {Unit} from '../units.ts';
import * as UnitTaskKind from '../unitTaskKindEnum.ts';
import {depleteResourceTile, type World} from '../world.ts';

type GoodId = Enum<typeof GoodId>;

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
    if (b.dead || b.state !== BuildingState.built || b.paused) continue;
    const def = buildingDef(b.type);
    const recipe = def.recipe ?? convertRecipeOf(def, b);
    // A Smith on auto (or holding only queue orders) has no standing
    // recipe, but its fire still burns: convertStep resolves what to
    // forge at each batch start and ticks the batch already running.
    if (!recipe && !def.recipeOptions) continue;
    // Population economy: no worker at the post, no production. (Gather
    // recipes are inherently worker-driven; converts pause too, mid-batch
    // included, until the staffing system delivers a replacement.)
    if (def.workerKind !== undefined) {
      const worker =
        b.workerId !== undefined ? world.units.get(b.workerId) : undefined;
      if (!worker || worker.dead) continue;
    }
    if (recipe?.kind === RecipeKind.gather) gatherStep(world, b, recipe);
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
  recipe: (Recipe & {kind: RecipeKind.convert}) | undefined,
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
      if (started) {
        for (const [good, n] of goodEntries(started.outputs)) {
          b.stock[good] = (b.stock[good] ?? 0) + n;
          world.ledger.produced[good] = (world.ledger.produced[good] ?? 0) + n;
        }
      }
      // The queue order this batch worked off comes off the board. First
      // started only — at most one is ever lit, and a cancelled order was
      // already struck (its batch still lands, via prodRecipeIndex).
      const slot = b.forgeQueue?.findIndex(o => o.started) ?? -1;
      if (slot >= 0) {
        b.forgeQueue!.splice(slot, 1);
        if (b.forgeQueue!.length === 0) b.forgeQueue = undefined;
      }
      b.prodTicksLeft = undefined;
      b.prodRecipeIndex = undefined;
    }
    return;
  }

  // What goes on the fire: the fixed recipe, or — at a Smith — the queue,
  // then the standing order, then auto (see pickForgeBatch).
  let active = recipe;
  let queueSlot = -1;
  let activeIndex: number | undefined;
  if (def.recipeOptions) {
    // Ingredients before intentions: see anyOptionReady. Nothing below this
    // point writes until the picked recipe's inputs have been checked, so a
    // buffer that can feed no option at all stops here with the same effect
    // and none of the survey.
    if (!anyOptionReady(b, def)) return;
    const pick = pickForgeBatch(world, b, def);
    if (!pick) return; // nothing workable — the fire stays cold
    activeIndex = pick.index;
    queueSlot = pick.queueSlot;
    active = def.recipeOptions[pick.index]!.recipe;
  }
  if (!active) return;

  // Cached entry lists (see recipeInputs): every converter in the village
  // walks these three loops on every tick it is not mid-batch, and
  // output-full and waiting-on-ingredients are the steady states, so the
  // tuples were being allocated and thrown away wholesale.
  const outputs = recipeEntries(active.outputs);
  for (let i = 0; i < outputs.length; i++) {
    const [good, n] = outputs[i]!;
    if ((b.stock[good] ?? 0) + n > OUTPUT_CAP) return; // output full — stall
  }
  const inputs = recipeInputs(active);
  for (let i = 0; i < inputs.length; i++) {
    const [good, n] = inputs[i]!;
    if ((b.inputs[good] ?? 0) < n) return; // waiting on ingredients
  }
  for (let i = 0; i < inputs.length; i++) {
    const [good, n] = inputs[i]!;
    b.inputs[good] = (b.inputs[good] ?? 0) - n;
    world.ledger.consumed[good] = (world.ledger.consumed[good] ?? 0) + n;
  }
  const speedup =
    getModifier(world, b.owner, ModifierKey.workSpeed) *
    (b.type === BuildingTypeId.wheatFarm
      ? getModifier(world, b.owner, ModifierKey.farmSpeed)
      : 1) *
    (b.type === BuildingTypeId.mill || b.type === BuildingTypeId.bakery
      ? getModifier(world, b.owner, ModifierKey.foodSpeed)
      : 1) *
    (b.type === BuildingTypeId.weaponsmith
      ? getModifier(world, b.owner, ModifierKey.forgeSpeed)
      : 1);
  b.prodTicksLeft = Math.max(1, Math.round(active.durationTicks / speedup));
  if (def.recipeOptions) {
    b.prodRecipeIndex = activeIndex;
    if (queueSlot >= 0) b.forgeQueue![queueSlot]!.started = true;
  }
}

/** Whether this option is researched (an unlockable recipe never re-locks,
 * but a garbled save or a mod could hand us any index — check both). */
function optionUnlocked(
  world: World,
  owner: number,
  def: BuildingDef,
  index: number,
): boolean {
  const opt = def.recipeOptions?.[index];
  if (!opt) return false;
  if (opt.requiresTech === undefined) return true;
  return (
    world.players[owner]?.techs.researched.includes(opt.requiresTech) ?? false
  );
}

function inputsPresent(
  b: Building,
  recipe: Recipe & {kind: RecipeKind.convert},
): boolean {
  const inputs = recipeInputs(recipe);
  for (let i = 0; i < inputs.length; i++) {
    const [good, n] = inputs[i]!;
    if ((b.inputs[good] ?? 0) < n) return false;
  }
  return true;
}

/**
 * A recipe's goods as an entry list, computed once. Recipes are static
 * table data, so `Object.entries` returns the same pairs in the same
 * (insertion) order every time — caching the first answer is the same walk
 * in the same order, without the array-of-tuples it used to allocate on
 * every check.
 */
const recipeEntriesCache = new WeakMap<object, [GoodId, number][]>();
function recipeEntries(
  goods: Partial<Record<GoodId, number>>,
): [GoodId, number][] {
  let entries = recipeEntriesCache.get(goods);
  if (!entries) {
    entries = goodEntries(goods);
    recipeEntriesCache.set(goods, entries);
  }
  return entries;
}

function recipeInputs(
  recipe: Recipe & {kind: RecipeKind.convert},
): [GoodId, number][] {
  return recipeEntries(recipe.inputs);
}

/**
 * Eat one load's worth. The meal is bought in whole loaves — one food
 * opens a ration covering `per` loads — so the charge lands on the first
 * load after the last one ran out and the rest of the seam is walked on
 * credit already paid.
 *
 * A ration handed to a post that has somehow lost its bread between the
 * pantry check and the face is not conjured: the load still lands (it is
 * already on the worker's shoulders and in the ledger) and the counter
 * stays at zero, so the NEXT trip is the one that waits.
 */
function chargeRation(
  world: World,
  b: Building,
  ration: {good: GoodId; per: number},
): void {
  if (b.rationLeft) {
    b.rationLeft--;
    return;
  }
  if ((b.inputs[ration.good] ?? 0) < 1) return;
  b.inputs[ration.good] = (b.inputs[ration.good] ?? 0) - 1;
  world.ledger.consumed[ration.good] =
    (world.ledger.consumed[ration.good] ?? 0) + 1;
  b.rationLeft = ration.per - 1;
}

/**
 * Could ANY of this building's recipe options light the fire right now?
 *
 * convertStep bails on exactly this test ("waiting on ingredients") a few
 * lines after it has resolved what to forge — and at a Smith, resolving
 * that means autoForgeIndex's census of every building in the settlement.
 * A Smith starved of iron therefore used to survey the whole village
 * twenty times a second to be told again that it has no iron. This is the
 * same necessary condition, asked first: if no option's ingredients are in
 * the buffer then the picked one's cannot be either, so convertStep would
 * return without writing anything.
 */
function anyOptionReady(b: Building, def: BuildingDef): boolean {
  const options = def.recipeOptions!;
  for (let i = 0; i < options.length; i++) {
    if (inputsPresent(b, options[i]!.recipe)) return true;
  }
  return false;
}

/**
 * The Smith's next batch: queue over standing order over auto.
 *
 * The queue mirrors the barracks — the first unstarted order whose recipe
 * is unlocked and whose ingredients sit in the buffer takes the fire, so a
 * later order can jump one starved for iron. Orders that are queued but
 * unready HOLD the fire rather than falling through: the player asked for
 * these things next, and burning their iron on the standing order while
 * they wait would be the sim overruling him.
 */
function pickForgeBatch(
  world: World,
  b: Building,
  def: BuildingDef,
): {index: number; queueSlot: number} | undefined {
  if (b.forgeQueue && b.forgeQueue.length > 0) {
    // Orders and standing selections were tech-checked when the command
    // landed (tick.ts), and a tech never un-researches — no re-check here,
    // matching how the standing order always ran.
    const slot = b.forgeQueue.findIndex(
      o =>
        !o.started &&
        def.recipeOptions![o.recipeIndex] !== undefined &&
        inputsPresent(b, def.recipeOptions![o.recipeIndex]!.recipe),
    );
    if (slot < 0) return undefined;
    return {index: b.forgeQueue[slot]!.recipeIndex, queueSlot: slot};
  }
  if (b.recipeIndex !== undefined) {
    if (!def.recipeOptions?.[b.recipeIndex]) return undefined;
    return {index: b.recipeIndex, queueSlot: -1};
  }
  const auto = autoForgeIndex(world, b, def);
  return auto === undefined ? undefined : {index: auto, queueSlot: -1};
}

/**
 * Auto: forge the tool the village most lacks. gap(tool) = posts standing
 * open for it minus tools already free to reach them; the largest positive
 * gap wins and ties break on GOODS order (TOOL_GOODS follows it). All gaps
 * covered means the fire goes cold — an idle Smith is cheaper than a shelf
 * of surplus axes forged out of scarce iron.
 *
 * Integer counts over world state only — this runs inside the tick and
 * must resolve identically on every client.
 */
export function autoForgeIndex(
  world: World,
  b: Building,
  def: BuildingDef,
): number | undefined {
  // Scratch, reused across calls. An idle Smith asks this question twice a
  // tick forever (production for the fire, logistics for the demand), and
  // the two goods dictionaries it used to allocate — then hash-write once
  // per tool per building — made this the single hottest function in the
  // sim. Slot-indexed counts are the same integer arithmetic, and integer
  // addition does not care what order the buildings come in, so the answer
  // is identical to the dictionary version's.
  want.fill(0);
  free.fill(0);
  const owner = b.owner;
  for (const ob of world.buildings.values()) {
    if (ob.dead || ob.owner !== owner) continue;
    if (ob.state === BuildingState.site) {
      // A site still owed its hammer is a hammer the village lacks.
      if (
        !ob.paused &&
        (ob.siteNeeds?.[GoodId.hammer] ?? 0) > 0 &&
        (ob.inbound[GoodId.hammer] ?? 0) === 0
      ) {
        want[HAMMER_SLOT] = want[HAMMER_SLOT]! + 1;
      }
      continue;
    }
    if (ob.state !== BuildingState.built) continue;
    const stock = ob.stock;
    const reservedOut = ob.reservedOut;
    for (let i = 0; i < TOOL_COUNT; i++) {
      // Tools on a shelf (minus those already promised to a hauler) can
      // still reach any open post, wherever they sit.
      const tool = TOOL_GOODS[i]!;
      const shelf = (stock[tool] ?? 0) - (reservedOut[tool] ?? 0);
      if (shelf > 0) free[i] = free[i]! + shelf; // adding a clamped zero changes nothing
    }
    const tool = TOOL_OF[ob.type];
    if (!tool || ob.paused) continue;
    const worker =
      ob.workerId !== undefined ? world.units.get(ob.workerId) : undefined;
    if (worker && !worker.dead) continue; // post is filled
    if ((ob.inputs[tool] ?? 0) + (ob.inbound[tool] ?? 0) > 0) continue; // already served
    const slot = TOOL_SLOT[tool]!;
    want[slot] = want[slot]! + 1;
  }
  const byTool = forgeIndexByTool(def);
  let bestIndex = -1;
  let bestGap = 0;
  for (let i = 0; i < TOOL_COUNT; i++) {
    const gap = want[i]! - free[i]!;
    if (gap > bestGap) {
      const index = byTool[i]!;
      if (index < 0 || !optionUnlocked(world, owner, def, index)) continue;
      bestIndex = index;
      bestGap = gap;
    }
  }
  return bestIndex < 0 ? undefined : bestIndex;
}

const TOOL_COUNT = TOOL_GOODS.length;
/** Slot of each tool in TOOL_GOODS, so a GoodId can index the count arrays. */
const TOOL_SLOT: Partial<Record<GoodId, number>> = {};
for (let i = 0; i < TOOL_COUNT; i++) TOOL_SLOT[TOOL_GOODS[i]!] = i;
const HAMMER_SLOT = TOOL_SLOT[GoodId.hammer]!;
/** Counts, not sums of measurements: whole tools, so exact as doubles. */
const want = new Float64Array(TOOL_COUNT);
const free = new Float64Array(TOOL_COUNT);

/**
 * Which recipe option forges each tool, by tool slot; -1 for a tool this
 * building cannot make. `recipeOptions` is static table data, so the answer
 * is computed once per building def rather than re-scanned per tool per call.
 */
const forgeIndexCache = new WeakMap<BuildingDef, Int32Array>();
function forgeIndexByTool(def: BuildingDef): Int32Array {
  let byTool = forgeIndexCache.get(def);
  if (byTool) return byTool;
  byTool = new Int32Array(TOOL_COUNT);
  for (let i = 0; i < TOOL_COUNT; i++) {
    const tool = TOOL_GOODS[i]!;
    byTool[i] =
      def.recipeOptions?.findIndex(o => (o.recipe.outputs[tool] ?? 0) > 0) ??
      -1;
  }
  forgeIndexCache.set(def, byTool);
  return byTool;
}

/**
 * What a Smith wants delivered: the inputs of whatever it would forge
 * next — the first unstarted queue order, else the standing order, else
 * auto's pick. Logistics tops these up like any converter's; undefined
 * (auto with every gap covered) raises no demand at all.
 */
export function forgeDemandRecipe(
  world: World,
  b: Building,
  def: BuildingDef,
): (Recipe & {kind: RecipeKind.convert}) | undefined {
  const queued = b.forgeQueue?.find(
    o => !o.started && def.recipeOptions?.[o.recipeIndex] !== undefined,
  );
  if (queued) return def.recipeOptions![queued.recipeIndex]!.recipe;
  if (b.recipeIndex !== undefined)
    return def.recipeOptions?.[b.recipeIndex]?.recipe;
  const auto = autoForgeIndex(world, b, def);
  return auto === undefined ? undefined : def.recipeOptions![auto]!.recipe;
}

function gatherStep(
  world: World,
  b: Building,
  recipe: Recipe & {kind: RecipeKind.gather},
): void {
  const worker =
    b.workerId !== undefined ? world.units.get(b.workerId) : undefined;
  if (!worker || worker.dead) return;

  switch (worker.task.t) {
    case UnitTaskKind.idle: {
      if (world.tick < worker.task.until) return;
      // Still holding the last trip's output — the walk home gave up short.
      // Get it in before starting another trip: gatherWork writes `carrying`
      // outright, so a second load would overwrite the first and the
      // conservation ledger would come up a good short.
      if (worker.carrying !== undefined) {
        if (!walkToBuilding(world.map, worker, b)) {
          worker.task = {t: UnitTaskKind.idle, until: world.tick + 40};
          return;
        }
        worker.task = {t: UnitTaskKind.gatherHome};
        return;
      }
      // Output full? Wait — full buffers stall production (Settlers rule).
      if ((b.stock[recipe.output] ?? 0) >= OUTPUT_CAP) {
        worker.task = {t: UnitTaskKind.idle, until: world.tick + 20};
        return;
      }
      // Nothing in the pantry, nobody down the shaft. The meal is checked
      // here and paid for at the face (below): a miner is not sent out on
      // a ration the village cannot cover, and a trip that comes back
      // empty has not eaten one. Idle rather than dismissed — the post
      // keeps its worker and its pick, and picks straight back up when
      // the bread arrives.
      if (
        recipe.ration &&
        !b.rationLeft &&
        (b.inputs[recipe.ration.good] ?? 0) < 1
      ) {
        worker.task = {t: UnitTaskKind.idle, until: world.tick + 20};
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
        recipe.resource,
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
        worker.task = {t: UnitTaskKind.idle, until: world.tick + 40};
        return;
      }
      worker.path = path;
      worker.pathIdx = 0;
      worker.task = {t: UnitTaskKind.gatherOut, tile};
      return;
    }
    case UnitTaskKind.gatherOut: {
      if (worker.path !== null) return; // walking
      const tile = worker.task.tile;
      // Only a worker standing at the tile may work it — a walk cut short by
      // new construction would otherwise fell a tree from across the valley.
      if (!atTile(worker, tile, world.map.size)) {
        if (!walkToTile(world.map, worker, tile)) {
          worker.task = {t: UnitTaskKind.idle, until: world.tick + 40};
        }
        return;
      }
      if (
        world.map.resource[tile] !== recipe.resource ||
        world.map.resourceAmt[tile]! <= 0
      ) {
        worker.task = {t: UnitTaskKind.idle, until: world.tick}; // someone else finished it
        return;
      }
      const speedup =
        getModifier(world, b.owner, ModifierKey.workSpeed) *
        (buildingDef(b.type).mine
          ? getModifier(world, b.owner, ModifierKey.mineSpeed)
          : 1);
      worker.task = {
        t: UnitTaskKind.gatherWork,
        tile,
        until: world.tick + Math.max(1, Math.round(recipe.workTicks / speedup)),
      };
      return;
    }
    case UnitTaskKind.gatherWork: {
      if (world.tick < worker.task.until) return;
      const tile = worker.task.tile;
      if (world.map.resource[tile] === recipe.resource) {
        depleteResourceTile(world, tile);
        worker.carrying = recipe.output;
        // The good exists from the moment it's chopped (it's on the worker's
        // shoulders and countable) — ledger it here, not at deposit.
        world.ledger.produced[recipe.output] =
          (world.ledger.produced[recipe.output] ?? 0) + 1;
        // ...and the ration is spent against the load it bought. A fresh
        // meal is swallowed whole and covers the next `per` loads; the
        // pantry was checked before he set out, and nothing else eats a
        // mine's input buffer, so it is still there.
        if (recipe.ration) chargeRation(world, b, recipe.ration);
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
      worker.task = {t: UnitTaskKind.gatherHome};
      return;
    }
    case UnitTaskKind.gatherHome: {
      if (worker.path !== null) return; // walking
      // Not home yet: the load goes in the hut's stock, not through its wall.
      // Idling with it in hand is safe — the idle case above walks him back
      // rather than sending him out again on top of it.
      if (!atBuilding(worker, b)) {
        if (!walkToBuilding(world.map, worker, b)) {
          worker.task = {t: UnitTaskKind.idle, until: world.tick + 40};
        }
        return;
      }
      if (worker.carrying !== undefined) {
        b.stock[worker.carrying] = (b.stock[worker.carrying] ?? 0) + 1;
        worker.carrying = undefined;
      }
      worker.task = {t: UnitTaskKind.idle, until: world.tick + 10};
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
    if (
      map.resource[i] === TileResource.Wood &&
      map.resourceAmt[i]! < WOOD_MAX_AMT
    ) {
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
 * Hand the post's tool to the man taking it up: consumed out of the input
 * buffer the way a barracks weapon is consumed by a recruit. True if the
 * post needs no tool or one was there to take; false means the recruit
 * arrived to an empty rack (the axe was lost or re-routed while he walked)
 * and must stand down. Voluntary departures hand it back — see unbindWorker.
 */
export function consumePostTool(world: World, b: Building): boolean {
  const tool = TOOL_OF[b.type];
  if (!tool) return true;
  if ((b.inputs[tool] ?? 0) < 1) return false;
  b.inputs[tool] = (b.inputs[tool] ?? 0) - 1;
  world.ledger.consumed[tool] = (world.ledger.consumed[tool] ?? 0) + 1;
  return true;
}

/**
 * The inverse: the worker walks off the job and rejoins the serf pool, and
 * the building goes back to wanting one (staffing will recruit again). Both
 * sides are cleared together — the invariants check that workerId and homeId
 * always point at each other.
 *
 * Rejoining the pool means reading idle, and that is the whole point of the
 * task reset. A gather task is driven by the BUILDING (gatherStep runs off
 * b.workerId), so a hand released mid-trip keeps a `gatherWork` nothing will
 * ever advance — and dispatch, staffing and wander all want a genuinely idle
 * unit, so nobody ever picks him up again. He stands in the field forever,
 * counted against the population and eating, doing nothing. Two callers
 * (releaseObsoletePosts, the move order in tick.ts) already knew to reset the
 * task by hand and said so in their comments; the dismiss order (since folded
 * into pausing) and `sellBuilding` did not, and both leaked a hand per use.
 * Doing it here means the next caller cannot forget.
 *
 * Whatever is in his hands stays there — logistics has a path for a free serf
 * still holding a good (rehomeCarriedGoods).
 */
export function unbindWorker(world: World, worker: Unit): void {
  const home =
    worker.homeId !== undefined
      ? world.buildings.get(worker.homeId)
      : undefined;
  if (home && home.workerId === worker.id) {
    home.workerId = undefined;
    // Every unbind is a voluntary departure (dismiss, sell, a move order,
    // an obsolete post) — the man leaves the post's tool on the shelf,
    // where evacuation hauls it home for whoever needs it next. Into
    // stock rather than back into the input rack on purpose: a dismissal
    // is usually the player freeing the tool as much as the man. Death
    // never comes through here: a killed worker drops the tool where he
    // falls instead (killUnit), a salvage pile the village must hold the
    // ground to recover.
    const tool = TOOL_OF[home.type];
    if (tool && !home.dead && home.state === BuildingState.built) {
      home.stock[tool] = (home.stock[tool] ?? 0) + 1;
      world.ledger.produced[tool] = (world.ledger.produced[tool] ?? 0) + 1;
    }
  }
  worker.homeId = undefined;
  worker.kind = UnitTypeId.serf;
  worker.task = {t: UnitTaskKind.idle, until: world.tick};
}
