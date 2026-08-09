import { strategyOf } from '../sim/defs/aiStrategies.ts';
import { TICK_MS } from '../sim/defs/balance.ts';
import { UNIT_DEFS, type UnitTypeId } from '../sim/defs/units.ts';
import { buildingDef, type BuildingTypeId } from '../sim/defs/buildings.ts';
import type { Building, Owner } from '../sim/entities.ts';
import { popCapOf, populationOf } from '../sim/population.ts';
import type { World } from '../sim/world.ts';

/**
 * One AI seat's view of the match, folded down for a language model. The
 * sim worker builds this on the advice cadence (~45 s) and posts it to the
 * main thread, where the strategist turns it into a prompt — so the shape
 * here is a wire format, and small on purpose: a 1B model's latency is
 * paid per input token, and everything below fits in well under 2 KB of
 * JSON however the match has sprawled.
 *
 * Lives outside src/sim/ because nothing deterministic depends on it, but
 * stays pure over a World so it can be tested against real games.
 */

/** The knobs the strategist may steer, at their playbook values. The
 * model sees where the dial starts; its own last advice rides along in the
 * prompt, so the effective values need not cross the wire. */
export interface SeatKnobs {
  serfTarget: number;
  armyAttackSize: number;
  attackCooldown: number;
  homeGuard: number;
  prefersRivals: boolean;
  trainPreference: UnitTypeId[];
  weaponMix: number[];
  barracksQueueDepth: number;
  houseLimit: number;
  housingHeadroom: number;
  researchReserve: number;
}

export interface RivalSummary {
  id: number;
  alive: boolean;
  /** Soldiers standing — the sum a scout would count, not unit-by-unit. */
  army: number;
  buildings: number;
  /** Tiles between castles (manhattan); -1 once either castle is gone. */
  distance: number;
}

export interface AiWorldSummary {
  tick: number;
  /** Same clock in human units, for a model that reasons better in time. */
  minutes: number;
  seat: { id: number; strategyId: string; knobs: SeatKnobs };
  me: {
    /** Storehouse stock, zero lines dropped. */
    stock: Record<string, number>;
    serfs: number;
    pop: number;
    popCap: number;
    /** Standing counts by type, construction sites included. */
    buildings: Partial<Record<BuildingTypeId, number>>;
    army: { knight: number; spearman: number; archer: number };
    researched: string[];
    researching: string | null;
    /** A hostile fighter within sight of the castle right now. */
    underAttack: boolean;
  };
  rivals: RivalSummary[];
  bandits: { camps: number; nearestCamp: number };
}

const MILITARY = new Set<UnitTypeId>(['knight', 'spearman', 'archer']);
/** "Within sight of the castle": the homeGuard scale, not the whole map. */
const UNDER_ATTACK_RADIUS = 12;

function castleOf(world: World, owner: Owner): Building | undefined {
  for (const b of world.buildings.values()) {
    if (!b.dead && b.owner === owner && buildingDef(b.type).storage && b.state === 'built') {
      return b;
    }
  }
  return undefined;
}

function armyOf(world: World, owner: Owner): number {
  let n = 0;
  for (const u of world.units.values()) {
    if (!u.dead && u.owner === owner && MILITARY.has(u.kind)) n++;
  }
  return n;
}

export function summarizeForSeat(world: World, playerId: Owner): AiWorldSummary {
  const player = world.players[playerId];
  const strategy = strategyOf(player?.strategy);
  const castle = castleOf(world, playerId);
  const bx = castle ? castle.x + 1 : -1;
  const by = castle ? castle.y + 1 : -1;

  const stock: Record<string, number> = {};
  if (castle) {
    for (const [good, n] of Object.entries(castle.stock as Record<string, number>)) {
      if (n > 0) stock[good] = n;
    }
  }

  const buildings: Partial<Record<BuildingTypeId, number>> = {};
  let serfs = 0;
  const army = { knight: 0, spearman: 0, archer: 0 };
  let underAttack = false;
  for (const b of world.buildings.values()) {
    if (b.dead || b.owner !== playerId) continue;
    buildings[b.type] = (buildings[b.type] ?? 0) + 1;
  }
  for (const u of world.units.values()) {
    if (u.dead) continue;
    if (u.owner === playerId) {
      if (u.kind === 'serf') serfs++;
      else if (u.kind === 'knight' || u.kind === 'spearman' || u.kind === 'archer') {
        army[u.kind]++;
      }
    } else if (
      castle &&
      UNIT_DEFS[u.kind].combat &&
      Math.abs(u.x - bx) + Math.abs(u.y - by) <= UNDER_ATTACK_RADIUS
    ) {
      underAttack = true;
    }
  }

  const rivals: RivalSummary[] = [];
  for (const rival of world.players) {
    if (rival.id === playerId) continue;
    const theirCastle = castleOf(world, rival.id);
    let standing = 0;
    for (const b of world.buildings.values()) {
      if (!b.dead && b.owner === rival.id) standing++;
    }
    rivals.push({
      id: rival.id,
      alive: rival.alive,
      army: armyOf(world, rival.id),
      buildings: standing,
      distance:
        castle && theirCastle
          ? Math.abs(theirCastle.x + 1 - bx) + Math.abs(theirCastle.y + 1 - by)
          : -1,
    });
  }

  let camps = 0;
  let nearestCamp = -1;
  for (const b of world.buildings.values()) {
    if (b.dead || b.type !== 'banditCamp') continue;
    camps++;
    if (castle) {
      const d = Math.abs(b.x + 1 - bx) + Math.abs(b.y + 1 - by);
      if (nearestCamp < 0 || d < nearestCamp) nearestCamp = d;
    }
  }

  const techs = player?.techs;
  return {
    tick: world.tick,
    minutes: Math.round((world.tick * TICK_MS) / 60_000),
    seat: {
      id: playerId,
      strategyId: strategy.id,
      knobs: {
        serfTarget: strategy.serfTarget,
        armyAttackSize: strategy.armyAttackSize,
        attackCooldown: strategy.attackCooldown,
        homeGuard: strategy.homeGuard,
        prefersRivals: strategy.prefersRivals,
        trainPreference: [...strategy.trainPreference],
        weaponMix: [...strategy.weaponMix],
        barracksQueueDepth: strategy.barracksQueueDepth,
        houseLimit: strategy.houseLimit,
        housingHeadroom: strategy.housingHeadroom,
        researchReserve: strategy.researchReserve,
      },
    },
    me: {
      stock,
      serfs,
      pop: populationOf(world, playerId),
      popCap: popCapOf(world, playerId),
      buildings,
      army,
      researched: techs ? [...techs.researched] : [],
      researching: techs?.active?.tech ?? null,
      underAttack,
    },
    rivals,
    bandits: { camps, nearestCamp },
  };
}
