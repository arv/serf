import { Rng } from '../shared/rng';
import { inBounds, tileIdx, tileX, tileY } from '../shared/grid';
import { UNIT_DEFS } from './defs/units';
import { findPath, nearestWalkable } from './path';
import { movementSystem } from './systems/movement';
import { wanderSystem } from './systems/wander';
import { logisticsSystem } from './systems/logistics';
import { productionSystem } from './systems/production';
import { constructionSystem } from './systems/construction';
import { trailsSystem } from './systems/trails';
import { canPlace, killUnit, placeSite, spawnUnit, type World } from './world';
import { GOODS } from './defs/goods';
import { findStorehouse } from './systems/logistics';
import { researchSystem } from './systems/research';
import { trainingSystem, enqueueTraining } from './systems/training';
import { staffingSystem } from './systems/staffing';
import { combatSystem } from './systems/combat';
import { banditsSystem } from './systems/bandits';
import { victorySystem } from './systems/victory';
import { buildingDef } from './defs/buildings';
import { CORPSE_TICKS, HIRE_SERF_COST } from './defs/balance';
import { TECH_DEFS } from './defs/techs';
import { canResearch, isBuildingUnlocked } from './techHelpers';
import type { GoodId } from './defs/goods';
import type { AdminAction, SimCommand } from './commands';

export { TICKS_PER_SECOND, TICK_MS } from './defs/balance';

/**
 * One fixed-timestep step. System order is deliberate and fixed; new systems
 * slot into this list as milestones land:
 * commands -> production -> logistics -> construction -> behaviors ->
 * movement -> trails -> removeDead.
 */
export function tickWorld(world: World, commands: readonly SimCommand[]): void {
  const rng = new Rng(world.rngState);

  for (const cmd of commands) applyCommand(world, cmd);

  researchSystem(world);
  productionSystem(world, rng);
  logisticsSystem(world);
  constructionSystem(world);
  staffingSystem(world);
  trainingSystem(world);
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

function applyCommand(world: World, cmd: SimCommand): void {
  switch (cmd.kind) {
    case 'moveUnits':
      applyMoveUnits(world, cmd);
      break;
    case 'placeBuilding':
      if (
        !buildingDef(cmd.building).systemOnly &&
        isBuildingUnlocked(world, cmd.building) &&
        canPlace(world.map, cmd.building, cmd.x, cmd.y)
      ) {
        placeSite(world, cmd.building, 'player', cmd.x, cmd.y);
      }
      break;
    case 'trainUnit': {
      const b = world.buildings.get(cmd.buildingId);
      if (b && b.owner === 'player') enqueueTraining(world, b, cmd.unit);
      break;
    }
    case 'admin':
      applyAdmin(world, cmd.action);
      break;
    case 'research': {
      if (!canResearch(world, cmd.tech).ok) break;
      const sh = findStorehouse(world);
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
      world.techs.active = { tech: cmd.tech, ticksLeft: TECH_DEFS[cmd.tech].durationTicks };
      break;
    }
    case 'hireSerf': {
      const sh = findStorehouse(world);
      if (sh && (sh.stock.silver ?? 0) >= HIRE_SERF_COST) {
        sh.stock.silver = (sh.stock.silver ?? 0) - HIRE_SERF_COST;
        world.ledger.consumed.silver = (world.ledger.consumed.silver ?? 0) + HIRE_SERF_COST;
        spawnUnit(world, 'serf', 'player', sh.x + sh.w / 2, sh.y + sh.h + 0.5);
      }
      break;
    }
  }
}

function applyAdmin(world: World, action: AdminAction): void {
  switch (action) {
    case 'toggleRaids':
      world.admin.raidsEnabled = !world.admin.raidsEnabled;
      break;
    case 'clearBandits':
      for (const unit of world.units.values()) {
        if (unit.owner === 'bandit') killUnit(world, unit);
      }
      break;
    case 'grantGoods': {
      const sh = findStorehouse(world);
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
    case 'finishResearch':
      if (world.techs.active) world.techs.active.ticksLeft = 1;
      break;
    case 'spawnParade': {
      // One of each unit kind by the storehouse door — a visual test rig for
      // wardrobe and animation work. Player-owned so nobody starts a war.
      const sh = findStorehouse(world);
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
        spawnUnit(world, k, 'player', sh.x - 2.5 + i, sh.y + sh.h + 2.5);
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
function applyMoveUnits(world: World, cmd: { unitIds: number[]; x: number; y: number }): void {
  if (inBounds(cmd.x, cmd.y)) {
    const bId = world.map.buildingAt[tileIdx(cmd.x, cmd.y)]!;
    const target = bId >= 0 ? world.buildings.get(bId) : undefined;
    if (target && !target.dead && target.owner !== 'player') {
      for (const id of cmd.unitIds) {
        const unit = world.units.get(id);
        if (!unit || unit.dead || unit.owner !== 'player') continue;
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
    if (!unit || unit.dead || unit.owner !== 'player') continue;
    // Serfs mid-haul ignore move orders (their job owns them); idle serfs and
    // military obey.
    if (unit.jobId !== undefined || unit.homeId !== undefined) continue;
    const goal = targets[Math.min(t++, targets.length - 1)]!;
    const path = findPath(
      world.map,
      Math.floor(unit.x),
      Math.floor(unit.y),
      tileX(goal),
      tileY(goal),
    );
    if (path) {
      unit.path = path;
      unit.pathIdx = 0;
      unit.task = { t: 'move' };
      // Explicit orders disengage combat until arrival.
      unit.targetId = undefined;
      unit.targetIsBuilding = undefined;
    }
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
