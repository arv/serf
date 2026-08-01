import { TILE_COUNT, tileX, tileY } from '../../shared/grid.ts';
import { TileResource } from '../map.ts';
import { BUILDING_DEFS, buildingDef, type BuildingTypeId } from '../defs/buildings.ts';
import { TECH_DEFS, type TechId } from '../defs/techs.ts';
import { HIRE_SERF_COST } from '../defs/balance.ts';
import { canPlace, type World } from '../world.ts';
import { isPlayerOwner, type Building, type Owner } from '../entities.ts';
import type { SimCommand } from '../commands.ts';

/**
 * The AI opponent's brain: a pure strategic layer that reads a World and
 * emits the same five command verbs a human does. It runs OUTSIDE the sim —
 * one dedicated worker per AI seat holds a replica world and speaks
 * ordinary commands, so the sim stays input-driven, rollback treats AI
 * moves as remote inputs, and thinking never blocks a tick.
 *
 * Grown from the winnable-campaign test bot: wants-vs-standing-counts
 * build order, survival-floor hiring with a research reserve, a fixed
 * research queue, a sword-aware barracks queue, rally-then-attack army logic.
 */

export const AI_TUNING = {
  decisionInterval: 20,
  armyAttackSize: 7,
  attackCooldown: 900,
  rallyCooldown: 400,
  serfTarget: 8,
  survivalFloor: 3,
  researchReserve: 10,
  researchOrder: ['soldiery', 'cobbledBoots', 'ironworking'] as TechId[],
  barracksQueueDepth: 2,
} as const;

const MILITARY = new Set(['knight', 'spearman', 'archer']);

export class AiBrain {
  readonly playerId: Owner;
  #lastAttackTick = 0;
  #lastRallyTick = 0;
  #attacking = false;

  constructor(playerId: Owner) {
    this.playerId = playerId;
  }

  /** Is `tick` one of this seat's decision beats? (Seats stagger so two
   * brains never fire on the same tick.) */
  shouldDecide(tick: number): boolean {
    return tick % AI_TUNING.decisionInterval === (this.playerId * 5) % AI_TUNING.decisionInterval;
  }

  /** Read the world, emit this beat's commands. Pure apart from the brain's
   * own pacing memory. */
  decide(world: World): SimCommand[] {
    const p = world.players[this.playerId];
    if (!p || !p.alive || world.outcome.state !== 'playing') return [];
    const commands: SimCommand[] = [];
    const mine = ownedBuildings(world, this.playerId);
    const sh = mine.find((b) => b.type === 'storehouse' && b.state === 'built');
    if (!sh) return commands; // one tick from elimination; nothing to do
    const baseX = sh.x + 1;
    const baseY = sh.y + 1;
    const stock = sh.stock as Record<string, number>;
    const techs = p.techs;
    const has = (type: BuildingTypeId): boolean => mine.some((b) => b.type === type);
    const countOf = (type: BuildingTypeId): number => mine.filter((b) => b.type === type).length;

    // --- Build order: desired counts vs standing counts (rebuilds losses) ---
    const iron = techs.researched.includes('ironworking');
    const wants: [BuildingTypeId, number, { x: number; y: number } | null][] = [];
    const grove = nearestResource(world, TileResource.Wood, baseX, baseY);
    if (grove >= 0) {
      wants.push(['woodcutter', iron ? 2 : 1, findSpot(world, 'woodcutter', tileX(grove), tileY(grove), 6)]);
    }
    const rocks = nearestResource(world, TileResource.Rock, baseX, baseY);
    if (rocks >= 0) {
      wants.push(['quarry', 1, findSpot(world, 'quarry', tileX(rocks), tileY(rocks), 6)]);
    }
    wants.push(['abbey', 1, findSpot(world, 'abbey', baseX, baseY)]);
    // Silver before the barracks: the pool starts lean, so replacement hands
    // are bought — and research, weapons and hiring all drain the same
    // purse. Income first is what makes the rest of the plan affordable.
    const silverSeam = nearestResource(world, TileResource.SilverDep, baseX, baseY);
    if (silverSeam >= 0) {
      wants.push(['silverMine', 1, findSpot(world, 'silverMine', tileX(silverSeam), tileY(silverSeam), 4)]);
    }
    if (techs.researched.includes('soldiery')) {
      wants.push(['barracks', 1, findSpot(world, 'barracks', baseX, baseY)]);
    }
    wants.push(['well', 1, findSpot(world, 'well', baseX, baseY)]);
    wants.push(['wheatFarm', 1, findSpot(world, 'wheatFarm', baseX, baseY)]);
    if (iron) {
      const seam = nearestResource(world, TileResource.IronDep, baseX, baseY);
      if (seam >= 0) {
        wants.push(['ironMine', 1, findSpot(world, 'ironMine', tileX(seam), tileY(seam), 4)]);
      }
      wants.push(['spearmaker', 1, findSpot(world, 'spearmaker', baseX, baseY)]);
      wants.push(['swordsmith', 1, findSpot(world, 'swordsmith', baseX, baseY)]);
    }
    for (const [type, desired, spot] of wants) {
      if (!spot || countOf(type) >= desired) continue;
      const cost = BUILDING_DEFS[type].cost as Record<string, number>;
      const ok = Object.entries(cost).every(([good, n]) => (stock[good] ?? 0) >= n);
      if (ok) {
        commands.push({ kind: 'placeBuilding', building: type, x: spot.x, y: spot.y });
        break; // one placement per decision to keep hauling focused
      }
    }

    // --- Population: keep loose serfs around ---------------------------------
    let serfCount = 0;
    for (const u of world.units.values()) {
      if (!u.dead && u.owner === this.playerId && u.kind === 'serf') serfCount++;
    }
    const researchPending = AI_TUNING.researchOrder.some((id) => !techs.researched.includes(id));
    if (serfCount < AI_TUNING.survivalFloor && (stock.silver ?? 0) >= HIRE_SERF_COST) {
      commands.push({ kind: 'hireSerf' });
    } else if (
      techs.researched.includes('soldiery') &&
      serfCount < AI_TUNING.serfTarget &&
      (stock.silver ?? 0) >= HIRE_SERF_COST + (researchPending ? AI_TUNING.researchReserve : 0)
    ) {
      commands.push({ kind: 'hireSerf' });
    }

    // --- Research queue ------------------------------------------------------
    if (!techs.active) {
      const next = AI_TUNING.researchOrder.find((id) => !techs.researched.includes(id));
      if (next && has('abbey')) {
        const cost = TECH_DEFS[next].cost as Record<string, number>;
        const ok = Object.entries(cost).every(([good, n]) => (stock[good] ?? 0) >= n);
        if (ok) commands.push({ kind: 'research', tech: next });
      }
    }

    // --- Keep the barracks queue warm --------------------------------------------
    const barracks = mine.find((b) => b.type === 'barracks' && b.state === 'built');
    if (barracks && (barracks.trainQueue?.length ?? 0) < AI_TUNING.barracksQueueDepth) {
      const swordAround =
        (stock.sword ?? 0) + (barracks.inputs.sword ?? 0) + (barracks.inbound.sword ?? 0) > 0;
      commands.push({
        kind: 'trainUnit',
        buildingId: barracks.id,
        unit: swordAround ? 'knight' : 'spearman',
      });
    }

    // --- Army: rally at home until strong, then march ------------------------
    const army = [...world.units.values()].filter(
      (u) => !u.dead && u.owner === this.playerId && MILITARY.has(u.kind),
    );
    const target = pickAttackTarget(world, this.playerId, baseX, baseY);
    if (
      target &&
      army.length >= AI_TUNING.armyAttackSize &&
      world.tick - this.#lastAttackTick > AI_TUNING.attackCooldown
    ) {
      this.#attacking = true;
      this.#lastAttackTick = world.tick;
      commands.push({
        kind: 'moveUnits',
        unitIds: army.map((u) => u.id),
        x: target.x + 1,
        y: target.y + 1,
      });
    } else if (
      !this.#attacking &&
      army.length > 0 &&
      world.tick - this.#lastRallyTick > AI_TUNING.rallyCooldown
    ) {
      // Garrison duty: stand by the storehouse so auto-acquire covers it.
      this.#lastRallyTick = world.tick;
      const idle = army.filter((u) => u.task.t === 'idle');
      if (idle.length > 0) {
        commands.push({
          kind: 'moveUnits',
          unitIds: idle.map((u) => u.id),
          x: baseX,
          y: baseY + 4,
        });
      }
    }

    return commands;
  }
}

function ownedBuildings(world: World, owner: Owner): Building[] {
  return [...world.buildings.values()].filter((b) => !b.dead && b.owner === owner);
}

/**
 * Nearest placeable footprint origin around a point (spiral search) that
 * also keeps a one-tile gap from every other building — packing tighter can
 * seal a neighbor's doorway and strangle its deliveries. The sim does not
 * enforce this; a careless builder can wall itself in.
 */
function findSpot(
  world: World,
  type: BuildingTypeId,
  cx: number,
  cy: number,
  maxR = 14,
): { x: number; y: number } | null {
  const def = BUILDING_DEFS[type];
  const spaced = (x: number, y: number): boolean => {
    for (let ty = y - 1; ty < y + def.h + 1; ty++) {
      for (let tx = x - 1; tx < x + def.w + 1; tx++) {
        if (tx < 0 || ty < 0 || tx >= 64 || ty >= 64) continue;
        if (world.map.buildingAt[ty * 64 + tx]! >= 0) return false;
      }
    }
    return true;
  };
  for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (canPlace(world.map, type, x, y) && spaced(x, y)) return { x, y };
      }
    }
  }
  return null;
}

/** Nearest tile with a given resource to a point. */
function nearestResource(world: World, code: number, cx: number, cy: number): number {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < TILE_COUNT; i++) {
    if (world.map.resource[i] !== code || world.map.resourceAmt[i]! <= 0) continue;
    const d = Math.abs(tileX(i) - cx) + Math.abs(tileY(i) - cy);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/**
 * What the army marches on: the nearest rival storehouse or bandit camp
 * (razing the camp stops the raids; razing a storehouse eliminates the
 * rival). Ties break on the lower building id.
 */
function pickAttackTarget(world: World, owner: Owner, bx: number, by: number): Building | undefined {
  let best: Building | undefined;
  let bestDist = Infinity;
  for (const b of world.buildings.values()) {
    if (b.dead || b.owner === owner) continue;
    const isCamp = b.type === 'banditCamp';
    const isRivalStore = isPlayerOwner(b.owner) && buildingDef(b.type).storage;
    if (!isCamp && !isRivalStore) continue;
    const d = Math.abs(b.x + 1 - bx) + Math.abs(b.y + 1 - by);
    if (d < bestDist || (d === bestDist && best && b.id < best.id)) {
      bestDist = d;
      best = b;
    }
  }
  return best;
}
