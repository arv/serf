import { Rng } from '../shared/rng.ts';
import { inBounds, tileIdx, tileX, tileY } from '../shared/grid.ts';
import { UNIT_DEFS } from './defs/units.ts';
import { BANDIT, type Owner } from './entities.ts';
import { findPath, nearestWalkable } from './path.ts';
import { movementSystem } from './systems/movement.ts';
import { wanderSystem } from './systems/wander.ts';
import { abortJob, logisticsSystem } from './systems/logistics.ts';
import { productionSystem, unbindWorker } from './systems/production.ts';
import { cancelRepair, constructionSystem, orderRepair } from './systems/construction.ts';
import { trailsSystem } from './systems/trails.ts';
import { canPlace, destroyBuilding, killUnit, placeSite, spawnUnit, type World } from './world.ts';
import { GOODS } from './defs/goods.ts';
import { findStorehouse } from './systems/logistics.ts';
import { researchSystem } from './systems/research.ts';
import {
  trainingSystem,
  hiringSystem,
  enqueueTraining,
  cancelTraining,
  evictGarrison,
} from './systems/training.ts';
import { staffingSystem } from './systems/staffing.ts';
import { combatSystem } from './systems/combat.ts';
import { banditsSystem } from './systems/bandits.ts';
import { victorySystem } from './systems/victory.ts';
import { buildingDef } from './defs/buildings.ts';
import { CORPSE_TICKS, DISMISS_RESTAFF_BACKOFF, HIRE_QUEUE_CAP, HIRE_SERF_COST } from './defs/balance.ts';
import { TECH_DEFS } from './defs/techs.ts';
import { canResearch, isBuildingUnlocked } from './techHelpers.ts';
import { hasRoomToHire } from './population.ts';
import type { GoodId } from './defs/goods.ts';
import type { AdminAction, SimCommand } from './commands.ts';

export { TICKS_PER_SECOND, TICK_MS } from './defs/balance.ts';

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
export function tickWorld(world: World, commands: readonly PlayerCommand[]): void {
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
      console.error(`[sim] command ${c.cmd.kind} from player ${c.playerId} failed:`, err);
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
export function applyCommand(world: World, playerId: Owner, cmd: SimCommand): void {
  const player = world.players[playerId];
  if (!player || !player.alive) return; // eliminated players spectate
  switch (cmd.kind) {
    case 'moveUnits':
      applyMoveUnits(world, playerId, cmd);
      break;
    case 'placeBuilding':
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
    case 'trainUnit': {
      const b = world.buildings.get(cmd.buildingId);
      if (b && b.owner === playerId) enqueueTraining(world, b, cmd.unit);
      break;
    }
    case 'cancelTraining': {
      const b = world.buildings.get(cmd.buildingId);
      if (b && !b.dead && b.owner === playerId) cancelTraining(world, b, cmd.index, cmd.unit);
      break;
    }
    case 'admin':
      if (world.admin.enabled) applyAdmin(world, playerId, cmd.action);
      break;
    case 'research': {
      if (!canResearch(world, playerId, cmd.tech).ok) break;
      const sh = findStorehouse(world, playerId);
      const cost = TECH_DEFS[cmd.tech].cost;
      if (!sh) break;
      const affordable = (Object.entries(cost) as [GoodId, number][]).every(
        ([good, n]) => (sh.stock[good] ?? 0) >= n,
      );
      if (!affordable) break;
      for (const [good, n] of Object.entries(cost) as [GoodId, number][]) {
        sh.stock[good] = (sh.stock[good] ?? 0) - n;
        world.ledger.consumed[good] = (world.ledger.consumed[good] ?? 0) + n;
      }
      player.techs.active = { tech: cmd.tech, ticksLeft: TECH_DEFS[cmd.tech].durationTicks };
      break;
    }
    case 'dismissWorker': {
      // Release a resident back to the serf pool — the escape hatch when
      // the loose pool is empty and something new must get built. The
      // emptied post waits out a backoff before recruiting again, so the
      // freed serf takes new work instead of being pulled straight back.
      const b = world.buildings.get(cmd.buildingId);
      if (!b || b.dead || b.owner !== playerId) break;
      // A manned building gives a man back instead: one of the tower's
      // archers climbs down and is a soldier on the field again. Same
      // backoff, for the same reason — without it the sweep would walk him
      // straight back up the stairs.
      if (b.garrison) {
        evictGarrison(world, b, 1);
        b.staffBackoffUntil = world.tick + DISMISS_RESTAFF_BACKOFF;
        break;
      }
      if (b.workerId === undefined) break;
      const worker = world.units.get(b.workerId);
      if (worker && !worker.dead) {
        unbindWorker(world, worker);
        b.staffBackoffUntil = world.tick + DISMISS_RESTAFF_BACKOFF;
      }
      break;
    }
    case 'setBuildingPaused': {
      // Halt the workshop without breaking it up: production, input hauls
      // and construction progress stop; the worker keeps the post and any
      // finished stock still evacuates. The lever for 'the bowyer is
      // eating all my wood'.
      const b = world.buildings.get(cmd.buildingId);
      if (!b || b.dead || b.owner !== playerId) break;
      const def = buildingDef(b.type);
      if (def.storage || def.isRoad || def.systemOnly) break;
      b.paused = cmd.paused || undefined;
      break;
    }
    case 'setBuildingRepair': {
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
    case 'setBuildingRecipe': {
      // The forge menu: pick which weapon the smith works on. Gated per
      // option (bows need archery, iron weapons need ironworking); a
      // batch already on the fire finishes as what it started as.
      const b = world.buildings.get(cmd.buildingId);
      if (!b || b.dead || b.owner !== playerId) break;
      const opt = buildingDef(b.type).recipeOptions?.[cmd.index];
      if (!opt) break;
      if (
        opt.requiresTech !== undefined &&
        !(world.players[playerId]?.techs.researched.includes(opt.requiresTech) ?? false)
      ) {
        break;
      }
      b.recipeIndex = cmd.index;
      break;
    }
    case 'sellBuilding': {
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
        for (const [good, n] of Object.entries(def.cost) as [GoodId, number][]) {
          const delivered = b.state === 'site' ? n - (b.siteNeeds?.[good] ?? 0) : n;
          const refund = Math.floor(delivered / 2);
          if (refund <= 0) continue;
          sh.stock[good] = (sh.stock[good] ?? 0) + refund;
          // Ledgered as production so the conservation invariant stays
          // honest — the same bookkeeping grantGoods uses.
          world.ledger.produced[good] = (world.ledger.produced[good] ?? 0) + refund;
        }
      }
      destroyBuilding(world, b);
      break;
    }
    case 'hireSerf': {
      // Pay now, arrive later: the recruit is summoned, not conjured. The
      // hiring system walks the queue down and drops them at the door.
      // A recruit already on the road holds their bed, so ordering five at
      // once cannot overshoot the cap by four.
      const sh = findStorehouse(world, playerId);
      if (
        sh &&
        (sh.stock.silver ?? 0) >= HIRE_SERF_COST &&
        (sh.hireQueue ?? 0) < HIRE_QUEUE_CAP &&
        hasRoomToHire(world, playerId)
      ) {
        sh.stock.silver = (sh.stock.silver ?? 0) - HIRE_SERF_COST;
        world.ledger.consumed.silver = (world.ledger.consumed.silver ?? 0) + HIRE_SERF_COST;
        sh.hireQueue = (sh.hireQueue ?? 0) + 1;
      }
      break;
    }
  }
}

function applyAdmin(world: World, playerId: Owner, action: AdminAction): void {
  switch (action) {
    case 'toggleRaids':
      world.admin.raidsEnabled = !world.admin.raidsEnabled;
      break;
    case 'clearBandits':
      for (const unit of world.units.values()) {
        if (unit.owner === BANDIT) killUnit(world, unit);
      }
      break;
    case 'grantGoods': {
      const sh = findStorehouse(world, playerId);
      if (!sh) break;
      for (const good of GOODS) {
        sh.stock[good] = (sh.stock[good] ?? 0) + 25;
        // Ledgered as production so the conservation invariant stays honest.
        world.ledger.produced[good] = (world.ledger.produced[good] ?? 0) + 25;
      }
      break;
    }
    case 'toggleInstantBuild':
      world.admin.instantBuild = !world.admin.instantBuild;
      break;
    case 'finishResearch': {
      const active = world.players[playerId]?.techs.active;
      if (active) active.ticksLeft = 1;
      break;
    }
    case 'spawnParade': {
      // One of each unit kind by the storehouse door — a visual test rig for
      // wardrobe and animation work. Issuer-owned so nobody starts a war.
      const sh = findStorehouse(world, playerId);
      if (!sh) break;
      const kinds = [
        'serf',
        'worker',
        'knight',
        'spearman',
        'archer',
        'bandit',
        'banditArcher',
        'marauder',
      ] as const;
      kinds.forEach((k, i) => {
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
  cmd: { unitIds: number[]; x: number; y: number; attack?: true | 'half' },
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
        unit.task = { t: 'raid', buildingId: target.id };
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
    const path = findPath(world.map, Math.floor(unit.x), Math.floor(unit.y), goalX, goalY);
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
          ? { t: 'attackMove', destX: goalX, destY: goalY, engageIdx }
          : { t: 'attackMove', destX: goalX, destY: goalY }
        : { t: 'move' };
    // Explicit orders disengage combat; an attack-move re-acquires freely.
    unit.targetId = undefined;
    unit.targetIsBuilding = undefined;
  }
}

function collectSpreadTargets(world: World, x: number, y: number, count: number): number[] {
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
    if (unit.deathTick === undefined || world.tick - unit.deathTick >= CORPSE_TICKS) {
      world.units.delete(id);
    }
  }
  for (const [id, b] of world.buildings) {
    if (b.dead) world.buildings.delete(id);
  }
}
