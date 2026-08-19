import { TICK_MS } from '../sim/defs/balance.ts';
import { UNIT_DEFS, type UnitTypeId } from '../sim/defs/units.ts';
import { buildingDef, type BuildingTypeId } from '../sim/defs/buildings.ts';
import { AI_INTEL, hostileNear, type AiBrain } from '../sim/systems/ai.ts';
import type { Building, Owner } from '../sim/entities.ts';
import { popCapOf, populationOf } from '../sim/population.ts';
import { tileCount } from '../shared/grid.ts';
import type { World } from '../sim/world.ts';

/**
 * One AI seat's view of the match, folded down for a language model. The
 * sim worker builds this on the advice cadence (~45 s) and posts it to the
 * main thread, where the strategist turns it into a prompt — so the shape
 * here is a wire format, and small on purpose: a 1B model's latency is
 * paid per input token, and everything below fits in well under 2 KB of
 * JSON however the match has sprawled.
 *
 * Built through the seat's BRAIN, not the raw world: the brain plays under
 * fog and scouts to lift it (src/sim/systems/ai.ts), and its strategist
 * must know exactly what it knows. A rival is on the map only once its
 * castle stands on explored ground; its army is whatever the scout's last
 * trustworthy look said, age attached; a camp in dark ground does not
 * exist. What a seat always knows whole is itself — stock, buildings,
 * army, techs are unfiltered on purpose.
 *
 * Lives outside src/sim/ because nothing deterministic depends on it, but
 * stays pure over (world, brain) so it can be tested against real games.
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
  marchConfidence: number;
}

/** The scout's last trustworthy look at a rival's army: composition by
 * combat class, and how old the look is. */
export interface RivalIntel {
  ageTicks: number;
  heavy: number;
  light: number;
  ranged: number;
  total: number;
}

export interface RivalSummary {
  id: number;
  alive: boolean;
  /** Castle located — scouted onto explored ground. Until then the rival
   * exists only as a rumor, and the army cannot march on it. */
  found: boolean;
  /** Their buildings standing on ground this seat has explored. */
  buildings: number;
  /** Tiles between castles (manhattan); -1 until found (or either castle
   * is gone). */
  distance: number;
  /** null = never sighted, or the last sighting outlived its trust. */
  intel: RivalIntel | null;
}

export interface AiWorldSummary {
  tick: number;
  /** Same clock in human units, for a model that reasons better in time. */
  minutes: number;
  /** Fraction of the map this seat has explored, 0..1. */
  explored: number;
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
    /** A hostile fighter visible within sight of the castle right now. */
    underAttack: boolean;
  };
  rivals: RivalSummary[];
  /** Camps on explored ground only — a camp in the dark does not exist. */
  bandits: { camps: number; nearestCamp: number };
}

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

export function summarizeForSeat(world: World, brain: AiBrain): AiWorldSummary {
  const playerId = brain.playerId;
  const strategy = brain.strategy;
  const vision = brain.vision;
  const player = world.players[playerId];
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
  /** Rival buildings on explored ground, and camps likewise. */
  const rivalBuildings = new Map<Owner, number>();
  let camps = 0;
  let nearestCamp = -1;
  for (const b of world.buildings.values()) {
    if (b.dead) continue;
    if (b.owner === playerId) {
      buildings[b.type] = (buildings[b.type] ?? 0) + 1;
      continue;
    }
    if (!vision.hasExplored(b.x + b.w / 2, b.y + b.h / 2)) continue;
    if (b.type === 'banditCamp') {
      camps++;
      if (castle) {
        const d = Math.abs(b.x + 1 - bx) + Math.abs(b.y + 1 - by);
        if (nearestCamp < 0 || d < nearestCamp) nearestCamp = d;
      }
    } else {
      rivalBuildings.set(b.owner, (rivalBuildings.get(b.owner) ?? 0) + 1);
    }
  }
  for (const u of world.units.values()) {
    if (u.dead || u.owner !== playerId) continue;
    if (u.kind === 'serf') serfs++;
    else if (u.kind === 'knight' || u.kind === 'spearman' || u.kind === 'archer') {
      army[u.kind]++;
    }
  }

  const intelByOwner = new Map(brain.intelReport().map((r) => [r.owner, r]));
  const rivals: RivalSummary[] = [];
  for (const rival of world.players) {
    if (rival.id === playerId) continue;
    const theirCastle = castleOf(world, rival.id);
    const found =
      theirCastle !== undefined &&
      vision.hasExplored(theirCastle.x + theirCastle.w / 2, theirCastle.y + theirCastle.h / 2);
    const report = intelByOwner.get(rival.id);
    const intel =
      report && world.tick - report.tick <= AI_INTEL.trustFor
        ? {
            ageTicks: world.tick - report.tick,
            heavy: report.counts.heavy,
            light: report.counts.light,
            ranged: report.counts.ranged,
            total: report.total,
          }
        : null;
    rivals.push({
      id: rival.id,
      alive: rival.alive,
      found,
      buildings: rivalBuildings.get(rival.id) ?? 0,
      distance:
        found && castle && theirCastle
          ? Math.abs(theirCastle.x + 1 - bx) + Math.abs(theirCastle.y + 1 - by)
          : -1,
      intel,
    });
  }

  let exploredTiles = 0;
  const tiles = tileCount(world.map.size);
  for (let i = 0; i < tiles; i++) exploredTiles += vision.explored[i]!;

  const techs = player?.techs;
  return {
    tick: world.tick,
    minutes: Math.round((world.tick * TICK_MS) / 60_000),
    explored: Math.round((exploredTiles / tiles) * 100) / 100,
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
        marchConfidence: strategy.marchConfidence,
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
      underAttack: castle ? hostileNear(world, vision, playerId, bx, by, UNDER_ATTACK_RADIUS) : false,
    },
    rivals,
    bandits: { camps, nearestCamp },
  };
}
