import type {Enum} from '../shared/enum.ts';
import {inBounds, tileIdx, tileX, tileY} from '../shared/grid.ts';
import {Rng} from '../shared/rng.ts';
import * as AdminAction from './adminActionEnum.ts';
import * as BuildingState from './buildingStateEnum.ts';
import * as CommandKind from './commandKindEnum.ts';
import type {SimCommand} from './commands.ts';
import {
  CORPSE_TICKS,
  FORGE_QUEUE_CAP,
  HIRE_QUEUE_CAP,
  HIRE_SERF_COST,
} from './defs/balance.ts';
import {AUTO_RECIPE, TOOL_OF, buildingDef} from './defs/buildings.ts';
import * as GoodId from './defs/goodIdEnum.ts';
import {GOODS, goodEntries} from './defs/goods.ts';
import {TECH_DEFS} from './defs/techs.ts';
import {UNIT_DEFS, UNIT_TYPES} from './defs/units.ts';
import {BANDIT, type Owner} from './entities.ts';
import * as GameEventKind from './gameEventKindEnum.ts';
import {findPath, nearestWalkable} from './path.ts';
import {hasRoomToHire} from './population.ts';
import {banditsSystem} from './systems/bandits.ts';
import {combatSystem} from './systems/combat.ts';
import {
  cancelRepair,
  constructionSystem,
  orderRepair,
} from './systems/construction.ts';
import {
  abortJob,
  logisticsSystem,
  findStorehouse,
} from './systems/logistics.ts';
import {movementSystem} from './systems/movement.ts';
import {productionSystem, unbindWorker} from './systems/production.ts';
import {researchSystem} from './systems/research.ts';
import {staffingSystem} from './systems/staffing.ts';
import {trailsSystem} from './systems/trails.ts';
import {
  trainingSystem,
  hiringSystem,
  enqueueTraining,
  cancelTraining,
  evictGarrison,
} from './systems/training.ts';
import {victorySystem} from './systems/victory.ts';
import {wanderSystem} from './systems/wander.ts';
import {canResearch, isBuildingUnlocked} from './techHelpers.ts';
import * as UnitTaskKind from './unitTaskKindEnum.ts';
import {
  canPlace,
  destroyBuilding,
  killUnit,
  placeSite,
  spawnUnit,
  type World,
} from './world.ts';

type AdminAction = Enum<typeof AdminAction>;
type GoodId = Enum<typeof GoodId>;

export {TICKS_PER_SECOND, TICK_MS} from './defs/balance.ts';

/**
 * A command plus the seat that issued it. In multiplayer the netcode layer
 * stamps playerId from the authenticated connection and presents the tick's
 * commands in canonical (playerId, seq) order — never arrival order.
 */
export interface PlayerCommand {
  playerId: Owner;
  cmd: SimCommand;
}

/**
 * One fixed-timestep step. System order is deliberate and fixed; new systems
 * slot into this list as milestones land:
 * commands -> production -> logistics -> construction -> behaviors ->
 * movement -> trails -> removeDead.
 */
export function tickWorld(
  world: World,
  commands: readonly PlayerCommand[],
): void {
  const rng = new Rng(world.rngState);

  for (const c of commands) {
    // One order must never be able to stop the world. Commands are screened
    // before they get here (sanitizeCommand), so a throw means a sim bug
    // rather than a hostile frame — but on the server this loop runs inside
    // a pump shared by every live match, and killing that process to report
    // a bug in one of them is the worse trade. Deterministic either way:
    // the same command against the same world throws for every observer.
    try {
      applyCommand(world, c.playerId, c.cmd);
    } catch (err) {
      console.error(
        `[sim] command ${c.cmd.kind} from player ${c.playerId} failed:`,
        err,
      );
    }
  }

  researchSystem(world);
  productionSystem(world, rng);
  logisticsSystem(world);
  constructionSystem(world);
  staffingSystem(world);
  trainingSystem(world);
  hiringSystem(world);
  wanderSystem(world, rng);
  movementSystem(world);
  combatSystem(world);
  banditsSystem(world, rng);
  trailsSystem(world);
  victorySystem(world);
  removeDead(world);

  world.rngState = rng.state;
  world.tick++;
}

/**
 * Apply one command as the given player. Exported: the AI system issues its
 * decisions through the exact same validation path as human commands.
 */
export function applyCommand(
  world: World,
  playerId: Owner,
  cmd: SimCommand,
): void {
  const player = world.players[playerId];
  if (!player || !player.alive) return; // eliminated players spectate
  switch (cmd.kind) {
    case CommandKind.moveUnits:
      applyMoveUnits(world, playerId, cmd);
      break;
    case CommandKind.placeBuilding:
      if (
        !buildingDef(cmd.building).systemOnly &&
        // Storehouses are the elimination token — never buildable.
        !buildingDef(cmd.building).storage &&
        isBuildingUnlocked(world, playerId, cmd.building) &&
        canPlace(world.map, cmd.building, cmd.x, cmd.y)
      ) {
        placeSite(world, cmd.building, playerId, cmd.x, cmd.y);
      }
      break;
    case CommandKind.trainUnit: {
      const b = world.buildings.get(cmd.buildingId);
      if (b && b.owner === playerId) enqueueTraining(world, b, cmd.unit);
      break;
    }
    case CommandKind.cancelTraining: {
      const b = world.buildings.get(cmd.buildingId);
      if (b && !b.dead && b.owner === playerId)
        cancelTraining(world, b, cmd.index, cmd.unit);
      break;
    }
    case CommandKind.setRallyPoint: {
      // The barracks' muster flag: fresh soldiers march to it as they step
      // out of the door. Only buildings that train take one — a flag on a
      // bakery would be an order nothing ever reads. The tile is checked
      // for bounds, not walkability: the flag means "near there", and the
      // spawn does its own nearest-walkable search (marchToRally), the same
      // forgiveness a move order's target gets.
      const b = world.buildings.get(cmd.buildingId);
      if (!b || b.dead || b.owner !== playerId) break;
      if (!buildingDef(b.type).trains) break;
      // Both coordinates absent is the take-the-flag-down order; a
      // half-given pair changes nothing — the same reading sanitizeCommand
      // gives the wire, kept here too so a caller that skipped screening
      // (the AI issues through applyCommand directly) cannot strike a
      // standing flag with a malformed plant.
      if (cmd.x === undefined && cmd.y === undefined) {
        b.rally = undefined;
        break;
      }
      if (cmd.x === undefined || cmd.y === undefined) break;
      if (!inBounds(cmd.x, cmd.y, world.map.size)) break;
      b.rally = {x: cmd.x, y: cmd.y};
      break;
    }
    case CommandKind.herald: {
      // A taunt with an address: validated here rather than trusted — the
      // target must be a living rival, and a herald to nobody says nothing.
      const target = world.players[cmd.target];
      if (!target || !target.alive || cmd.target === playerId) break;
      world.pendingEvents.push({
        kind: GameEventKind.heraldIncoming,
        player: cmd.target,
        attacker: playerId,
        note: cmd.note,
        ...(cmd.count !== undefined ? {count: cmd.count} : {}),
      });
      break;
    }
    case CommandKind.admin:
      if (world.admin.enabled) applyAdmin(world, playerId, cmd.action);
      break;
    case CommandKind.research: {
      if (!canResearch(world, playerId, cmd.tech).ok) break;
      const sh = findStorehouse(world, playerId);
      const cost = TECH_DEFS[cmd.tech].cost;
      if (!sh) break;
      const affordable = goodEntries(cost).every(
        ([good, n]) => (sh.stock[good] ?? 0) >= n,
      );
      if (!affordable) break;
      for (const [good, n] of goodEntries(cost)) {
        sh.stock[good] = (sh.stock[good] ?? 0) - n;
        world.ledger.consumed[good] = (world.ledger.consumed[good] ?? 0) + n;
      }
      player.techs.active = {
        tech: cmd.tech,
        ticksLeft: TECH_DEFS[cmd.tech].durationTicks,
      };
      break;
    }
    case CommandKind.setBuildingPaused: {
      // Halt the workshop without breaking it up: production, input hauls
      // and construction progress stop, and any finished stock still
      // evacuates. The lever for 'the bowyer is eating all my wood'.
      const b = world.buildings.get(cmd.buildingId);
      if (!b || b.dead || b.owner !== playerId) break;
      const def = buildingDef(b.type);
      if (def.storage || def.isRoad || def.systemOnly) break;
      b.paused = cmd.paused || undefined;
      // Halting also empties the post: the resident (or the site's builder)
      // rejoins the serf pool, so the one lever is both 'stop eating my
      // wood' and 'give me the hands back' — the escape hatch when the
      // loose pool is empty and something new must get built. No backoff is
      // needed: a halted post summons nobody for as long as it stands
      // halted, and starting it again is what asks for a worker back.
      if (cmd.paused && b.workerId !== undefined) {
        const worker = world.units.get(b.workerId);
        if (worker && !worker.dead) unbindWorker(world, worker);
      }
      // On a tower the lever is the whole roof: halting empties it and
      // stops it calling anyone else up, villagers and soldiers alike.
      //
      // Soldiers used to be exempt — an idle archer costs the village
      // nothing, so there was said to be no reason to send one down. But
      // that left the order describing a tower that was manned and shooting,
      // over a lever that then moved nobody for the rest of the match: a
      // standing tower's archers never came down, and no villager is ever
      // let up beside one. The two men on the roof are two men not standing
      // with the army, and deciding that is the whole point of the lever.
      // Starting it again calls them straight back up.
      if (cmd.paused && def.garrison) evictGarrison(world, b, b.garrison ?? 0);
      break;
    }
    case CommandKind.setBuildingRepair: {
      // Mend the walls: the building calls for materials like a site and
      // heals as they arrive. The bill is struck against the damage it has
      // right now, so a building that keeps taking hits is ordered again
      // rather than mended for free.
      const b = world.buildings.get(cmd.buildingId);
      if (!b || b.dead || b.owner !== playerId) break;
      if (cmd.repair) orderRepair(world, b);
      else cancelRepair(world, b);
      break;
    }
    case CommandKind.setBuildingRecipe: {
      // The forge's standing order: what the Smith works on when its queue
      // is empty. AUTO_RECIPE (-1) clears it — the Smith forges whatever
      // tool the village most lacks. Gated per option (bows need archery,
      // iron work needs ironworking); a batch already on the fire finishes
      // as what it started as.
      const b = world.buildings.get(cmd.buildingId);
      if (!b || b.dead || b.owner !== playerId) break;
      if (cmd.index === AUTO_RECIPE) {
        if (buildingDef(b.type).recipeOptions) b.recipeIndex = undefined;
        break;
      }
      const opt = buildingDef(b.type).recipeOptions?.[cmd.index];
      if (!opt) break;
      if (
        opt.requiresTech !== undefined &&
        !(
          world.players[playerId]?.techs.researched.includes(
            opt.requiresTech,
          ) ?? false
        )
      ) {
        break;
      }
      b.recipeIndex = cmd.index;
      break;
    }
    case CommandKind.enqueueForge: {
      // A forge order jumps the standing order: the queue is worked first,
      // batch by batch, then the Smith falls back to recipeIndex/auto.
      // Nothing is paid at enqueue — inputs are consumed at batch start,
      // exactly like every other convert batch.
      const b = world.buildings.get(cmd.buildingId);
      if (
        !b ||
        b.dead ||
        b.owner !== playerId ||
        b.state !== BuildingState.built
      )
        break;
      const opt = buildingDef(b.type).recipeOptions?.[cmd.recipeIndex];
      if (!opt) break;
      if (
        opt.requiresTech !== undefined &&
        !(
          world.players[playerId]?.techs.researched.includes(
            opt.requiresTech,
          ) ?? false
        )
      ) {
        break;
      }
      b.forgeQueue ??= [];
      if (b.forgeQueue.length >= FORGE_QUEUE_CAP) break;
      b.forgeQueue.push({recipeIndex: cmd.recipeIndex, started: false});
      break;
    }
    case CommandKind.cancelForge: {
      // Both the slot and what the player thinks is in it (cancelTraining's
      // rule): a stale click after the queue shifted must miss rather than
      // cancel a neighbour. A started batch is not refunded — it finishes
      // as what it started as; cancelling only strikes the queue entry, so
      // the goods on the fire still land.
      const b = world.buildings.get(cmd.buildingId);
      if (!b || b.dead || b.owner !== playerId || !b.forgeQueue) break;
      const item = b.forgeQueue[cmd.index];
      if (!item || item.recipeIndex !== cmd.recipeIndex) break;
      if (item.started) {
        // The batch on the fire keeps burning (prodRecipeIndex is already
        // stamped); dropping the entry just means nothing re-queues it.
        b.prodRecipeIndex ??= item.recipeIndex;
      }
      b.forgeQueue.splice(cmd.index, 1);
      if (b.forgeQueue.length === 0) b.forgeQueue = undefined;
      break;
    }
    case CommandKind.sellBuilding: {
      // Tear a building down for half its cost back, floored per good.
      // Sites refund half of what was actually delivered. The resident
      // walks out a serf again before the wrecking starts — demolition is
      // an economic decision, not an execution. The storehouse is not
      // sellable: it is the elimination token, and cashing it in would be
      // resigning for pocket change.
      const b = world.buildings.get(cmd.buildingId);
      if (!b || b.dead || b.owner !== playerId) break;
      const def = buildingDef(b.type);
      if (def.storage || def.isRoad || def.systemOnly) break;
      if (b.workerId !== undefined) {
        const worker = world.units.get(b.workerId);
        if (worker && !worker.dead) unbindWorker(world, worker);
      }
      // The garrison marches out before the wreckers move in — the same
      // rule the resident gets, and for the same reason: tearing a tower
      // down is an economic decision, not an execution.
      evictGarrison(world, b, b.garrison ?? 0);
      const sh = findStorehouse(world, playerId);
      if (sh) {
        for (const [good, n] of goodEntries(def.cost)) {
          const delivered =
            b.state === BuildingState.site ? n - (b.siteNeeds?.[good] ?? 0) : n;
          const refund = Math.floor(delivered / 2);
          if (refund <= 0) continue;
          sh.stock[good] = (sh.stock[good] ?? 0) + refund;
          // Ledgered as production so the conservation invariant stays
          // honest — the same bookkeeping grantGoods uses.
          world.ledger.produced[good] =
            (world.ledger.produced[good] ?? 0) + refund;
        }
        // The kit walks away from the wreck: the post's own tool (left on
        // the shelf by the unbind above, or still waiting in the rack of a
        // post that never staffed) and the hammer a half-built site had
        // borrowed — so the hammer only rides along for a SITE, where it
        // is a loan and nothing else. Unconditional, it also walked a
        // built Smith's forged hammers out of the sale while the axes and
        // cauldrons on the same shelf were lost, and the rule two lines up
        // is the rule: a sold Smith loses its forged stock the way a sold
        // bakery loses its bread. A move, not a mint, so no ledger entry.
        const rescue = new Set<GoodId>();
        if (b.state === BuildingState.site) rescue.add(GoodId.hammer);
        const postTool = TOOL_OF[b.type];
        if (postTool) rescue.add(postTool);
        for (const good of rescue) {
          const n = (b.stock[good] ?? 0) + (b.inputs[good] ?? 0);
          if (n <= 0) continue;
          sh.stock[good] = (sh.stock[good] ?? 0) + n;
          b.stock[good] = 0;
          b.inputs[good] = 0;
        }
      }
      destroyBuilding(world, b);
      break;
    }
    case CommandKind.hireSerf: {
      // Pay now, arrive later: the recruit is summoned, not conjured. The
      // hiring system walks the queue down and drops them at the door.
      // A recruit already on the road holds their bed, so ordering five at
      // once cannot overshoot the cap by four.
      const sh = findStorehouse(world, playerId);
      if (
        sh &&
        (sh.stock[GoodId.silver] ?? 0) >= HIRE_SERF_COST &&
        (sh.hireQueue ?? 0) < HIRE_QUEUE_CAP &&
        hasRoomToHire(world, playerId)
      ) {
        sh.stock[GoodId.silver] =
          (sh.stock[GoodId.silver] ?? 0) - HIRE_SERF_COST;
        world.ledger.consumed[GoodId.silver] =
          (world.ledger.consumed[GoodId.silver] ?? 0) + HIRE_SERF_COST;
        sh.hireQueue = (sh.hireQueue ?? 0) + 1;
      }
      break;
    }
  }
}

function applyAdmin(world: World, playerId: Owner, action: AdminAction): void {
  switch (action) {
    case AdminAction.toggleRaids:
      world.admin.raidsEnabled = !world.admin.raidsEnabled;
      break;
    case AdminAction.clearBandits:
      for (const unit of world.units.values()) {
        if (unit.owner === BANDIT) killUnit(world, unit);
      }
      break;
    case AdminAction.grantGoods: {
      const sh = findStorehouse(world, playerId);
      if (!sh) break;
      for (const good of GOODS) {
        sh.stock[good] = (sh.stock[good] ?? 0) + 25;
        // Ledgered as production so the conservation invariant stays honest.
        world.ledger.produced[good] = (world.ledger.produced[good] ?? 0) + 25;
      }
      break;
    }
    case AdminAction.toggleInstantBuild:
      world.admin.instantBuild = !world.admin.instantBuild;
      break;
    case AdminAction.finishResearch: {
      const active = world.players[playerId]?.techs.active;
      if (active) active.ticksLeft = 1;
      break;
    }
    case AdminAction.spawnParade: {
      // One of each unit kind by the storehouse door — a visual test rig for
      // wardrobe and animation work. Issuer-owned so nobody starts a war.
      const sh = findStorehouse(world, playerId);
      if (!sh) break;
      UNIT_TYPES.forEach((k, i) => {
        spawnUnit(world, k, playerId, sh.x - 2.5 + i, sh.y + sh.h + 2.5);
      });
      break;
    }
  }
}

/**
 * Group moves fan out over the walkable tiles nearest the target (spiral
 * order) so squads don't stack on one tile. A right-click on an enemy
 * building is an attack order: military units take the same 'raid' task
 * bandits use, and the combat system does the rest. Ground orders come in
 * three kinds — an attack-move fights whatever it meets on the way, a plain
 * move ignores enemies until it arrives, and the 'half' order walks the
 * front half of the route as a plain move before turning attack-move.
 */
function applyMoveUnits(
  world: World,
  playerId: Owner,
  cmd: {unitIds: number[]; x: number; y: number; attack?: true | 'half'},
): void {
  const size = world.map.size;
  if (inBounds(cmd.x, cmd.y, size)) {
    const bId = world.map.buildingAt[tileIdx(cmd.x, cmd.y, size)]!;
    const target = bId >= 0 ? world.buildings.get(bId) : undefined;
    if (target && !target.dead && target.owner !== playerId) {
      for (const id of cmd.unitIds) {
        const unit = world.units.get(id);
        if (!unit || unit.dead || unit.owner !== playerId) continue;
        if (!UNIT_DEFS[unit.kind].combat) continue; // civilians don't storm camps
        unit.task = {t: UnitTaskKind.raid, buildingId: target.id};
        unit.targetId = target.id;
        unit.targetIsBuilding = true;
        unit.path = null;
      }
      return;
    }
  }
  const targets = collectSpreadTargets(world, cmd.x, cmd.y, cmd.unitIds.length);
  if (targets.length === 0) return;
  let t = 0;
  for (const id of cmd.unitIds) {
    const unit = world.units.get(id);
    if (!unit || unit.dead || unit.owner !== playerId) continue;
    const goal = targets[Math.min(t++, targets.length - 1)]!;
    const goalX = tileX(goal, size);
    const goalY = tileY(goal, size);
    const path = findPath(
      world.map,
      Math.floor(unit.x),
      Math.floor(unit.y),
      goalX,
      goalY,
    );
    // An order that cannot be walked changes nothing. Quitting first and
    // asking afterwards stranded a resident worker for good: unbindWorker
    // had already cleared homeId and turned him back into a serf, so
    // production no longer drove him, while his gather task stayed put —
    // and wander, dispatch and staffing all want a genuinely idle unit, so
    // nothing ever picked him up again.
    if (!path) continue;
    // A move order outranks whatever the unit was employed doing: a hauler
    // drops its job (reservations released, the good stays in his hands)
    // and a resident worker quits the post, freeing the building to recruit
    // again. Ignoring these orders meant that once the last serf took a
    // job the player had nobody left to command.
    if (unit.jobId !== undefined) {
      const job = world.jobs.get(unit.jobId);
      if (job) abortJob(world, job, 'reassigned by a move order', true);
      unit.jobId = undefined;
    }
    if (unit.homeId !== undefined) unbindWorker(world, unit);
    unit.path = path;
    unit.pathIdx = 0;
    // An attack-move keeps the combat system live on the way; civilians have
    // no combat to keep live, so for them every order is the same walk. The
    // 'half' order quiets the front leg of the route — far enough to carry a
    // fleeing squad clear of its fight before the order starts answering back.
    const engageIdx = Math.ceil(path.length / 2);
    unit.task =
      cmd.attack && UNIT_DEFS[unit.kind].combat
        ? cmd.attack === 'half' && engageIdx > 0
          ? {t: UnitTaskKind.attackMove, destX: goalX, destY: goalY, engageIdx}
          : {t: UnitTaskKind.attackMove, destX: goalX, destY: goalY}
        : {t: UnitTaskKind.move};
    // Explicit orders disengage combat; an attack-move re-acquires freely.
    unit.targetId = undefined;
    unit.targetIsBuilding = undefined;
  }
}

function collectSpreadTargets(
  world: World,
  x: number,
  y: number,
  count: number,
): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const first = nearestWalkable(world.map, x, y);
  if (first < 0) return out;
  const fx = tileX(first, world.map.size);
  const fy = tileY(first, world.map.size);
  for (let r = 0; r <= 6 && out.length < count; r++) {
    for (let dy = -r; dy <= r && out.length < count; dy++) {
      for (let dx = -r; dx <= r && out.length < count; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const idx = nearestWalkable(world.map, fx + dx, fy + dy, 0);
        if (idx >= 0 && !seen.has(idx)) {
          seen.add(idx);
          out.push(idx);
        }
      }
    }
  }
  return out;
}

function removeDead(world: World): void {
  for (const [id, unit] of world.units) {
    if (!unit.dead) continue;
    // Combat corpses linger for the death animation; despawns go at once.
    if (
      unit.deathTick === undefined ||
      world.tick - unit.deathTick >= CORPSE_TICKS
    ) {
      world.units.delete(id);
    }
  }
  for (const [id, b] of world.buildings) {
    if (b.dead) world.buildings.delete(id);
  }
}
