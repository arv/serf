import { tileCount, tileIdx, tileX, tileY } from '../../shared/grid.ts';
import {
  ALL_ECONOMY_RULES,
  runEconomyRules,
  type EconomyRuleId,
  type RuleContext,
} from '../economyRules.ts';
import { exactDist } from '../../shared/math.ts';
import {
  findResourcesNear,
  nearestResource,
  playMin,
  playMax,
  RESOURCE_CODE,
  Terrain,
  TileResource,
  tileBlocks,
} from '../map.ts';
import { SeatVision } from '../visibility.ts';
import { campCorners, startLayout } from '../world.ts';
import {
  BUILDING_DEFS,
  buildingDef,
  gatherOrigin,
  garrisonRoom,
  gatherRecipeOf,
  OUTPUT_CAP,
  repairBill,
  type BuildingTypeId,
} from '../defs/buildings.ts';
import { TECH_DEFS, type TechId } from '../defs/techs.ts';
import { UNIT_DEFS, WEAPON_OF, type UnitClass, type UnitTypeId } from '../defs/units.ts';
import { addGarrison, classHp, damageEquivalent, shouldCommit, type Force } from '../combatOdds.ts';
import { HIRE_QUEUE_CAP, HIRE_SERF_COST } from '../defs/balance.ts';
import { hasRoomToHire, plannedPopCapOf, populationOf } from '../population.ts';
import type { AiStrategy, BuildAnchor, BuildStep } from '../defs/aiStrategies.ts';
import { canPlace, type World } from '../world.ts';
import { isPlayerOwner, type Building, type EntityId, type Owner } from '../entities.ts';
import type { GoodId } from '../defs/goods.ts';
import type { Unit } from '../units.ts';
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
 * what it trains, how big an army it wants and whether it defends. Every
 * AI seat is dealt a different one when the world is made, so three
 * computer opponents are three different games rather than one game three
 * times over.
 *
 * The 'steward' playbook is the original single strategy unchanged —
 * wants-vs-standing-counts build order, survival-floor hiring with a
 * research reserve, a fixed research queue, a sword-aware barracks queue,
 * rally-then-attack army logic — because the winnable-campaign regression
 * drives it.
 *
 * The brain plays under the same fog a human seat does. It keeps its own
 * SeatVision — the exact filter the server runs for humans (sync.ts) — and
 * anything that carries intelligence goes through it: an enemy building is
 * a target only on explored ground, a hostile at the gates only counts if
 * it stands in lit ground. What is NOT filtered is what the server ships
 * every human whole at init: terrain, heights and the natural resource
 * layout are public knowledge, so reading seams and shores off the map is
 * not a cheat. Finding the enemy therefore takes legwork, in two shapes:
 * while the muster builds, the fastest idle soldier tours the map's
 * landmarks (rival starts and camp seeds — public map lore) as a lone
 * scout; and a full muster with nothing on its map to march at sweeps the
 * dark ground itself.
 *
 * Scouting is also what a counter is made of. Every rival fighter seen in
 * lit ground goes into a per-rival intelligence picture, and once war has
 * an address the scout re-walks living rivals' doorsteps as that picture
 * goes stale. What it brings back bends production: smiths beyond the
 * first forge the weapon that beats the enemy's dominant class, and the
 * barracks trains its bearer first when it is at hand — hedges, both,
 * with the playbook's own line kept alongside. Vision and intel are
 * brain-local memory like the pacing fields: a host restart hands the
 * seat a darkened map and it simply scouts again.
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
  /**
   * The other way a muster bar is never met: not two exhausted equals but
   * an army that has stopped growing and started dying. The impatience
   * ramp walks the bar down on a slow clock from `staleAfter`; an army
   * bleeding to raids can shrink faster than the bar falls and stay under
   * it forever — the bar chases the army down and never catches it. So
   * when no soldier has been added for this long, the army is as big as it
   * is getting: the bar drops to the force actually standing (never below
   * `staleFloor`, the smallest force the impatience ramp itself thinks
   * worth marching), and the seat fights with what it has rather than
   * waiting for soldiers that are no longer coming. Set well past any gap
   * a working barracks produces — a course is a few hundred ticks — so a
   * seat that is still training never sees it.
   */
  growthStallAfter: 4_000,
  /**
   * Past staleness lies desperation. The impatience rule walks the bar
   * down to `staleFloor`, but a war of mutual exhaustion can leave every
   * surviving seat unable to field even that — seed 42 under fog reaches
   * exactly there: one seat with two archers and no wood for a third bow,
   * the other with no army and no silver, forever. After this long without
   * a march the floor gives way too, and a seat sends whatever it has —
   * two archers razing an undefended castle end a game nothing else would.
   * It also outranks the combat prediction: a hold (#oddsSay) older than
   * this stops binding, or a seat whose scout dutifully keeps the enemy
   * garrison inside the intel trust window would renew its veto forever.
   */
  forlornAfter: 30_000,
} as const;

/**
 * The stall watchdog.
 *
 * A village can reach a state its playbook has no move for. The build order
 * is a one-shot list of placements, so once every step stands there is
 * nothing left to place; hiring wants silver; hauling wants a loose serf.
 * Seed 9 is the calibration case, and it is not the resource exhaustion it
 * looks like from outside: at t=40000 both seats hold FULL extractor huts
 * (every gatherer capped at OUTPUT_CAP, one of them sitting on more silver
 * than a hire costs) and have exactly zero free serfs, every hand having been
 * bound to a post or spent as a barracks recruit. Nothing hauls, so nothing
 * reaches the storehouse, so nothing can be bought, so no hand is ever
 * hired. Eighty thousand ticks of a village that is fully employed and
 * completely paralysed.
 *
 * No amount of tuning reaches that. What reaches it is noticing, so the
 * brain samples a handful of integers on a slow clock and calls the seat
 * stalled when none of them has moved across the whole window. The rules
 * that answer are all in sim/economyRules.ts.
 *
 * One of them is gated on this reading: `resiteExtractor`, which sells a
 * hut out from under its gatherer and so had better be sure. The rest read
 * a condition instead, and the distinction is the point rather than an
 * erosion of it. `stalled` is an INFERENCE about a village — nothing has
 * moved in twelve minutes, so something must be wrong — and it is the right
 * gate for a rule that pays to guess. The recovery pair `freeCappedHauler`
 * and `resumeDrainedPost`, and the hold `handsBeforeSoldiers`, read the
 * dead end DIRECTLY: hands under the playbook's survivalFloor. That is not
 * a guess wanting corroboration, and waiting for the window to corroborate
 * it costs fourteen thousand ticks a raided seat usually does not have —
 * see those rules' comments and the 2026-08-23 correction in
 * docs/plan-ai-robustness.md. (The production-phase rules — tools, forges,
 * the barracks queue — are steering rather than rescue, and have never been
 * gated on anything.)
 *
 * What every gate protects is the same guarantee: a seat that is going
 * somewhere, with its people, emits exactly the commands it always did.
 *
 * Brain-local memory like `#intel` and `#vision`: never serialized, and the
 * determinism story is unchanged because the window is a pure function of
 * ticks the brain has already seen and reaches the sim only through the
 * commands it was always allowed to send.
 */
export const AI_STALL = {
  /** Ticks between progress samples. A multiple of `decisionInterval`, so
   * the sample lands on a beat rather than near one. */
  samplePeriod: 2_000,
  /**
   * Samples in the window. The shortest stall this can report is therefore
   * `(window - 1) * samplePeriod` = 14000 ticks of a village where not one
   * of the four scalars moved — about twelve minutes of game time, and
   * comfortably longer than any lull a live economy produces, since a
   * single haul landing moves the storehouse total.
   */
  window: 8,
  /**
   * Nothing before this reads as a stall. An opening is allowed to be slow
   * — the first woodcutter is not up yet and the pile has not moved — and a
   * decided game is normally over by tick 12k anyway, so the watchdog only
   * ever meets the standoffs.
   */
  graceUntil: 20_000,
} as const;

/**
 * How battered a building has to be before a seat pays to mend it. Not every
 * scratch is worth a mason: the bill is charged per point of damage, so
 * repairing at the first arrow costs the same materials in the end and spends
 * the haulage pool in dribs.
 */
export const AI_REPAIR_BELOW = 0.7;

/** How far from a target a defender still counts as defending it. The game's
 * longest leash is `acquireRadius * 1.6` = 12.8 tiles, so twelve covers
 * everything that would actually join the fight. */
const DEFENDER_RADIUS = 12;

export const AI_INTEL = {
  /** A sighting older than this says nothing about tomorrow's battle. */
  trustFor: 8_000,
  /** Walk a rival's doorstep again when its picture is older than this. */
  refreshAfter: 4_000,
  /** Fewer fighters than this in one look is an anecdote, not an army. */
  minSighting: 3,
  /**
   * How often the picture writes down how big the rival's army looked. A
   * decision beat lands every 20 ticks; sampling each one would fill the
   * series with the same number three hundred times over and say nothing
   * about trend. Twenty-five seconds apart, twelve deep, is twenty-five
   * minutes of history in a match that resolves in eleven — and it is
   * BOUNDED, which is the part that matters for a 120k-tick standoff.
   */
  samplePeriod: 500,
  seriesLen: 12,
  /**
   * "How many buildings did they have at minute five" — the one snapshot
   * worth branching on, because it is where a boomer and a rusher have
   * already parted ways. Twenty ticks a second, sixty seconds a minute.
   */
  earlyMark: 5 * 60 * 20,
  /** How close one of their soldiers has to come before we call it an
   * attack landing rather than a patrol. Same scale as the summary's
   * underAttack radius — this is the AI's own definition of "at my gates". */
  raidRadius: 12,
} as const;

/**
 * One reading of whether the village is going anywhere. Four integers, all
 * of which a working economy moves within a couple of thousand ticks:
 * heads under the cap, finished buildings, sites under construction, and
 * the total goods in the storehouse — the last standing in for throughput,
 * because a single haul landing changes it.
 */
interface StallSample {
  pop: number;
  built: number;
  sites: number;
  stock: number;
}

/** One look at a rival's forces: when it was taken, and what stood there. */
interface Sighting {
  tick: number;
  counts: { heavy: number; light: number; ranged: number };
  total: number;
}

/** How big a rival's army looked at one moment, for the trend series. */
interface IntelSample {
  tick: number;
  total: number;
}

/**
 * What one seat has assembled about one rival.
 *
 * The roster is the change that matters. The picture used to be a single
 * snapshot — the largest group seen in one instant — and that is why a seat
 * marched believing the enemy had three soldiers: three is all a lone scout
 * ever lights at once, and the next three walking past the same corner
 * replaced the number rather than adding to it. A soldier is a soldier
 * though, and a lord who has watched six different men pass his watchtower
 * knows he faces six. So sightings accumulate by unit id, and a man leaves
 * the list only when the trust window closes over the last look at him.
 *
 * Not when he dies, which is the counter-intuitive part and the one thing
 * here that was chosen by measurement rather than by taste. Striking the
 * fallen off the roster is the honest-looking rule and it reads the valley
 * *worse*: over twelve unadvised matches, scored against the truth at 778
 * sample points on identical trajectories,
 *
 *     estimator                          believes   mean abs error   blind
 *     the old single snapshot               2.07         3.19        13.8%
 *     roster, striking the fallen off       1.69         3.44        32.9%
 *     roster, keeping them                  2.69         2.88        10.8%
 *     roster peak over the window           3.35         2.54         6.7%
 *
 * against a real army averaging 5.09. Striking the dead off is a *standing
 * army* estimate and the barracks refills faster than the trust window
 * closes, so it is wrong sooner than it is right. What the roster actually
 * measures is how much war a rival has shown itself able to field lately —
 * which is the question a posture wants answered anyway.
 *
 * Bounded on purpose (see #override): the roster is pruned to the trust
 * window every beat and the series is a twelve-entry ring, so a 120k-tick
 * standoff costs the same memory as the opening.
 */
interface RivalPicture {
  /** Soldiers seen and not yet written off, by unit id. */
  roster: Map<number, { tick: number; cls: UnitClass }>;
  /** How the roster has grown, oldest first, `seriesLen` deep. */
  series: IntelSample[];
  /** Last tick anything of theirs stood in our light. -1 = never. */
  seenTick: number;
  /**
   * Last tick the roster held a real force (`minSighting` or more), as
   * opposed to a straggler. This is the clock the re-scout reads, and the
   * distinction is the whole point: glimpsing one raider at the gates used
   * to reset the refresh timer as if the yard had been read, so a seat under
   * steady harassment never once looked at what was actually massing.
   */
  richSeenTick: number;
  /** Last tick a sample was taken, so the series keeps its spacing. */
  sampledTick: number;
  /** First-contact facts, all ticks, all -1 until they happen. */
  firstSoldierTick: number;
  firstAttackTick: number;
  /** Their buildings on our explored ground when the fifth minute struck;
   * -1 before it does. */
  buildingsAtFive: number;
  /** Doorstep reads spent on them — diagnostics, so "the schedule never
   * fires" and "the schedule fires and does not help" cannot print the
   * same number (the lesson of the march gate). */
  reads: number;
}

/** One rival's picture, flattened for anything outside the brain. */
export interface IntelReport {
  owner: Owner;
  /** Freshest observation of them, -1 if never seen. */
  tick: number;
  /** Soldiers of theirs currently on the roster. */
  total: number;
  /** The biggest the roster has been inside the trust window — the most
   * accurate single number this brain has about a rival's strength (see
   * RivalPicture's table), and the one a posture should read. */
  peak: number;
  counts: { heavy: number; light: number; ranged: number };
  firstSoldierTick: number;
  firstAttackTick: number;
  buildingsAtFive: number;
  /** Doorstep reads spent on this rival so far. */
  reads: number;
  /** Oldest kept sample and newest, so a reader can see the slope without
   * carrying the whole series: null until two samples exist. */
  trend: { fromTick: number; from: number; toTick: number; to: number } | null;
}

/**
 * The counter to each enemy class, straight off COUNTER_TABLE's rows: the
 * class that deals 1.5x INTO it, as the unit to train and the forge recipe
 * that arms one. (Ranged beats heavy, heavy beats light, light beats
 * ranged; recipeOptions order is [spear, sword, bow].)
 */
const COUNTER_PICK: Record<UnitClass, { unit: UnitTypeId; recipe: number }> = {
  heavy: { unit: 'archer', recipe: 2 },
  light: { unit: 'knight', recipe: 1 },
  ranged: { unit: 'spearman', recipe: 0 },
};

const MILITARY = new Set<UnitTypeId>(['knight', 'spearman', 'archer']);

/** Fewest soldiers that may be sent on a prediction alone. The impatience
 * ramp already treats three as the smallest force worth marching
 * (AI_PACING.staleFloor), and a good prediction should not be able to talk a
 * seat into emptying its yard. */
const MIN_SORTIE = 3;


const ANCHOR_RESOURCE: Record<Exclude<BuildAnchor, 'base' | 'water'>, number> = {
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
  /** The growth-stall clamp's whole memory (AI_PACING.growthStallAfter):
   * how many soldiers stood at the last beat, and the last tick the count
   * grew. A march restamps the clock too — the survivors get the same
   * grace to grow again before the bar drops to whatever walked home. */
  #lastArmyCount = 0;
  #armyGrewTick = 0;
  /** Diagnostics for the march gate: how often it was asked, and how often
   * it said no. A gate that never fires and a gate that fires without
   * helping produce the same win rate, and telling them apart is the whole
   * difference between "tune it" and "the estimate never arrives". */
  #oddsAsked = 0;
  #oddsVetoed = 0;
  #oddsBlind = 0;
  #oddsCamps = 0;
  /**
   * Knobs laid over the playbook — the LLM strategist's dial (src/ai/).
   * Worker memory only, never serialized: the world's determinism story is
   * untouched because overrides reach the sim solely through the commands
   * this brain already emits, and a reloaded save simply runs the printed
   * playbook until the next advice lands.
   */
  #override: Partial<AiStrategy> | null = null;
  /** What this seat has actually observed — the same filter humans play
   * under. Recomputed at every decision beat, remembered between them. */
  #vision: SeatVision;
  /** The lone scout out walking the landmarks, -1 when nobody is. */
  #scoutId = -1;
  /** Where the scout is currently headed, -1 when it has no goal. */
  #scoutGoal = -1;
  /** The leg of the approach last ordered (gate or watch tile), -1 none.
   * Ordered again while standing still = the walk failed; move on. */
  #scoutLeg = -1;
  /** Where the full-muster sweep is headed, -1 when it is not out. */
  #sweepGoal = -1;
  /** Goals a search stood down in front of, or died on the way to — an
   * unexplored island or a walled-off valley never lights up, and without
   * this the search would re-pick the same impossible tile forever. */
  #unreachable = new Set<number>();
  /** What scouting has assembled about each rival: a running roster of the
   * soldiers seen, a trend series over it, and the first-contact facts.
   * This is what the counter-forging and the archetype read. */
  #intel = new Map<Owner, RivalPicture>();
  /** Minute five happens once; the building count it takes is stamped on
   * every rival's picture at the first beat past it. */
  #earlyMarkTaken = false;
  /** When each rival's doorstep was last read — or the read failed — by
   * owner. Kept apart from the sightings on purpose: a walk that saw
   * nothing must reset the clock without erasing what an earlier look
   * actually saw, or a failed errand would blind the counter-forging to
   * a picture that is still inside its trust window. */
  #intelAttempt = new Map<Owner, number>();
  /** The rival whose doorstep the scout is walking to read, -1 when the
   * scout is on discovery (or home). */
  #scoutIntel: Owner = -1;
  /**
   * Per tower: the tick its levy may stand down, set forward every beat an
   * enemy is still in sight of it.
   *
   * The hold is the whole point. Threat is read per beat and a raider walks
   * in and out of a radius constantly, so calling and standing down on the
   * raw reading would flap — and each flap marches the villagers down the
   * stairs and walks a fresh pair back up, which costs more haulage than
   * leaving them there ever would. Keyed by building id, and stale entries
   * cost a number apiece: a razed tower's is never read again.
   */
  #levyHold = new Map<EntityId, number>();
  /**
   * The stall watchdog's rolling window (AI_STALL): one packed sample per
   * `samplePeriod`, oldest first. Brain-local like everything above it.
   */
  #progress: StallSample[] = [];
  /** Tick the next sample is due. */
  #sampleDue: number = AI_STALL.samplePeriod;
  /** Beats this seat has read as stalled, and recovery orders sent. Both
   * for the lab: a watchdog that never fires and one that fires without
   * helping produce the same undecided count, and telling them apart is
   * the difference between "tune it" and "it never saw the stall". */
  #stalledBeats = 0;
  #recoveries = 0;
  /**
   * Which economy rules this seat runs (sim/economyRules.ts). Every rule by
   * default, which is the behaviour that was measured and shipped; the lab
   * narrows it to ablate one rule at a time, and an empty set turns the
   * layer off entirely. Brain-local like every other field here.
   */
  #rules: ReadonlySet<EconomyRuleId> = new Set(ALL_ECONOMY_RULES);

  /** Run only these rules. The lab's ablation handle; the game never calls
   * it, so a shipped seat always runs the whole table. */
  setEconomyRules(ids: readonly EconomyRuleId[]): void {
    this.#rules = new Set(ids);
  }

  constructor(playerId: Owner, strategy: AiStrategy, mapSize: number) {
    this.playerId = playerId;
    this.strategy = strategy;
    this.#vision = new SeatVision(mapSize);
  }

  /** Lay advice over the playbook (null clears it). The caller vouches for
   * the values — parseAdvice in src/ai/advice.ts is the gate. */
  setOverride(override: Partial<AiStrategy> | null): void {
    this.#override = override;
  }

  /**
   * What this seat has observed, for the LLM strategist's summary
   * (src/ai/summary.ts) — the strategist must know exactly what the brain
   * knows, no more. As of the last decision beat, so at most one beat
   * stale; read-only by convention.
   */
  get vision(): SeatVision {
    return this.#vision;
  }

  /** Copies of the current intel pictures, freshness included: the summary
   * shows the model stale sightings AS stale rather than hiding them. */
  /** Read by the lab so a null measurement is diagnosable rather than merely
   * disappointing: a gate that never fires and a gate that fires without
   * helping print the same win rate. */
  oddsReport(): { asked: number; vetoed: number; blind: number; camps: number } {
    return {
      asked: this.#oddsAsked,
      vetoed: this.#oddsVetoed,
      blind: this.#oddsBlind,
      camps: this.#oddsCamps,
    };
  }

  /** What the stall watchdog saw, for the same reason oddsReport() exists:
   * the harness counts stalls instead of inferring them from `undecided`. */
  stallReport(): { beats: number; recoveries: number; stalled: boolean } {
    return {
      beats: this.#stalledBeats,
      recoveries: this.#recoveries,
      stalled: this.#windowIsFlat(),
    };
  }

  intelReport(): IntelReport[] {
    return [...this.#intel].map(([owner, pic]) => {
      const muster = rosterMuster(pic);
      const first = pic.series[0];
      const last = pic.series[pic.series.length - 1];
      let peak = muster.total;
      for (const s of pic.series) if (s.total > peak) peak = s.total;
      return {
        owner,
        tick: pic.seenTick,
        total: muster.total,
        peak,
        counts: muster.counts,
        firstSoldierTick: pic.firstSoldierTick,
        firstAttackTick: pic.firstAttackTick,
        buildingsAtFive: pic.buildingsAtFive,
        reads: pic.reads,
        trend:
          first && last && first !== last
            ? { fromTick: first.tick, from: first.total, toTick: last.tick, to: last.total }
            : null,
      };
    });
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
    const s = this.#override ? { ...this.strategy, ...this.#override } : this.strategy;
    const p = world.players[this.playerId];
    if (!p || !p.alive || world.outcome.state !== 'playing') return [];
    this.#vision.recompute(world, this.playerId);
    const commands: SimCommand[] = [];
    const mine = ownedBuildings(world, this.playerId);
    const sh = mine.find((b) => b.type === 'storehouse' && b.state === 'built');
    // Watching comes before the castle check, and before every decision
    // below reads the picture: a seat about to lose its last storehouse has
    // no orders left to give, but what it can see is still worth filing.
    this.#observeRivals(world, sh ? sh.x + 1 : -1, sh ? sh.y + 1 : -1);
    if (!sh) return commands; // one tick from elimination; nothing to do
    const baseX = sh.x + 1;
    const baseY = sh.y + 1;
    const stock = sh.stock as Record<string, number>;
    const techs = p.techs;
    const researched = (id: TechId): boolean => techs.researched.includes(id);
    const has = (type: BuildingTypeId): boolean => mine.some((b) => b.type === type);
    const countOf = (type: BuildingTypeId): number => mine.filter((b) => b.type === type).length;

    // --- The walls ------------------------------------------------------------
    // Before the build order and well before the army: whether villagers
    // are holding a tower is a question about the next few seconds, and it
    // is answered by what can be seen right now rather than by anything the
    // rest of this method decides.
    this.#manTowers(world, mine, commands);

    // --- The stall watchdog (AI_STALL) ---------------------------------------
    // Sampled first so the reading below is this beat's, and so a seat that
    // is going somewhere pays one comparison of four integers and nothing
    // else. `stalled` is false for every healthy game, which is what makes
    // the rest of this method byte-identical to what it always was.
    this.#sampleProgress(world, mine, stock);
    const stalled = world.tick > AI_STALL.graceUntil && this.#windowIsFlat();
    if (stalled) this.#stalledBeats++;

    // --- Build order: desired counts vs standing counts (rebuilds losses) ---
    // Housing is in here, as steps like any other: a playbook decides for
    // itself when in the plan it stops to raise a roof. Ordering matters —
    // an opening that lays a house before the woodcutter spends the whole
    // starting woodpile on beds it has nobody to fill, and never recovers.
    let placed = false;
    for (const step of s.build) {
      if (step.after && !researched(step.after)) continue;
      if (step.needs && !has(step.needs)) continue;
      const desired = step.more && researched(step.more.after) ? step.more.count : step.count;
      if (countOf(step.type) >= desired) continue;
      // Price before ground. Both tests are pure reads and the step that
      // wins is still the first one that is BOTH affordable and placeable,
      // so the beat plays out identically — but spotFor is a spiral search
      // over the play area (and, anchored, a resource or shore scan before
      // that), and a broke seat used to pay it for every unmet step on the
      // list, every beat, only to throw the answer away.
      if (!affordable(BUILDING_DEFS[step.type].cost as Record<string, number>, stock)) continue;
      const spot = spotFor(world, step, baseX, baseY);
      if (!spot) continue;
      commands.push({ kind: 'placeBuilding', building: step.type, x: spot.x, y: spot.y });
      placed = true;
      break; // one placement per decision to keep hauling focused
    }

    // --- Housing: the roofs the plan did not foresee -------------------------
    // A build order names a fixed number of houses, but a match that runs
    // long fills them: every soldier the barracks turns out is another head
    // under the cap, and a seat that hits it stops replacing its dead. This
    // is the standing top-up — only on a beat the plan had nothing to place,
    // and only once the village is nearly full, so it never competes with
    // the opening. Sites count toward the planned cap, so it lays one house
    // at a time rather than four on the beat the last bed fills.
    if (
      !placed &&
      countOf('house') < s.houseLimit &&
      plannedPopCapOf(world, this.playerId) - populationOf(world, this.playerId) <
        s.housingHeadroom &&
      affordable(BUILDING_DEFS.house.cost as Record<string, number>, stock)
    ) {
      const spot = findSpot(world, 'house', baseX, baseY);
      if (spot) commands.push({ kind: 'placeBuilding', building: 'house', x: spot.x, y: spot.y });
    }

    // --- Repairs: patch what the raiders left standing -----------------------
    // Mending is half the price of raising the building again and it keeps
    // the post staffed, so the worst-hurt building gets the order — but only
    // when the bill is already on the shelf. A repair ordered against an
    // empty storehouse would pin the haulage pool to a wall while the
    // village waits for stone it hasn't quarried yet.
    let worst: Building | undefined;
    for (const b of mine) {
      if (b.state !== 'built' || b.repairNeeds || b.repairPending !== undefined) continue;
      const max = BUILDING_DEFS[b.type].hp;
      if (b.hp >= max * AI_REPAIR_BELOW) continue;
      if (!worst || b.hp / max < worst.hp / BUILDING_DEFS[worst.type].hp) worst = b;
    }
    if (worst) {
      const bill = repairBill(worst.type, BUILDING_DEFS[worst.type].hp - worst.hp);
      if (affordable(bill as Record<string, number>, stock)) {
        commands.push({ kind: 'setBuildingRepair', buildingId: worst.id, repair: true });
      }
    }

    // --- Population: keep loose serfs around ---------------------------------
    let serfCount = 0;
    for (const u of world.units.values()) {
      if (!u.dead && u.owner === this.playerId && u.kind === 'serf') serfCount++;
    }
    const researchPending = s.researchOrder.some((id) => !techs.researched.includes(id));
    // The two free stall rules, and the reason they come first: neither
    // destroys anything, both are undone the moment the seat moves again,
    // and both undo a hold the playbook only ever meant as pacing.
    //
    // Release the hoarded silver — a reserve kept for a tech the seat can
    // no longer afford is silver held back from the one purchase that could
    // restart it. And ignore the growth gate: `growthAfter` defers hiring
    // behind a tech a stalled seat may never reach, which turns a pacing
    // choice into a life sentence.
    const growing = s.growthAfter === null || researched(s.growthAfter) || stalled;
    const reserve = stalled ? 0 : s.researchReserve;
    // Even the panic floor cannot conjure a bed. Asking anyway is harmless —
    // the sim refuses it — but a seat that knows it is full spends the beat
    // on the housing rule above instead of on an order that goes nowhere.
    // A hire the sim would refuse is not a hire. Beds are only half of it:
    // `applyCommand` also turns one away when the storehouse's queue is
    // already HIRE_QUEUE_CAP deep, and the guard below has to know whether
    // four silver is actually leaving the shelf — a flag that says "ordered"
    // where the sim says "refused" holds back research for a hire that never
    // happens. Same predicate on both branches, so this only ever suppresses
    // an order that would have been a no-op.
    const room = hasRoomToHire(world, this.playerId) && (sh.hireQueue ?? 0) < HIRE_QUEUE_CAP;
    // Whether this beat has already spent four silver on a hand. The
    // research guard below reads it, because commands are applied in the
    // order they are pushed and a hire pushed here is money the shelf still
    // shows but no longer has.
    let hiring = false;
    if (room && serfCount < s.survivalFloor && (stock.silver ?? 0) >= HIRE_SERF_COST) {
      commands.push({ kind: 'hireSerf' });
      hiring = true;
    } else if (
      room &&
      growing &&
      serfCount < s.serfTarget &&
      (stock.silver ?? 0) >= HIRE_SERF_COST + (researchPending ? reserve : 0)
    ) {
      commands.push({ kind: 'hireSerf' });
      hiring = true;
    }

    // --- Breaking the stall: the rules that cost something -------------------
    // Mostly reached only by a seat the window says has not moved in twelve
    // minutes. `freeCappedHauler` is the exception now (and
    // `resumeDrainedPost`, which has to be able to undo it), for the reason
    // its own comment gives: a village short of hands beside a capped post
    // is not an inference the watchdog has to draw, it is the dead end
    // itself, and a seat is routinely razed or the match over before a
    // fourteen-thousand-tick window can confirm what is already true.
    // Everything above this line is still the game as it was played before
    // the watchdog existed, and so is everything below it for a seat that
    // has its people.
    const ruleCtx: RuleContext = {
      world,
      owner: this.playerId,
      mine: sortedById(mine),
      stock,
      serfCount,
      stalled,
      strategy: s,
      researched,
      counter: this.#counterPlan(world),
    };
    if (this.#rules.size > 0) {
      const recovery = runEconomyRules(ruleCtx, this.#rules, 'recovery');
      commands.push(...recovery.commands);
      this.#recoveries += recovery.fired.length;
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
        // Hands first, when there are barely any. Every tech is priced in
        // silver and so is a hire, and the panic branch above only fires on
        // the beat the shelf already holds the four — so a seat rebuilding
        // after a raid could spend its way past the hire forever, three
        // silver at a time, and never notice. Below the floor a tech waits
        // until the NEXT hire is still affordable after it, counting the one
        // this beat may already have ordered: `stock` is the shelf as
        // logistics last left it, and a hireSerf pushed above is applied
        // first, so ten silver against a six-silver tech is four for the
        // hand, six for the tech, and nothing at all for the hand after.
        // Above the floor this is the reserve's job and the reserve keeps
        // it: the guard cannot fire on a seat with its people. Nor on one
        // with nowhere to put them — silver held back for a hire there is no
        // bed for is silver held back for nothing, so a full village
        // researches.
        const leavesHireMoney =
          serfCount >= s.survivalFloor ||
          !room ||
          (stock.silver ?? 0) - (hiring ? HIRE_SERF_COST : 0) - (cost.silver ?? 0) >=
            HIRE_SERF_COST;
        if (ok && leavesHireMoney) commands.push({ kind: 'research', tech: next });
      }
    }

    // --- War production: forges and the barracks queue ----------------------
    // Both are rules now (sim/economyRules.ts) and fire here rather than
    // earlier, because command order inside a tick is load-bearing: research
    // above spends the same shelf these orders draw on.
    if (this.#rules.size > 0) {
      commands.push(...runEconomyRules(ruleCtx, this.#rules, 'production').commands);
    }

    // --- Army: rally at home until strong, then march ------------------------
    const army = [...world.units.values()].filter(
      (u) => !u.dead && u.owner === this.playerId && MILITARY.has(u.kind),
    );
    const target = pickAttackTarget(world, this.#vision, this.playerId, baseX, baseY, s.prefersRivals);
    const rallyReady = world.tick - this.#lastRallyTick > s.rallyCooldown;
    const idleFor = world.tick - this.#lastAttackTick;
    const cooled = idleFor > s.attackCooldown;
    if (army.length > this.#lastArmyCount) this.#armyGrewTick = world.tick;
    this.#lastArmyCount = army.length;
    // The bar, with the growth-stall clamp over the impatience ramp: an
    // army that has stopped growing is as big as it is getting, so waiting
    // for the playbook's full size only feeds soldiers to the raids one at
    // a time (see AI_PACING.growthStallAfter).
    let bar = mustersNeeded(s.armyAttackSize, idleFor);
    if (world.tick - this.#armyGrewTick > AI_PACING.growthStallAfter) {
      bar = Math.min(bar, Math.max(army.length, AI_PACING.staleFloor));
    }
    const headcountReady = army.length >= bar && cooled;
    /**
     * What the combat prediction says about the fight at the end of this
     * march — true go, false hold, null no opinion (the knob is off, the
     * target is a camp, or nothing has been seen of its defenders).
     *
     * Measured on this valley, the prediction is worth far more as a trigger
     * than as a brake. Instrumenting the gate over four seeds found the army
     * averaging 19.6 soldiers at the moment it marched against 6.5 real
     * defenders, with the model reading a median 99% of our own force
     * expected to survive: there was simply no bad fight to refuse. The
     * seat's flaw was never that it attacked badly, it was that it attacked
     * far too late — the same thing the posture sweeps found when `siege`,
     * which marches sooner and commits harder, beat the printed playbook by
     * eighteen points. So a favourable reading now *starts* a march the
     * headcount bar would still be waiting on, and an unfavourable one holds
     * one the bar would have allowed.
     */
    const odds = this.#oddsSay(world, army, target, s.marchConfidence);
    // Past the forlorn line even a hold expires. #oddsSay's bargain — a
    // seat that never likes its odds still eventually marches on the
    // forlorn floor — used to lean on the defenders' picture going stale
    // and the gate going blind, and a working scout makes sure it never
    // does: it re-reads the rival's yard on the refresh clock, so the
    // garrison stays inside the trust window and the veto renews itself
    // forever. The clock, not the picture, is what breaks the standoff.
    const heeded = idleFor > AI_PACING.forlornAfter ? null : odds;
    const mustered =
      heeded === null ? headcountReady : heeded && cooled && army.length >= MIN_SORTIE;
    // A hold has to reach the sweep as well: falling through to it would send
    // the army walking into unexplored ground instead, which is the one
    // outcome worse than the march it just refused. Only an actual hold
    // suppresses the sweep — a muster with no target found yet still goes
    // looking, which is how the map gets read.
    const vetoed = heeded === false;
    // Bookkeeping on the lone scout: a dead one gives up its post, and one
    // that outlived its purpose is called home before it wanders into a
    // camp's guards. A discovery goal that killed its scout is written off
    // — whatever killed it, walking a second soldier down the same road
    // alone is not intelligence work, it is tribute. A rival's doorstep is
    // not: that ground stays worth reading, so only its clock is stamped
    // and the next round goes in knowing more.
    const scout = this.#scoutId >= 0 ? world.units.get(this.#scoutId) : undefined;
    const staleRival = this.#staleRival(world);
    if (this.#scoutId >= 0 && (!scout || scout.dead)) {
      if (this.#scoutGoal >= 0 && this.#scoutIntel < 0) this.#unreachable.add(this.#scoutGoal);
      if (this.#scoutIntel >= 0) this.#stampIntel(world, this.#scoutIntel);
      this.#clearScout();
    } else if (scout && target && this.#scoutIntel < 0 && staleRival < 0) {
      // Not straight home: the way home from a camp's watch point can be
      // pathfound right past its guards (the same detour hazard the gate
      // legs exist for — see scoutLeg). Step due north first; the garrison
      // rally collects the scout from that safe latitude soon enough.
      commands.push({
        kind: 'moveUnits',
        unitIds: [scout.id],
        x: Math.floor(scout.x),
        y: Math.max(0, Math.floor(scout.y) - GATE_NORTH),
      });
      this.#clearScout();
    }

    if (target && mustered && !vetoed) {
      this.#attacking = true;
      this.#sweepGoal = -1;
      this.#lastAttackTick = world.tick;
      this.#armyGrewTick = world.tick;
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
      hostileNear(world, this.#vision, this.playerId, baseX, baseY, s.homeGuard)
    ) {
      // Someone is at the gates and the muster is not ready: everyone home,
      // including whoever is still out on the last march. Checked after the
      // attack branch on purpose — a full muster marches anyway, or a
      // lingering raider could pin the army at home for the whole game.
      // And ahead of the searches: defense outranks exploration.
      this.#attacking = false;
      this.#clearScout();
      this.#sweepGoal = -1;
      this.#lastRallyTick = world.tick;
      commands.push({
        kind: 'moveUnits',
        unitIds: army.map((u) => u.id),
        attack: true,
        x: baseX,
        y: baseY + 4,
      });
    } else if (mustered && !vetoed) {
      // A full muster and nothing on the map to march at: the army becomes
      // the search party. Head for the nearest dark landmark (then any dark
      // ground); sight lights it up on approach, the goal is re-picked when
      // it does, and the moment a camp or a castle turns up the branch
      // above takes over. Marching in force on purpose — this is the
      // fallback for the seeds and standoffs the lone scout missed, and
      // whatever is hiding out there has already killed or outlasted him.
      // In force, but not to the last man: see SWEEP_GARRISON.
      this.#clearScout();
      // The castle is never left empty for it: the nearest few soldiers stay
      // as a garrison and the rest are the party. Ties break on id, so the
      // split is as deterministic as everything else here.
      const byHome = [...army].sort(
        (a, z) => exactDist(a.x - baseX, a.y - baseY) - exactDist(z.x - baseX, z.y - baseY) || a.id - z.id,
      );
      const held = Math.min(SWEEP_GARRISON, Math.floor(army.length / 2));
      const garrison = byHome.slice(0, held);
      const party = byHome.slice(held);
      const arrived = party.every((u) => u.task.t === 'idle');
      if (this.#sweepGoal >= 0 && arrived && !this.#vision.explored[this.#sweepGoal]) {
        // Stood down short of the goal and it never lit up: not reachable.
        this.#unreachable.add(this.#sweepGoal);
        this.#sweepGoal = -1;
      }
      if ((this.#sweepGoal < 0 || this.#vision.explored[this.#sweepGoal]) && party.length > 0) {
        // From the party's own position, not home: the sweep walks the
        // frontier tile to tile instead of ping-ponging across the base.
        const from = party[0]!;
        this.#sweepGoal = nextSearchGoal(world, this.#vision, this.#unreachable, from.x, from.y);
        if (this.#sweepGoal >= 0) {
          const at = approachPoint(this.#sweepGoal, world.map.size);
          commands.push({
            kind: 'moveUnits',
            unitIds: party.map((u) => u.id),
            attack: true,
            x: at.x,
            y: at.y,
          });
          // Whoever is holding the castle should be standing at it, not
          // wherever the last march happened to end — so the ones still out
          // are called in with the same beat. Only those: re-ordering a
          // soldier already at his post just restarts his walk.
          const strays = garrison.filter((u) => exactDist(u.x - baseX, u.y - baseY) > GARRISON_POST);
          if (strays.length > 0) {
            commands.push({
              kind: 'moveUnits',
              unitIds: strays.map((u) => u.id),
              attack: true,
              x: baseX,
              y: baseY + 4,
            });
          }
        }
      }
    } else {
      // --- Scouting: one soldier keeps looking while the muster builds ---------
      // Two jobs share the scout. Discovery: while no target is known, tour
      // the landmarks and the frontier — the campaign's clock demands the
      // camp be found before the muster stands, or the army loses the race
      // home against the first raid wave. Intelligence: once war has an
      // address, what matters is what stands there — the scout re-walks
      // living rivals' doorsteps as their picture goes stale, and the
      // counter-forging above reads what it brings back.
      // An errand already in flight is always serviced, stale clock or not.
      // The clock is what STARTS a walk, and a successful walk stops it: a
      // yard with a real force in it refreshes the rival's picture the
      // moment the scout lights it (#observeRivals runs well above this),
      // so on the beat he finally sees what he was sent to see, nothing is
      // stale any more. Gating the whole branch on staleness alone left
      // that scout standing at the enemy's gate for as long as the
      // garrison stayed visible — the read never filed, the errand never
      // retired, and the muster a soldier short of what it counted on.
      if ((!target || staleRival >= 0 || this.#scoutGoal >= 0) && army.length > 0) {
        if (this.#scoutId < 0) {
          const idle = army.filter((u) => u.task.t === 'idle');
          const pick = idle.sort(
            (a, z) => UNIT_DEFS[z.kind].speed - UNIT_DEFS[a.kind].speed || a.id - z.id,
          )[0];
          if (pick) {
            this.#scoutId = pick.id;
            this.#clearScoutGoal();
          }
        }
        const su = this.#scoutId >= 0 ? world.units.get(this.#scoutId) : undefined;
        if (su) {
          let fresh = false;
          // Retire the goal once it is answered. Discovery is done when the
          // ground lights up — or the moment a target turns up, since
          // finding one was the point. An intel run is done when the scout
          // has stood close enough to read the yard; explored is no bar
          // there, a doorstep is re-read precisely because it was seen
          // before.
          if (this.#scoutIntel >= 0) {
            const gx = tileX(this.#scoutGoal, world.map.size) + 0.5;
            const gy = tileY(this.#scoutGoal, world.map.size) + 0.5;
            // Read against the scout's own sight circle rather than a
            // number of its own, because the errand ends where the brain
            // sends it: the watch point is WATCH_FROM tiles out, chosen so
            // the yard sits just inside that circle. A tighter bar than the
            // walk it orders is a goal that can never be answered — the
            // scout stamps nothing, the doorstep stays stale, and scoutLeg
            // walks him gate-to-watch-point-to-gate for the rest of the
            // match while the picture he was sent for never updates.
            if (exactDist(su.x - gx, su.y - gy) <= UNIT_DEFS[su.kind].sight) {
              this.#stampIntel(world, this.#scoutIntel);
              this.#clearScoutGoal();
            }
          } else if (this.#scoutGoal >= 0 && (target || this.#vision.explored[this.#scoutGoal])) {
            this.#clearScoutGoal();
          }
          // The next objective: discovery while no target is known, else
          // the stalest living rival's doorstep.
          if (this.#scoutGoal < 0) {
            if (!target) {
              this.#scoutGoal = nextSearchGoal(world, this.#vision, this.#unreachable, su.x, su.y);
            }
            // The clock as it reads NOW, not as it read when the beat
            // opened: a read stamped a few lines above may have answered
            // the very rival that was stale then, and handing the scout
            // straight back the errand he just finished is how he ends up
            // living at the enemy's gate — never recalled, because the
            // recall wants an errand that is over.
            const nextRival = this.#scoutGoal < 0 ? this.#staleRival(world) : -1;
            if (this.#scoutGoal < 0 && nextRival >= 0) {
              const door = rivalDoorstep(world, nextRival);
              if (door >= 0) {
                this.#scoutGoal = door;
                this.#scoutIntel = nextRival;
              } else {
                // No table entry to walk to: call it read, or the scout
                // would ask again every beat forever.
                this.#stampIntel(world, nextRival);
              }
            }
            this.#scoutLeg = -1;
            fresh = this.#scoutGoal >= 0;
            if (!fresh) this.#scoutId = -1; // nothing left worth walking to
          }
          if (this.#scoutGoal >= 0 && (fresh || su.task.t === 'idle')) {
            const at = scoutLeg(this.#scoutGoal, su.x, su.y, world.map.size);
            const leg = tileIdx(at.x, at.y, world.map.size);
            if (!fresh && leg === this.#scoutLeg) {
              // Ordered there already and the walk has ended short: the way
              // is shut. A discovery goal is written off for good; a
              // doorstep merely waits out its clock and is tried again.
              if (this.#scoutIntel < 0) this.#unreachable.add(this.#scoutGoal);
              else this.#stampIntel(world, this.#scoutIntel);
              this.#clearScoutGoal();
            } else {
              this.#scoutLeg = leg;
              commands.push({ kind: 'moveUnits', unitIds: [su.id], x: at.x, y: at.y });
            }
          }
        }
      }
      if (!this.#attacking && army.length > 0 && rallyReady) {
        // Garrison duty: stand by the storehouse so auto-acquire covers it.
        this.#lastRallyTick = world.tick;
        const idle = army.filter((u) => u.task.t === 'idle' && u.id !== this.#scoutId);
        if (idle.length > 0) {
          commands.push({
            kind: 'moveUnits',
            unitIds: idle.map((u) => u.id),
            x: baseX,
            y: baseY + 4,
          });
        }
      }
    }

    return commands;
  }

  /**
   * Take this window's reading, on `samplePeriod` ticks and not before —
   * the scalars are cheap but the point of a slow clock is that a village
   * gets time to look different.
   */
  #sampleProgress(world: World, mine: Building[], stock: Record<string, number>): void {
    if (world.tick < this.#sampleDue) return;
    this.#sampleDue = world.tick + AI_STALL.samplePeriod;
    let built = 0;
    let sites = 0;
    for (const b of mine) {
      if (b.state === 'built') built++;
      else if (b.state === 'site') sites++;
    }
    let total = 0;
    for (const n of Object.values(stock)) total += n;
    this.#progress.push({
      pop: populationOf(world, this.playerId),
      built,
      sites,
      stock: total,
    });
    if (this.#progress.length > AI_STALL.window) this.#progress.shift();
  }

  /** Has nothing moved across the whole window? A window not yet full is
   * not evidence of anything, so it reads as fine. */
  #windowIsFlat(): boolean {
    if (this.#progress.length < AI_STALL.window) return false;
    const first = this.#progress[0]!;
    return this.#progress.every(
      (x) =>
        x.pop === first.pop &&
        x.built === first.built &&
        x.sites === first.sites &&
        x.stock === first.stock,
    );
  }


  /** The scout stands down entirely. */
  #clearScout(): void {
    this.#scoutId = -1;
    this.#clearScoutGoal();
  }

  /** The scout keeps its post but its current errand is over. */
  #clearScoutGoal(): void {
    this.#scoutGoal = -1;
    this.#scoutLeg = -1;
    this.#scoutIntel = -1;
  }

  /**
   * Is the fight at the end of this march one we would win?
   *
   * The march used to be decided by headcount alone, which cannot tell seven
   * spearmen walking onto seven archers (a rout in our favour) from seven
   * walking onto seven knights (a rout the other way). combatOdds.ts does the
   * comparison; this supplies the two forces and honours the appetite the
   * playbook set.
   *
   * Deliberately generous about ignorance. Three cases commit without asking:
   * the knob is off (every printed playbook, so unadvised seats march exactly
   * as before), the target is a bandit camp (no sighting machinery watches
   * BANDIT at all — see #observeRivals — and camps are the early game's whole
   * agenda), and nothing is known about the defenders. The gate is a brake on
   * fights we can see going badly, not a general reluctance.
   *
   * Refusing costs nothing permanent: #lastAttackTick is stamped only by the
   * march itself, so mustersNeeded keeps grinding the bar down — and past
   * AI_PACING.forlornAfter, decide() stops heeding a hold altogether, so a
   * seat that never likes its odds still marches on the forlorn floor. That
   * used to be left to the picture going stale, and a working scout never
   * lets it: the yard is re-read on the refresh clock, the defenders stay
   * inside the trust window, and the veto renews itself forever.
   */
  #oddsSay(
    world: World,
    army: Unit[],
    target: Building | undefined,
    marchConfidence: number,
  ): boolean | null {
    if (target === undefined) return null;
    if (marchConfidence <= 0) return null;
    this.#oddsAsked++;
    if (target.type === 'banditCamp') {
      this.#oddsCamps++;
      return null;
    }

    const mine: Force = { heavy: 0, light: 0, ranged: 0, hp: 0 };
    for (const u of army) {
      const cls = UNIT_DEFS[u.kind].combat?.class;
      if (!cls) continue;
      mine[cls]++;
      mine.hp += u.hp; // live hp: armour research and old wounds both count
    }
    if (mine.hp <= 0) return null;

    const defenders = this.#defendersAt(world, target);
    if (defenders === null) {
      this.#oddsBlind++;
      return null;
    }
    const commit = shouldCommit(mine, defenders, marchConfidence);
    if (!commit) this.#oddsVetoed++;
    return commit;
  }

  /**
   * Start the towers when something is coming, and stand them down after.
   *
   * A tower's archers arrive late — a research, a forge and a course at the
   * barracks after the stone goes down — and a raid does not wait for them.
   * A running tower calls villagers up in the meantime, so this is the whole
   * of manning it: start it when something hostile comes into sight and halt
   * it again once the ground has been quiet, which puts the villagers back
   * to work on its own.
   *
   * Only ever the villagers. Archers man a tower whether it is running or
   * not (they cost the village nothing to keep), so nothing here starts a
   * tower for their sake or sends one of them down.
   */
  #manTowers(world: World, mine: readonly Building[], commands: SimCommand[]): void {
    for (const b of mine) {
      if (b.state !== 'built') continue;
      if (!BUILDING_DEFS[b.type].garrison) continue;
      const bx = b.x + b.w / 2;
      const by = b.y + b.h / 2;
      if (hostileNear(world, this.#vision, this.playerId, bx, by, AI_INTEL.raidRadius)) {
        this.#levyHold.set(b.id, world.tick + LEVY_HOLD);
        if (b.paused) commands.push({ kind: 'setBuildingPaused', buildingId: b.id, paused: false });
        continue;
      }
      if (world.tick < (this.#levyHold.get(b.id) ?? 0)) continue;
      this.#levyHold.delete(b.id);
      // Halting is the whole stand-down: it stops the tower calling anyone
      // else up and sends the villagers already on it back to work.
      if (!b.paused) commands.push({ kind: 'setBuildingPaused', buildingId: b.id, paused: true });
    }
  }

  /**
   * Who is standing at the target, or null when we have no idea.
   *
   * Preferred reading is what the seat can see around the target right now —
   * live, and it catches a garrison the stored sighting never watched. The
   * radius is the game's own longest leash, `acquireRadius * 1.6` for the
   * widest-eyed unit, so it covers everything that would join the fight.
   *
   * Failing that, the last trustworthy look at the target's owner, which is
   * the whole army rather than this castle's garrison — an overestimate, but
   * the alternative is marching blind. Past its trust window it is not
   * evidence and we say so by returning null.
   */
  #defendersAt(world: World, target: Building): Force | null {
    const cx = target.x + target.w / 2;
    const cy = target.y + target.h / 2;
    const seen: Force = { heavy: 0, light: 0, ranged: 0, hp: 0 };
    for (const u of world.units.values()) {
      if (u.dead || u.owner === this.playerId) continue;
      const cls = UNIT_DEFS[u.kind].combat?.class;
      if (!cls) continue;
      if (!this.#vision.canSee(u.x, u.y)) continue;
      if (Math.abs(u.x - cx) + Math.abs(u.y - cy) > DEFENDER_RADIUS) continue;
      seen[cls]++;
      seen.hp += u.hp;
    }
    // Towers hold ground the way soldiers do, and a captain who cannot see
    // that marches his army under the walls counting only the men in front
    // of them. Sighted and standing only — the intel fallback below is a
    // roster of people, so a tower nobody has laid eyes on is missed, which
    // errs toward marching like the rest of this estimate.
    for (const b of world.buildings.values()) {
      if (b.dead || b.state !== 'built' || b.owner === this.playerId) continue;
      const rule = buildingDef(b.type).garrison;
      if (!rule || !b.garrison) continue;
      const bx = b.x + b.w / 2;
      const by = b.y + b.h / 2;
      if (!this.#vision.canSee(bx, by)) continue;
      if (Math.abs(bx - cx) + Math.abs(by - cy) > DEFENDER_RADIUS) continue;
      if (b.garrisonKind === rule.levy.unit) {
        // Villagers with stones still hold ground, and a captain who reads
        // a levied tower as an empty one marches under a wall that is
        // hitting him. Priced at what the rock is worth beside a weapon.
        const { class: cls, damage, cooldownTicks } = rule.levy;
        addGarrison(seen, cls, b.garrison, damageEquivalent(cls, damage, cooldownTicks), b.hp);
      } else {
        const cls = UNIT_DEFS[rule.unit].combat?.class;
        if (cls) addGarrison(seen, cls, b.garrison, rule.damageMult, b.hp);
      }
    }
    if (seen.hp > 0) return seen;

    const pic = this.#intel.get(target.owner);
    if (!pic || pic.seenTick < 0 || world.tick - pic.seenTick > AI_INTEL.trustFor) return null;
    const { heavy, light, ranged } = rosterMuster(pic).counts;
    if (heavy + light + ranged === 0) return null;
    return {
      heavy,
      light,
      ranged,
      // Counts only — a scout cannot read armour research, so base hp it is.
      hp: heavy * classHp('heavy') + light * classHp('light') + ranged * classHp('ranged'),
    };
  }

  /**
   * Passive intelligence: every rival fighter standing in lit ground this
   * beat is a data point, and they accumulate.
   *
   * Each man seen goes on his owner's roster under his own id, so two looks
   * at two different patrols add up instead of overwriting each other, and
   * entries age out with the trust window (see RivalPicture for why the
   * fallen are not struck off sooner).
   *
   * Also where the branchable facts get stamped: when their first soldier
   * appeared at all, when one of them first reached our gates, and what
   * their village looked like at minute five. Those three are the shape of
   * an opening, and an opening is what an archetype is (src/ai/archetype.ts).
   *
   * `baseX/baseY` are the castle, or -1 when this seat has none — a seat one
   * tick from elimination still watches, it just cannot say whether anything
   * is at a gate it no longer owns.
   */
  #observeRivals(world: World, baseX: number, baseY: number): void {
    const tick = world.tick;
    const atGate = new Map<Owner, number>();
    for (const u of world.units.values()) {
      if (u.owner === this.playerId || !isPlayerOwner(u.owner)) continue;
      const cls = UNIT_DEFS[u.kind].combat?.class;
      if (!cls) continue;
      if (!this.#vision.canSee(u.x, u.y)) continue;
      if (u.dead) continue; // a corpse is not a garrison
      const pic = this.#pictureOf(u.owner);
      pic.roster.set(u.id, { tick, cls });
      pic.seenTick = tick;
      if (pic.firstSoldierTick < 0) pic.firstSoldierTick = tick;
      if (
        pic.firstAttackTick < 0 &&
        baseX >= 0 &&
        Math.abs(u.x - baseX) + Math.abs(u.y - baseY) <= AI_INTEL.raidRadius
      ) {
        atGate.set(u.owner, (atGate.get(u.owner) ?? 0) + 1);
      }
    }
    // A raid, not a caller. Every playbook walks a lone scout past a rival's
    // castle in the first four minutes, so "one of theirs came near" fired at
    // minute four against a warlord and against an abbot alike and separated
    // nothing. A force at the gate is `minSighting` of them at once.
    for (const [owner, n] of atGate) {
      if (n < AI_INTEL.minSighting) continue;
      const pic = this.#pictureOf(owner);
      if (pic.firstAttackTick < 0) pic.firstAttackTick = tick;
    }

    for (const pic of this.#intel.values()) {
      for (const [id, seen] of pic.roster) {
        if (tick - seen.tick > AI_INTEL.trustFor) pic.roster.delete(id);
      }
      if (pic.seenTick === tick && pic.roster.size >= AI_INTEL.minSighting) {
        pic.richSeenTick = tick;
      }
      if (tick - pic.sampledTick >= AI_INTEL.samplePeriod) {
        pic.sampledTick = tick;
        pic.series.push({ tick, total: pic.roster.size });
        if (pic.series.length > AI_INTEL.seriesLen) pic.series.shift();
      }
    }

    if (!this.#earlyMarkTaken && tick >= AI_INTEL.earlyMark) {
      this.#earlyMarkTaken = true;
      const counts = new Map<Owner, number>();
      for (const b of world.buildings.values()) {
        if (b.dead || b.owner === this.playerId || !isPlayerOwner(b.owner)) continue;
        if (!this.#vision.hasExplored(b.x + b.w / 2, b.y + b.h / 2)) continue;
        counts.set(b.owner, (counts.get(b.owner) ?? 0) + 1);
      }
      // Every living rival gets the stamp, seen or not: "we have found
      // nothing of theirs by minute five" is itself the loudest fact about
      // a village, and leaving it unknown would read as no evidence.
      for (const p of world.players) {
        if (p.id === this.playerId || !p.alive || !isPlayerOwner(p.id)) continue;
        this.#pictureOf(p.id).buildingsAtFive = counts.get(p.id) ?? 0;
      }
    }
  }

  /** This rival's picture, opened on first contact. */
  #pictureOf(owner: Owner): RivalPicture {
    let pic = this.#intel.get(owner);
    if (!pic) {
      pic = {
        roster: new Map(),
        series: [],
        seenTick: -1,
        richSeenTick: -1,
        sampledTick: -1,
        firstSoldierTick: -1,
        firstAttackTick: -1,
        buildingsAtFive: -1,
        reads: 0,
      };
      this.#intel.set(owner, pic);
    }
    return pic;
  }

  /**
   * The living rival whose picture is stalest and past due, or -1. The clock
   * reads whichever is newer of the last look at a real force and the last
   * doorstep read, and a seat never heard of ranks stalest of all.
   *
   * A *real* force, not any glimpse: `refreshAfter` was all but dead before,
   * because a single raider wandering into the light reset it. A lone
   * straggler is not a look at an army, so it no longer buys the seat four
   * thousand ticks of confidence it has not earned.
   */
  #staleRival(world: World): Owner {
    let best: Owner = -1;
    let bestTick = Infinity;
    for (const p of world.players) {
      if (p.id === this.playerId || !p.alive) continue;
      const seen = this.#intel.get(p.id)?.richSeenTick ?? -1;
      const last = Math.max(
        seen >= 0 ? seen : -Infinity,
        this.#intelAttempt.get(p.id) ?? -Infinity,
      );
      if (world.tick - last <= AI_INTEL.refreshAfter) continue;
      if (last < bestTick) {
        bestTick = last;
        best = p.id;
      }
    }
    return best;
  }

  /** Mark a rival's doorstep as read this beat — even when nothing stood
   * there, an empty yard is an answer, and the clock must reset or the
   * scout would bounce straight back. Only the clock: whatever an earlier
   * look actually saw stays on file until its trust window closes. */
  #stampIntel(world: World, owner: Owner): void {
    this.#intelAttempt.set(owner, world.tick);
    this.#pictureOf(owner).reads++;
  }

  /**
   * What to build against what scouting has seen: the counter (per
   * COUNTER_PICK) to the dominant class in the freshest trustworthy
   * sighting of a living rival. Ties in the sighting break toward the
   * scarier read — heavy first, then ranged — and null means the map has
   * shown nothing worth retooling for, so the playbook stands as written.
   */
  #counterPlan(world: World): { unit: UnitTypeId; recipe: number } | null {
    let best: Sighting | undefined;
    let bestOwner: Owner = -1;
    for (const [owner, pic] of this.#intel) {
      if (!world.players[owner]?.alive) continue;
      if (pic.seenTick < 0 || world.tick - pic.seenTick > AI_INTEL.trustFor) continue;
      const muster = rosterMuster(pic);
      if (muster.total < AI_INTEL.minSighting) continue;
      const s: Sighting = { tick: pic.seenTick, counts: muster.counts, total: muster.total };
      if (!best || s.tick > best.tick || (s.tick === best.tick && owner < bestOwner)) {
        best = s;
        bestOwner = owner;
      }
    }
    if (!best) return null;
    const { heavy, light, ranged } = best.counts;
    const dominant: UnitClass =
      heavy >= light && heavy >= ranged ? 'heavy' : ranged >= light ? 'ranged' : 'light';
    return COUNTER_PICK[dominant];
  }
}

/** The army a roster adds up to: every soldier still on the list, by class.
 * Entries past the trust window are pruned as they are written, so what is
 * here is what the seat still believes is standing. */
function rosterMuster(pic: RivalPicture): { counts: Sighting['counts']; total: number } {
  const counts = { heavy: 0, light: 0, ranged: 0 };
  for (const seen of pic.roster.values()) counts[seen.cls]++;
  return { counts, total: pic.roster.size };
}

/** The muster this beat asks for: the playbook's size, less one soldier for
 * every `stalePeriod` the army has stood idle past `staleAfter` — down to
 * `staleFloor`, and past `forlornAfter` down to a single soldier. */
export function mustersNeeded(armyAttackSize: number, idleFor: number): number {
  const { staleAfter, stalePeriod, staleFloor, forlornAfter } = AI_PACING;
  if (idleFor <= staleAfter) return armyAttackSize;
  const impatience = Math.floor((idleFor - staleAfter) / stalePeriod) + 1;
  const floor = idleFor > forlornAfter ? 1 : staleFloor;
  return Math.max(floor, armyAttackSize - impatience);
}

/** Is every line of this cost sitting in the storehouse? */
function affordable(cost: Record<string, number>, stock: Record<string, number>): boolean {
  return Object.entries(cost).every(([good, n]) => (stock[good] ?? 0) >= n);
}

function ownedBuildings(world: World, owner: Owner): Building[] {
  return [...world.buildings.values()].filter((b) => !b.dead && b.owner === owner);
}

/** By id, so two hosts pick the same building out of a set. Insertion order
 * is already deterministic, but the recovery rules pick ONE building out of
 * a whole village and an explicit tie-break is cheaper than trusting that. */
function sortedById(buildings: Building[]): Building[] {
  return [...buildings].sort((a, z) => a.id - z.id);
}

/** Where a build step wants to stand: at the base, or at its seam. */
function spotFor(
  world: World,
  step: BuildStep,
  baseX: number,
  baseY: number,
): { x: number; y: number } | null {
  if (step.anchor === 'base') return findSpot(world, step.type, baseX, baseY, step.radius);
  // The shore is terrain, not a resource seam, so it gets its own search.
  // A map with no water near home simply never places the step, and the
  // brain moves on down the list — which is the right answer, not a stall.
  if (step.anchor === 'water') {
    const shore = nearestWater(world, baseX, baseY);
    if (shore < 0) return null;
    const size = world.map.size;
    return findSpot(world, step.type, tileX(shore, size), tileY(shore, size), step.radius);
  }
  const tile = nearestResource(world.map, ANCHOR_RESOURCE[step.anchor], baseX, baseY);
  if (tile < 0) return null;
  const size = world.map.size;
  return findSpot(world, step.type, tileX(tile, size), tileY(tile, size), step.radius);
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
  const size = world.map.size;
  const spaced = (x: number, y: number): boolean => {
    for (let ty = y - 1; ty < y + def.h + 1; ty++) {
      for (let tx = x - 1; tx < x + def.w + 1; tx++) {
        if (tx < 0 || ty < 0 || tx >= size || ty >= size) continue;
        if (world.map.buildingAt[ty * size + tx]! >= 0) return false;
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

/**
 * Nearest open water to a point — the fishery's anchor. Only water with at
 * least one walkable bank tile counts: the strip of sea behind a mountain
 * rim (or an un-chopped border forest) is real water no fishery could ever
 * stand beside, and anchoring on it sent the build step spiraling around
 * ground with no legal site.
 */
function nearestWater(world: World, cx: number, cy: number): number {
  const map = world.map;
  const size = map.size;
  const lo = playMin(map);
  const hi = playMax(map);
  let best = -1;
  let bestDist = Infinity;
  // Play-area rows only: the margin's sea is scenery no pier can reach,
  // and the scan has no business paying for it.
  for (let y = lo; y < hi; y++) {
  for (let x = lo; x < hi; x++) {
    const i = y * size + x;
    if (map.terrain[i] !== Terrain.Water) continue;
    let banked = false;
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ] as const) {
      if (nx < lo || ny < lo || nx >= hi || ny >= hi) continue;
      const n = ny * size + nx;
      if (!tileBlocks(map.terrain[n]!, map.resource[n]!)) {
        banked = true;
        break;
      }
    }
    if (!banked) continue;
    const d = Math.abs(x - cx) + Math.abs(y - cy);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  }
  return best;
}

/** Nearest tile with a given resource to a point. */

/** Is an enemy fighter — rival soldier or raider — this close to home?
 * Only one the seat can actually see: a unit is intelligence of the moment,
 * and a raider in dark ground is exactly what fog is supposed to hide. The
 * village lights its own surroundings densely, so in practice this fires a
 * step later than the omniscient version did, not never. */
export function hostileNear(
  world: World,
  vision: SeatVision,
  owner: Owner,
  bx: number,
  by: number,
  radius: number,
): boolean {
  for (const u of world.units.values()) {
    if (u.dead || u.owner === owner) continue;
    if (!UNIT_DEFS[u.kind].combat) continue;
    if (!vision.canSee(u.x, u.y)) continue;
    if (Math.abs(u.x - bx) + Math.abs(u.y - by) <= radius) return true;
  }
  return false;
}

/**
 * What the army marches on: the nearest rival storehouse or bandit camp
 * (razing the camp stops the raids; razing a storehouse eliminates the
 * rival). Ties break on the lower building id. A playbook that prefers
 * rivals ignores the camps entirely while any rival castle stands.
 *
 * Only buildings on explored ground are candidates — the same rule the
 * server applies to humans (a building, once seen, is remembered; camps and
 * castles stand from tick 0, so explored ground and seen-at-some-point are
 * the same thing for them). An unexplored map means no target at all, and
 * the brain goes scouting instead.
 *
 * A rivals-first playbook with living rivals it has not yet FOUND returns
 * no target rather than a camp: the omniscient brain always knew where the
 * castles stood and so never marched on a camp while one was up, and
 * settling for camps now would quietly rewrite that playbook's character.
 * Keep looking is the answer, not lower the standards.
 */
export function pickAttackTarget(
  world: World,
  vision: SeatVision,
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
    if (!vision.hasExplored(b.x + b.w / 2, b.y + b.h / 2)) continue;
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
  if (best && prefersRivals && best.type === 'banditCamp') {
    const rivalStands = world.players.some((p) => p.id !== owner && p.alive);
    if (rivalStands) return undefined;
  }
  return best;
}

/**
 * Where on this map an enemy worth finding could be standing. Not vision —
 * map lore: rival castles sit on the start table the server calls "a fixed
 * table anyone can read in the source", and worldgen seeds bandit camps at
 * the middle and the far corners (world.ts). A human learns both in one
 * game; the scout still has to walk there and look.
 */
function searchLandmarks(world: World): [number, number][] {
  const size = world.map.size;
  const pts: [number, number][] = [];
  // Rival doorsteps (the seat's own start is explored from tick 0 and
  // drops out on its own). Storehouses are 3x3, so +1 is the center.
  for (const [sx, sy] of startLayout(world.map.play, playMin(world.map), world.players.length) ?? []) {
    pts.push([sx + 1, sy + 1]);
  }
  // Camp seeds: the middle, then the corners — the very spots worldgen
  // seeds from (campCorners), at their 3x3 centers.
  pts.push([size / 2, size / 2]);
  for (const [cx, cy] of campCorners(world.map.play, playMin(world.map))) pts.push([cx + 1, cy + 1]);
  return pts;
}

/**
 * The next place a search should walk to: the nearest unexplored landmark,
 * and once those are all lit, the nearest tile this seat has never observed
 * at all (camps get pushed off their seed by lakes and mountains, so the
 * frontier crawl stays as the exhaustive fallback). Terrain and the
 * resource layout are public knowledge (the init frame ships them whole to
 * every human), so steering around water and standing ore is fair play —
 * it is only what MOVES and what was BUILT that hides behind the fog.
 * Ties break on the lower tile index, so two hosts search identically.
 */
export function nextSearchGoal(
  world: World,
  vision: SeatVision,
  skip: ReadonlySet<number>,
  cx: number,
  cy: number,
): number {
  let best = -1;
  let bestDist = Infinity;
  for (const [px, py] of searchLandmarks(world)) {
    const i = tileIdx(px, py, world.map.size);
    if (vision.explored[i] || skip.has(i)) continue;
    if (tileBlocks(world.map.terrain[i]!, world.map.resource[i]!)) continue;
    const d = Math.abs(px - cx) + Math.abs(py - cy);
    if (d < bestDist || (d === bestDist && i < best)) {
      bestDist = d;
      best = i;
    }
  }
  if (best >= 0) return best;
  return nearestUnexplored(world, vision, skip, cx, cy);
}

/**
 * Search goals are watched from a respectful distance: the mover needs the
 * spot inside its sight circle (6.5 tiles for every soldier), not under its
 * boots. Walking a scout onto a bandit camp wakes the guards — and worse,
 * tows them off their post: a chased guard snaps back on its leash to
 * whichever side of the camp the chase ended on, and a guard re-posted on
 * the village side stands squarely in the corridor the muster will later
 * march down, where it shreds the column piecemeal. So goals are observed
 * from six tiles DUE NORTH, and that is no arbitrary compass point: camp
 * guards muster on the south face (worldgen posts them at the camp's foot)
 * and rival garrisons stand south of their castles, the same lore that
 * puts the landmarks themselves at corners and starts. Six north keeps the
 * watcher just past the guards' reach while the goal sits inside sight.
 */
const WATCH_FROM = 6;

export function approachPoint(goal: number, size: number): { x: number; y: number } {
  return { x: tileX(goal, size), y: Math.max(0, tileY(goal, size) - WATCH_FROM) };
}

/**
 * Where a rival's garrison stands: four tiles south of their castle door —
 * derived from the same public start table the landmarks come from, and
 * the very spot this brain rallies its own army to. Walking a scout there
 * is how a seat learns what a rival's army is made of.
 */
export function rivalDoorstep(world: World, owner: Owner): number {
  const size = world.map.size;
  const start = startLayout(world.map.play, playMin(world.map), world.players.length)?.[owner];
  if (!start) return -1;
  return tileIdx(start[0] + 1, Math.min(size - 1, start[1] + 5), size);
}

/**
 * A lone scout does not trust the watch point alone: a cross-map walk is
 * pathfound around forests and lakes, and a detour on a long lateral leg
 * can graze the goal close enough to start the very chase the watch point
 * exists to avoid. So the scout travels in two legs — first to a gate well
 * north of the goal, then a short straight descent to the watch point.
 * The descent is short enough that its detours stay honest — which is why
 * the descent is only issued from INSIDE the gate band: a scout merely
 * somewhere north of it would get one long move whose path is free to
 * wander exactly as far as the two-leg route forbids.
 */
const GATE_NORTH = 13;

/**
 * Soldiers the search party leaves standing at the castle.
 *
 * The sweep is speculative; the raid clock is not. A party that takes every
 * soldier to the far corner of the map leaves nobody at home to lose the
 * race back with — and the recall cannot cover for it, because a seat only
 * sees raiders once they are already at the gates. Small enough that the
 * rest still march in the force the fallback is meant to march in.
 */
const SWEEP_GARRISON = 3;

/** How far from the castle a garrison soldier still counts as at his post. */
const GARRISON_POST = 6;

/**
 * How long after the last enemy is seen near a tower the levy keeps holding
 * it. Generous on purpose: a raid is a series of arrivals rather than one,
 * and standing the villagers down between two waves buys a few seconds of
 * hauling at the price of an empty wall when the second one lands. Coming
 * back down is cheap; being late back up is not.
 */
export const LEVY_HOLD = 30 * 20;

export function scoutLeg(goal: number, sx: number, sy: number, size: number): { x: number; y: number } {
  const gx = tileX(goal, size);
  const gy = tileY(goal, size);
  const gateY = Math.max(0, gy - GATE_NORTH);
  const atGate = Math.abs(sx - gx) <= 3 && Math.abs(sy - gateY) <= 2;
  if (atGate) return approachPoint(goal, size);
  return { x: gx, y: gateY };
}

/**
 * The frontier crawl: the nearest tile this seat has never observed that
 * an army could plausibly stand on.
 */
export function nearestUnexplored(
  world: World,
  vision: SeatVision,
  skip: ReadonlySet<number>,
  cx: number,
  cy: number,
): number {
  const size = world.map.size;
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < tileCount(size); i++) {
    if (vision.explored[i] || skip.has(i)) continue;
    if (tileBlocks(world.map.terrain[i]!, world.map.resource[i]!)) continue;
    const d = Math.abs(tileX(i, size) - cx) + Math.abs(tileY(i, size) - cy);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}
