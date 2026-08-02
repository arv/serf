import { TILE_COUNT, tileX, tileY } from '../../shared/grid.ts';
import { TileResource } from '../map.ts';
import { BUILDING_DEFS, buildingDef, type BuildingTypeId } from '../defs/buildings.ts';
import { TECH_DEFS, type TechId } from '../defs/techs.ts';
import { UNIT_DEFS, type UnitTypeId } from '../defs/units.ts';
import { HIRE_SERF_COST } from '../defs/balance.ts';
import {
  strategyForSeat,
  type AiStrategy,
  type BuildAnchor,
  type BuildStep,
} from '../defs/aiStrategies.ts';
import { canPlace, type World } from '../world.ts';
import { isPlayerOwner, type Building, type Owner } from '../entities.ts';
import type { GoodId } from '../defs/goods.ts';
import type { SimCommand } from '../commands.ts';

/**
 * The AI opponent's brain: a pure strategic layer that reads a World and
 * emits the same five command verbs a human does. It runs OUTSIDE the sim —
 * one brain per AI seat, called beside whichever host owns the world, so
 * the sim stays input-driven, rollback treats AI moves as remote inputs,
 * and thinking never blocks a tick.
 *
 * The brain is the machinery; WHAT it plays is a playbook it is handed
 * (defs/aiStrategies.ts): build order, research line, forge assignment,
 * what it trains, how big an army it wants and whether it defends. Seats
 * take a different playbook each, so three computer opponents are three
 * different games rather than one game three times.
 *
 * The default seat-0 playbook ('steward') is the original single strategy
 * unchanged — wants-vs-standing-counts build order, survival-floor hiring
 * with a research reserve, a fixed research queue, a sword-aware barracks
 * queue, rally-then-attack army logic — because the winnable-campaign
 * regression drives it.
 */

export const AI_PACING = {
  /** Ticks between one seat's decision beats. */
  decisionInterval: 20,
  /** Beat offset per seat id, so two brains never fire on the same tick. */
  seatStagger: 5,
  /**
   * Impatience: a muster bar that is never met is a game that never ends.
   * Two exhausted villages with the seams mined out can each sit below
   * their attack size forever — playbooks that muster at different sizes
   * made that reachable, where one shared size had every seat marching at
   * the same moment. After this long without a march the bar drops a
   * soldier every `stalePeriod`, to a floor of `staleFloor`. Set well past
   * a decided game (the campaign is normally over by tick 12k), so it only
   * ever touches a standoff.
   */
  staleAfter: 20_000,
  stalePeriod: 2_000,
  staleFloor: 3,
} as const;

const MILITARY = new Set<UnitTypeId>(['knight', 'spearman', 'archer']);

/** What a soldier needs forged before the barracks can start on them. */
const WEAPON_OF: Partial<Record<UnitTypeId, GoodId>> = {
  knight: 'sword',
  spearman: 'spear',
  archer: 'bow',
};

const ANCHOR_RESOURCE: Record<Exclude<BuildAnchor, 'base'>, number> = {
  wood: TileResource.Wood,
  rock: TileResource.Rock,
  iron: TileResource.IronDep,
  silver: TileResource.SilverDep,
};

export class AiBrain {
  readonly playerId: Owner;
  readonly strategy: AiStrategy;
  #lastAttackTick = 0;
  #lastRallyTick = 0;
  #attacking = false;

  constructor(playerId: Owner, strategy: AiStrategy = strategyForSeat(playerId)) {
    this.playerId = playerId;
    this.strategy = strategy;
  }

  /** Is `tick` one of this seat's decision beats? (Seats stagger so two
   * brains never fire on the same tick.) */
  shouldDecide(tick: number): boolean {
    const { decisionInterval, seatStagger } = AI_PACING;
    return tick % decisionInterval === (this.playerId * seatStagger) % decisionInterval;
  }

  /** Read the world, emit this beat's commands. Pure apart from the brain's
   * own pacing memory. */
  decide(world: World): SimCommand[] {
    const s = this.strategy;
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
    const researched = (id: TechId): boolean => techs.researched.includes(id);
    const has = (type: BuildingTypeId): boolean => mine.some((b) => b.type === type);
    const countOf = (type: BuildingTypeId): number => mine.filter((b) => b.type === type).length;

    // --- Build order: desired counts vs standing counts (rebuilds losses) ---
    for (const step of s.build) {
      if (step.after && !researched(step.after)) continue;
      if (step.needs && !has(step.needs)) continue;
      const desired = step.more && researched(step.more.after) ? step.more.count : step.count;
      if (countOf(step.type) >= desired) continue;
      const spot = spotFor(world, step, baseX, baseY);
      if (!spot) continue;
      const cost = BUILDING_DEFS[step.type].cost as Record<string, number>;
      const ok = Object.entries(cost).every(([good, n]) => (stock[good] ?? 0) >= n);
      if (ok) {
        commands.push({ kind: 'placeBuilding', building: step.type, x: spot.x, y: spot.y });
        break; // one placement per decision to keep hauling focused
      }
    }

    // --- Population: keep loose serfs around ---------------------------------
    let serfCount = 0;
    for (const u of world.units.values()) {
      if (!u.dead && u.owner === this.playerId && u.kind === 'serf') serfCount++;
    }
    const researchPending = s.researchOrder.some((id) => !techs.researched.includes(id));
    const growing = s.growthAfter === null || researched(s.growthAfter);
    if (serfCount < s.survivalFloor && (stock.silver ?? 0) >= HIRE_SERF_COST) {
      commands.push({ kind: 'hireSerf' });
    } else if (
      growing &&
      serfCount < s.serfTarget &&
      (stock.silver ?? 0) >= HIRE_SERF_COST + (researchPending ? s.researchReserve : 0)
    ) {
      commands.push({ kind: 'hireSerf' });
    }

    // --- Research queue ------------------------------------------------------
    // First in the playbook's order that is neither done nor blocked: a line
    // that names a tech ahead of its prereq skips past it rather than
    // stalling the whole queue on an order the sim will refuse.
    if (!techs.active) {
      const next = s.researchOrder.find(
        (id) =>
          !techs.researched.includes(id) &&
          TECH_DEFS[id].prereqs.every((pre) => techs.researched.includes(pre)),
      );
      if (next && has('abbey')) {
        const cost = TECH_DEFS[next].cost as Record<string, number>;
        const ok = Object.entries(cost).every(([good, n]) => (stock[good] ?? 0) >= n);
        if (ok) commands.push({ kind: 'research', tech: next });
      }
    }

    // --- Forge assignments: the playbook's weapon mix, by smith age ---------
    const smiths = mine
      .filter((b) => b.type === 'weaponsmith' && b.state === 'built')
      .sort((a, z) => a.id - z.id);
    smiths.forEach((smith, i) => {
      const want = s.weaponMix[Math.min(i, s.weaponMix.length - 1)]!;
      const option = BUILDING_DEFS.weaponsmith.recipeOptions?.[want];
      if (!option) return;
      if (option.requiresTech !== undefined && !researched(option.requiresTech)) return;
      if ((smith.recipeIndex ?? 0) !== want) {
        commands.push({ kind: 'setBuildingRecipe', buildingId: smith.id, index: want });
      }
    });

    // --- Keep the barracks queue warm --------------------------------------------
    const barracks = mine.find((b) => b.type === 'barracks' && b.state === 'built');
    if (barracks && (barracks.trainQueue?.length ?? 0) < s.barracksQueueDepth) {
      const around = (good: GoodId): boolean =>
        (stock[good] ?? 0) + (barracks.inputs[good] ?? 0) + (barracks.inbound[good] ?? 0) > 0;
      const ready = s.trainPreference.find((unit) => {
        const weapon = WEAPON_OF[unit];
        return weapon !== undefined && around(weapon);
      });
      commands.push({
        kind: 'trainUnit',
        buildingId: barracks.id,
        unit: ready ?? s.trainFallback,
      });
    }

    // --- Army: rally at home until strong, then march ------------------------
    const army = [...world.units.values()].filter(
      (u) => !u.dead && u.owner === this.playerId && MILITARY.has(u.kind),
    );
    const target = pickAttackTarget(world, this.playerId, baseX, baseY, s.prefersRivals);
    const rallyReady = world.tick - this.#lastRallyTick > s.rallyCooldown;
    const idleFor = world.tick - this.#lastAttackTick;
    if (
      target &&
      army.length >= mustersNeeded(s.armyAttackSize, idleFor) &&
      idleFor > s.attackCooldown
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
      s.homeGuard > 0 &&
      army.length > 0 &&
      rallyReady &&
      hostileNear(world, this.playerId, baseX, baseY, s.homeGuard)
    ) {
      // Someone is at the gates and the muster is not ready: everyone home,
      // including whoever is still out on the last march. Checked after the
      // attack branch on purpose — a full muster marches anyway, or a
      // lingering raider could pin the army at home for the whole game.
      this.#attacking = false;
      this.#lastRallyTick = world.tick;
      commands.push({
        kind: 'moveUnits',
        unitIds: army.map((u) => u.id),
        x: baseX,
        y: baseY + 4,
      });
    } else if (!this.#attacking && army.length > 0 && rallyReady) {
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

/** The muster this beat asks for: the playbook's size, less one soldier for
 * every `stalePeriod` the army has stood idle past `staleAfter`. */
export function mustersNeeded(armyAttackSize: number, idleFor: number): number {
  const { staleAfter, stalePeriod, staleFloor } = AI_PACING;
  if (idleFor <= staleAfter) return armyAttackSize;
  const impatience = Math.floor((idleFor - staleAfter) / stalePeriod) + 1;
  return Math.max(staleFloor, armyAttackSize - impatience);
}

function ownedBuildings(world: World, owner: Owner): Building[] {
  return [...world.buildings.values()].filter((b) => !b.dead && b.owner === owner);
}

/** Where a build step wants to stand: at the base, or at its seam. */
function spotFor(
  world: World,
  step: BuildStep,
  baseX: number,
  baseY: number,
): { x: number; y: number } | null {
  if (step.anchor === 'base') return findSpot(world, step.type, baseX, baseY, step.radius);
  const tile = nearestResource(world, ANCHOR_RESOURCE[step.anchor], baseX, baseY);
  if (tile < 0) return null;
  return findSpot(world, step.type, tileX(tile), tileY(tile), step.radius);
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

/** Is an enemy fighter — rival soldier or raider — this close to home? */
function hostileNear(
  world: World,
  owner: Owner,
  bx: number,
  by: number,
  radius: number,
): boolean {
  for (const u of world.units.values()) {
    if (u.dead || u.owner === owner) continue;
    if (!UNIT_DEFS[u.kind].combat) continue;
    if (Math.abs(u.x - bx) + Math.abs(u.y - by) <= radius) return true;
  }
  return false;
}

/**
 * What the army marches on: the nearest rival storehouse or bandit camp
 * (razing the camp stops the raids; razing a storehouse eliminates the
 * rival). Ties break on the lower building id. A playbook that prefers
 * rivals ignores the camps entirely while any rival castle stands.
 */
function pickAttackTarget(
  world: World,
  owner: Owner,
  bx: number,
  by: number,
  prefersRivals: boolean,
): Building | undefined {
  let best: Building | undefined;
  let bestDist = Infinity;
  let bestRank = Infinity;
  for (const b of world.buildings.values()) {
    if (b.dead || b.owner === owner) continue;
    const isCamp = b.type === 'banditCamp';
    const isRivalStore = isPlayerOwner(b.owner) && buildingDef(b.type).storage;
    if (!isCamp && !isRivalStore) continue;
    const d = Math.abs(b.x + 1 - bx) + Math.abs(b.y + 1 - by);
    // Rank first, distance second: without a preference every candidate
    // ranks the same and this is plain nearest-first.
    const rank = prefersRivals && !isRivalStore ? 1 : 0;
    const better =
      best === undefined ||
      rank < bestRank ||
      (rank === bestRank && (d < bestDist || (d === bestDist && b.id < best.id)));
    if (better) {
      bestDist = d;
      bestRank = rank;
      best = b;
    }
  }
  return best;
}
