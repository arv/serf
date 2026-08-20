import { tileCount, tileIdx, tileX, tileY } from '../../shared/grid.ts';
import { exactDist } from '../../shared/math.ts';
import {
  findResourcesNear,
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
  gatherRecipeOf,
  OUTPUT_CAP,
  repairBill,
  type BuildingTypeId,
} from '../defs/buildings.ts';
import { TECH_DEFS, type TechId } from '../defs/techs.ts';
import { UNIT_DEFS, type UnitClass, type UnitTypeId } from '../defs/units.ts';
import { classHp, shouldCommit, type Force } from '../combatOdds.ts';
import { HIRE_SERF_COST } from '../defs/balance.ts';
import { hasRoomToHire, plannedPopCapOf, populationOf } from '../population.ts';
import type { AiStrategy, BuildAnchor, BuildStep } from '../defs/aiStrategies.ts';
import { canPlace, type World } from '../world.ts';
import { isPlayerOwner, type Building, type Owner } from '../entities.ts';
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
   * Past staleness lies desperation. The impatience rule walks the bar
   * down to `staleFloor`, but a war of mutual exhaustion can leave every
   * surviving seat unable to field even that — seed 42 under fog reaches
   * exactly there: one seat with two archers and no wood for a third bow,
   * the other with no army and no silver, forever. After this long without
   * a march the floor gives way too, and a seat sends whatever it has —
   * two archers razing an undefended castle end a game nothing else would.
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
 * (every gatherer capped at OUTPUT_CAP, one of them sitting on four silver —
 * a hire's worth) and have exactly zero free serfs, every hand having been
 * bound to a post or spent as a barracks recruit. Nothing hauls, so nothing
 * reaches the storehouse, so nothing can be bought, so no hand is ever
 * hired. Eighty thousand ticks of a village that is fully employed and
 * completely paralysed.
 *
 * No amount of tuning reaches that. What reaches it is noticing, so the
 * brain samples a handful of integers on a slow clock and calls the seat
 * stalled when none of them has moved across the whole window. The rules
 * that answer are all in `#recover`, and every one of them is gated on this
 * reading — an unstalled seat emits exactly the commands it always did.
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

/** What a soldier needs forged before the barracks can start on them. */
const WEAPON_OF: Partial<Record<UnitTypeId, GoodId>> = {
  knight: 'sword',
  spearman: 'spear',
  archer: 'bow',
};

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
  /** What scouting has seen of each rival's army: the freshest useful
   * look, by owner. This is what the counter-forging reads. */
  #intel = new Map<Owner, Sighting>();
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

  intelReport(): { owner: Owner; tick: number; total: number; counts: Sighting['counts'] }[] {
    return [...this.#intel].map(([owner, s]) => ({
      owner,
      tick: s.tick,
      total: s.total,
      counts: { ...s.counts },
    }));
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
    this.#observeRivals(world);
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
      const spot = spotFor(world, step, baseX, baseY);
      if (!spot) continue;
      if (affordable(BUILDING_DEFS[step.type].cost as Record<string, number>, stock)) {
        commands.push({ kind: 'placeBuilding', building: step.type, x: spot.x, y: spot.y });
        placed = true;
        break; // one placement per decision to keep hauling focused
      }
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
      if (b.state !== 'built' || b.repairNeeds) continue;
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
    const room = hasRoomToHire(world, this.playerId);
    if (room && serfCount < s.survivalFloor && (stock.silver ?? 0) >= HIRE_SERF_COST) {
      commands.push({ kind: 'hireSerf' });
    } else if (
      room &&
      growing &&
      serfCount < s.serfTarget &&
      (stock.silver ?? 0) >= HIRE_SERF_COST + (researchPending ? reserve : 0)
    ) {
      commands.push({ kind: 'hireSerf' });
    }

    // --- Breaking the stall: the rules that cost something -------------------
    // Only ever reached by a seat the window says has not moved in twelve
    // minutes. Everything above this line is the game as it was played
    // before the watchdog existed.
    if (stalled) this.#recover(world, mine, stock, serfCount, commands);

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
    // Bent by intelligence: smiths beyond the first switch to the weapon
    // that beats what scouting has seen of a living rival's army. The
    // first smith keeps the playbook's own line — a sighting is a reason
    // to hedge, not to stampede — and a counter the seat cannot forge
    // (tech-gated recipe) leaves the mix as written.
    const counter = this.#counterPlan(world);
    const smiths = mine
      .filter((b) => b.type === 'weaponsmith' && b.state === 'built')
      .sort((a, z) => a.id - z.id);
    smiths.forEach((smith, i) => {
      let want = s.weaponMix[Math.min(i, s.weaponMix.length - 1)]!;
      if (counter && i > 0) {
        const opt = BUILDING_DEFS.weaponsmith.recipeOptions?.[counter.recipe];
        if (opt && (opt.requiresTech === undefined || researched(opt.requiresTech))) {
          want = counter.recipe;
        }
      }
      const option = BUILDING_DEFS.weaponsmith.recipeOptions?.[want];
      if (!option) return;
      if (option.requiresTech !== undefined && !researched(option.requiresTech)) return;
      if ((smith.recipeIndex ?? 0) !== want) {
        commands.push({ kind: 'setBuildingRecipe', buildingId: smith.id, index: want });
      }
    });

    // --- Keep the barracks queue warm --------------------------------------------
    // The counter unit jumps the queue when its weapon is at hand — the
    // around() check is the feasibility test, so a counter the economy
    // cannot arm falls straight through to the playbook's own preference.
    const barracks = mine.find((b) => b.type === 'barracks' && b.state === 'built');
    if (barracks) {
      const around = (good: GoodId): boolean =>
        (stock[good] ?? 0) + (barracks.inputs[good] ?? 0) + (barracks.inbound[good] ?? 0) > 0;
      const prefs = counter ? [counter.unit, ...s.trainPreference] : s.trainPreference;
      const ready = prefs.find((unit) => {
        const weapon = WEAPON_OF[unit];
        return weapon !== undefined && around(weapon);
      });
      // A queue can go stale: an unstarted entry whose weapon the village
      // neither holds nor has on the way pins its slot forever — the iron
      // ran out under a spearman order while swords piled up in the store,
      // and a queue at depth stops this rule from ever running again. One
      // stale entry makes way per beat, and only while a unit the seat CAN
      // arm is waiting for the slot. An empty-handed queue keeps its
      // entries: unstarted orders are what summon their weapons at all
      // (trainingDemand reads them), so a seat with nothing in reach must
      // hold its place in line, not clear it.
      let cancelled = 0;
      if (ready !== undefined) {
        const staleIdx = (barracks.trainQueue ?? []).findIndex((item) => {
          if (item.started) return false;
          const weapon = WEAPON_OF[item.unit];
          return weapon !== undefined && !around(weapon);
        });
        if (staleIdx >= 0) {
          commands.push({
            kind: 'cancelTraining',
            buildingId: barracks.id,
            index: staleIdx,
            unit: barracks.trainQueue![staleIdx]!.unit,
          });
          cancelled = 1;
        }
      }
      if ((barracks.trainQueue?.length ?? 0) - cancelled < s.barracksQueueDepth) {
        commands.push({
          kind: 'trainUnit',
          buildingId: barracks.id,
          unit: ready ?? s.trainFallback,
        });
      }
    }

    // --- Army: rally at home until strong, then march ------------------------
    const army = [...world.units.values()].filter(
      (u) => !u.dead && u.owner === this.playerId && MILITARY.has(u.kind),
    );
    const target = pickAttackTarget(world, this.#vision, this.playerId, baseX, baseY, s.prefersRivals);
    const rallyReady = world.tick - this.#lastRallyTick > s.rallyCooldown;
    const idleFor = world.tick - this.#lastAttackTick;
    const cooled = idleFor > s.attackCooldown;
    const headcountReady = army.length >= mustersNeeded(s.armyAttackSize, idleFor) && cooled;
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
    const mustered =
      odds === null ? headcountReady : odds && cooled && army.length >= MIN_SORTIE;
    // A hold has to reach the sweep as well: falling through to it would send
    // the army walking into unexplored ground instead, which is the one
    // outcome worse than the march it just refused. Only an actual hold
    // suppresses the sweep — a muster with no target found yet still goes
    // looking, which is how the map gets read.
    const vetoed = odds === false;
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
      if ((!target || staleRival >= 0) && army.length > 0) {
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
            if (Math.abs(su.x - gx) + Math.abs(su.y - gy) <= 5) {
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
            if (this.#scoutGoal < 0 && staleRival >= 0) {
              const door = rivalDoorstep(world, staleRival);
              if (door >= 0) {
                this.#scoutGoal = door;
                this.#scoutIntel = staleRival;
              } else {
                // No table entry to walk to: call it read, or the scout
                // would ask again every beat forever.
                this.#stampIntel(world, staleRival);
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

  /**
   * The escalating recovery rules, cheapest and least destructive first.
   * At most one order per beat, so a seat takes only the step it needs and
   * gets a whole sample period to show the step worked before the next one
   * is considered.
   *
   * Both rules here spend a building or a post, which is why they sit
   * behind the two free ones in `decide` and behind the stall reading
   * itself. Neither can run on a seat that is going anywhere.
   */
  #recover(
    world: World,
    mine: Building[],
    stock: Record<string, number>,
    serfCount: number,
    commands: SimCommand[],
  ): void {
    // Rule one: re-site a worked-out extractor. A gatherer with nothing
    // left in reach is a hand and a hut spent on ground that will never
    // yield again — tree groves regrow only on standing tiles
    // (systems/production.ts `regrow`), so a woodcutter that cleared its
    // radius sits on dead earth for the rest of the match, and a seam is
    // simply finished. Selling it is the whole re-siting move: the sale
    // hands back half the materials AND the resident (tick.ts), and the
    // build order above maintains standing counts, so the next beat places
    // the replacement — against a live deposit, because `spotFor` anchors
    // on `nearestResource`, which only counts tiles with amount left.
    //
    // Two conditions keep this from making things worse. There has to be a
    // live deposit somewhere to re-site onto, and the seat has to be able
    // to afford the rebuild once the refund lands — half back means the
    // shelf must already hold the other half. Failing either, selling would
    // just be losing a building.
    for (const b of sortedById(mine)) {
      if (b.state !== 'built') continue;
      const def = BUILDING_DEFS[b.type];
      const recipe = gatherRecipeOf(def);
      if (!recipe) continue;
      const code = RESOURCE_CODE[recipe.resource]!;
      const c = gatherOrigin(def, b.x, b.y);
      if (findResourcesNear(world.map, c.x, c.y, code, recipe.radius, 1).length > 0) continue;
      if (nearestResource(world, code, b.x, b.y) < 0) continue; // nowhere to move to
      const cost = def.cost as Record<string, number>;
      const canRebuild = Object.entries(cost).every(
        ([good, n]) => (stock[good] ?? 0) + Math.floor(n / 2) >= n,
      );
      if (!canRebuild) continue;
      commands.push({ kind: 'sellBuilding', buildingId: b.id });
      this.#recoveries++;
      return;
    }

    // Rule two: buy a hauler with a post. Nothing in the village moves
    // without a loose serf — the haul matcher only ever offers a job to an
    // idle one (systems/logistics.ts) — and a seat can spend its last hand
    // legitimately, by binding it to a hut or handing it to the barracks as
    // a recruit. Seed 9 ends exactly there: full extractors, four silver
    // sitting in the silver mine, and nobody to carry it the twenty tiles
    // to the storehouse that would pay for the hand that carries it.
    //
    // The post to empty is one whose output buffer is already full, which
    // is precisely a post producing nothing: its worker is standing at a
    // capped hut waiting for a haul that cannot come. Freeing him costs no
    // production at all, and it is self-limiting — once he has drained the
    // buffer the post is under cap again, and the staffing sweep re-fills it
    // when the dismissal backoff runs out.
    //
    // Only a worker reading idle is taken. A hand released mid-trip used to
    // be lost for good; unbindWorker resets the task now, but a rule whose
    // whole purpose is producing a hauler should not depend on that.
    if (serfCount > 0) return;
    for (const b of sortedById(mine)) {
      if (b.state !== 'built' || b.workerId === undefined) continue;
      const def = BUILDING_DEFS[b.type];
      const out = gatherRecipeOf(def)?.output;
      if (out === undefined || (b.stock[out] ?? 0) < OUTPUT_CAP) continue;
      const worker = world.units.get(b.workerId);
      if (!worker || worker.dead || worker.task.t !== 'idle') continue;
      commands.push({ kind: 'dismissWorker', buildingId: b.id });
      this.#recoveries++;
      return;
    }
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
   * march itself, so mustersNeeded keeps grinding the bar down and a seat that
   * never likes its odds still eventually marches on the forlorn floor.
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
    if (seen.hp > 0) return seen;

    const sighting = this.#intel.get(target.owner);
    if (!sighting || world.tick - sighting.tick > AI_INTEL.trustFor) return null;
    const { heavy, light, ranged } = sighting.counts;
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
   * beat is a data point. A bigger look replaces a smaller one — eight
   * knights marching on the village say more than the one straggler seen
   * since — and anything replaces a picture past its trust window.
   */
  #observeRivals(world: World): void {
    const seen = new Map<Owner, Sighting>();
    for (const u of world.units.values()) {
      if (u.dead || u.owner === this.playerId || !isPlayerOwner(u.owner)) continue;
      const cls = UNIT_DEFS[u.kind].combat?.class;
      if (!cls) continue;
      if (!this.#vision.canSee(u.x, u.y)) continue;
      let s = seen.get(u.owner);
      if (!s) {
        s = { tick: world.tick, counts: { heavy: 0, light: 0, ranged: 0 }, total: 0 };
        seen.set(u.owner, s);
      }
      s.counts[cls]++;
      s.total++;
    }
    for (const [owner, s] of seen) {
      const old = this.#intel.get(owner);
      if (!old || s.total >= old.total || world.tick - old.tick > AI_INTEL.trustFor) {
        this.#intel.set(owner, s);
      }
    }
  }

  /** The living rival whose picture is stalest and past due, or -1. The
   * clock reads whichever is newer of the last real sighting and the last
   * read attempt, and a seat never heard of ranks stalest of all. */
  #staleRival(world: World): Owner {
    let best: Owner = -1;
    let bestTick = Infinity;
    for (const p of world.players) {
      if (p.id === this.playerId || !p.alive) continue;
      const last = Math.max(
        this.#intel.get(p.id)?.tick ?? -Infinity,
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
    for (const [owner, s] of this.#intel) {
      if (!world.players[owner]?.alive) continue;
      if (world.tick - s.tick > AI_INTEL.trustFor) continue;
      if (s.total < AI_INTEL.minSighting) continue;
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
  const tile = nearestResource(world, ANCHOR_RESOURCE[step.anchor], baseX, baseY);
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
function nearestResource(world: World, code: number, cx: number, cy: number): number {
  const map = world.map;
  const size = map.size;
  const lo = playMin(map);
  const hi = playMax(map);
  let best = -1;
  let bestDist = Infinity;
  for (let y = lo; y < hi; y++) {
    for (let x = lo; x < hi; x++) {
      const i = y * size + x;
      if (map.resource[i] !== code || map.resourceAmt[i]! <= 0) continue;
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
  }
  return best;
}

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
