import { Rng } from '../shared/rng.ts';
import { inBounds, tileIdx, tileX, tileY } from '../shared/grid.ts';
import { UNIT_DEFS } from './defs/units.ts';
import { BANDIT, type Owner } from './entities.ts';
import { findPath, nearestWalkable } from './path.ts';
import { movementSystem } from './systems/movement.ts';
import { wanderSystem } from './systems/wander.ts';
import { abortJob, logisticsSystem } from './systems/logistics.ts';
import { productionSystem, unbindWorker } from './systems/production.ts';
import { constructionSystem } from './systems/construction.ts';
import { trailsSystem } from './systems/trails.ts';
import { canPlace, killUnit, placeSite, spawnUnit, type World } from './world.ts';
import { GOODS } from './defs/goods.ts';
import { findStorehouse } from './systems/logistics.ts';
import { researchSystem } from './systems/research.ts';
import { trainingSystem, hiringSystem, enqueueTraining } from './systems/training.ts';
import { staffingSystem } from './systems/staffing.ts';
import { combatSystem } from './systems/combat.ts';
import { banditsSystem } from './systems/bandits.ts';
import { victorySystem } from './systems/victory.ts';
import { buildingDef } from './defs/buildings.ts';
import { CORPSE_TICKS, HIRE_QUEUE_CAP, HIRE_SERF_COST } from './defs/balance.ts';
import { TECH_DEFS } from './defs/techs.ts';
import { canResearch, isBuildingUnlocked } from './techHelpers.ts';
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
    case 'hireSerf': {
      // Pay now, arrive later: the recruit is summoned, not conjured. The
      // hiring system walks the queue down and drops them at the door.
      const sh = findStorehouse(world, playerId);
      if (
        sh &&
        (sh.stock.silver ?? 0) >= HIRE_SERF_COST &&
        (sh.hireQueue ?? 0) < HIRE_QUEUE_CAP
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
        'samurai',
        'ashigaru',
        'archer',
        'bandit',
        'banditArcher',
        'ronin',
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
 * bandits use, and the combat system does the rest.
 */
function applyMoveUnits(
  world: World,
  playerId: Owner,
  cmd: { unitIds: number[]; x: number; y: number },
): void {
  if (inBounds(cmd.x, cmd.y)) {
    const bId = world.map.buildingAt[tileIdx(cmd.x, cmd.y)]!;
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
    const path = findPath(
      world.map,
      Math.floor(unit.x),
      Math.floor(unit.y),
      tileX(goal),
      tileY(goal),
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
    unit.task = { t: 'move' };
    // Explicit orders disengage combat until arrival.
    unit.targetId = undefined;
    unit.targetIsBuilding = undefined;
  }
}

function collectSpreadTargets(world: World, x: number, y: number, count: number): number[] {
  const out: number[] = [];
  const first = nearestWalkable(world.map, x, y);
  if (first < 0) return out;
  const fx = tileX(first);
  const fy = tileY(first);
  for (let r = 0; r <= 6 && out.length < count; r++) {
    for (let dy = -r; dy <= r && out.length < count; dy++) {
      for (let dx = -r; dx <= r && out.length < count; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const idx = nearestWalkable(world.map, fx + dx, fy + dy, 0);
        if (idx >= 0 && !out.includes(idx)) out.push(idx);
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
