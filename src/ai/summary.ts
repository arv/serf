import { TICK_MS } from '../sim/defs/balance.ts';
import { UNIT_DEFS } from '../sim/defs/units.ts';
import { buildingDef } from '../sim/defs/buildings.ts';
import { AI_INTEL, hostileNear, type AiBrain } from '../sim/systems/ai.ts';
import type { Building, Owner } from '../sim/entities.ts';
import { popCapOf, populationOf } from '../sim/population.ts';
import { playMin, playMax } from '../sim/map.ts';
import { tileIdx } from '../shared/grid.ts';
import type { World } from '../sim/world.ts';
import { GOOD_KEYS } from '../sim/defs/goods.ts';
import { goodEntries } from '../sim/defs/goods.ts';
import { UnitTypeId } from '../sim/defs/units.ts';
import { BuildingTypeId } from '../sim/defs/buildings.ts';
import { BUILDING_KEYS } from '../sim/defs/buildings.ts';
import { TECH_KEYS } from '../sim/defs/techs.ts';
import { BuildingState } from '../sim/entities.ts';
import { AI_STRATEGY_KEYS } from '../sim/defs/aiStrategies.ts';

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
  /** The biggest their roster has been inside the trust window. The most
   * accurate number the brain has about their strength — `total` forgets
   * whoever has not been seen lately, and measured against the truth this
   * one is a fifth closer (src/sim/systems/ai.ts, RivalPicture). */
  peak: number;
}

/**
 * How a rival's opening looked, in minutes, with -1 for "has not happened
 * yet" (or, for `buildingsAtFive`, "minute five has not struck").
 *
 * Three facts, because three is what separates a rush from a boom without
 * asking a model to do arithmetic: when their first soldier turned up, when
 * one of them first reached our gates, and how much village we had found by
 * minute five. All observed under the same fog as everything else here — a
 * rival who has never been scouted shows -1s, which is honest ignorance and
 * not a claim that they are peaceful.
 */
export interface RivalContact {
  firstSoldierMin: number;
  firstAttackMin: number;
  buildingsAtFive: number;
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
  /** Their opening, as first contact recorded it. */
  contact: RivalContact;
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
    /** Standing counts by type, construction sites included. Keyed by the
     * building's spelling rather than its id: this whole summary is
     * JSON.stringify'd into the model's prompt, and a 1B model shown
     * `{"5":2}` has been told nothing. */
    buildings: Record<string, number>;
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

/** A tick a first-contact fact happened at, as a whole minute — and -1
 * straight through, because "never" must not read as "at minute zero". */
function inMinutes(tick: number): number {
  return tick < 0 ? -1 : Math.round((tick * TICK_MS) / 60_000);
}

function castleOf(world: World, owner: Owner): Building | undefined {
  for (const b of world.buildings.values()) {
    if (!b.dead && b.owner === owner && buildingDef(b.type).storage && b.state === BuildingState.built) {
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
    for (const [good, n] of goodEntries(castle.stock)) {
      if (n > 0) stock[GOOD_KEYS[good]] = n;
    }
  }

  const buildings: Record<string, number> = {};
  let serfs = 0;
  const army = { knight: 0, spearman: 0, archer: 0 };
  /** Rival buildings on explored ground, and camps likewise. */
  const rivalBuildings = new Map<Owner, number>();
  let camps = 0;
  let nearestCamp = -1;
  for (const b of world.buildings.values()) {
    if (b.dead) continue;
    if (b.owner === playerId) {
      const key = BUILDING_KEYS[b.type];
      buildings[key] = (buildings[key] ?? 0) + 1;
      continue;
    }
    if (!vision.hasExplored(b.x + b.w / 2, b.y + b.h / 2)) continue;
    if (b.type === BuildingTypeId.banditCamp) {
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
    if (u.kind === UnitTypeId.serf) serfs++;
    else if (u.kind === UnitTypeId.knight) army.knight++;
    else if (u.kind === UnitTypeId.spearman) army.spearman++;
    else if (u.kind === UnitTypeId.archer) army.archer++;
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
      report && report.tick >= 0 && world.tick - report.tick <= AI_INTEL.trustFor
        ? {
            ageTicks: world.tick - report.tick,
            heavy: report.counts.heavy,
            light: report.counts.light,
            ranged: report.counts.ranged,
            total: report.total,
            peak: report.peak,
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
      contact: {
        firstSoldierMin: inMinutes(report?.firstSoldierTick ?? -1),
        firstAttackMin: inMinutes(report?.firstAttackTick ?? -1),
        buildingsAtFive: report?.buildingsAtFive ?? -1,
      },
    });
  }

  // Coverage of the PLAYABLE valley. Vision can never reach the scenery
  // margin — units cannot enter it — and on every generated map the margin
  // is over half of all tiles, so measured over the full grid a seat that
  // had scouted the entire valley reported well under half to a prompt
  // that calls this "your map coverage, 0-1". The model was told the map
  // was mostly unscouted forever.
  let exploredTiles = 0;
  const p0 = playMin(world.map);
  const p1 = playMax(world.map);
  for (let y = p0; y < p1; y++) {
    for (let x = p0; x < p1; x++) {
      exploredTiles += vision.explored[tileIdx(x, y, world.map.size)]!;
    }
  }
  const tiles = world.map.play * world.map.play;

  const techs = player?.techs;
  return {
    tick: world.tick,
    minutes: Math.round((world.tick * TICK_MS) / 60_000),
    explored: Math.round((exploredTiles / tiles) * 100) / 100,
    seat: {
      id: playerId,
      strategyId: AI_STRATEGY_KEYS[strategy.id],
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
      researched: techs ? techs.researched.map((t) => TECH_KEYS[t]) : [],
      researching: techs?.active === undefined ? null : TECH_KEYS[techs.active.tech],
      underAttack: castle ? hostileNear(world, vision, playerId, bx, by, UNDER_ATTACK_RADIUS) : false,
    },
    rivals,
    bandits: { camps, nearestCamp },
  };
}
