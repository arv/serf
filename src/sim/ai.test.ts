import {describe, expect, it} from 'vitest';
import type {Enum} from '../shared/enum.ts';
import {tileIdx} from '../shared/grid.ts';
import {AiSeats} from './aiSeats.ts';
import * as BuildingState from './buildingStateEnum.ts';
import * as CommandKind from './commandKindEnum.ts';
import type {SimCommand} from './commands.ts';
import {checkInvariants} from './debug/invariants.ts';
import {
  strategyOf,
  type AiStrategy,
  AI_STRATEGIES,
} from './defs/aiStrategies.ts';
import * as AiStrategyId from './defs/aiStrategyIdEnum.ts';
import {HIRE_SERF_COST} from './defs/balance.ts';
import * as BuildAnchor from './defs/buildAnchorEnum.ts';
import {BUILDING_DEFS, OUTPUT_CAP} from './defs/buildings.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as GoodId from './defs/goodIdEnum.ts';
import type {GoodAmounts} from './defs/goods.ts';
import * as TechId from './defs/techIdEnum.ts';
import {TECH_DEFS} from './defs/techs.ts';
import * as UnitTypeId from './defs/unitTypeIdEnum.ts';
import {BANDIT, type Building} from './entities.ts';
import {countResourceNear} from './map.ts';
import * as MatchState from './matchStateEnum.ts';
import * as PlayerKind from './playerKindEnum.ts';
import {findSpot} from './siting.ts';
import {
  AI_PACING,
  AI_SITING,
  AI_STALL,
  AiBrain,
  LEVY_HOLD,
} from './systems/ai.ts';
import {
  addBuiltHut,
  addResourceTile,
  addSerf,
  addStorehouse,
  bareWorld,
  cmds,
} from './testUtils.ts';
import {tickWorld, type PlayerCommand} from './tick.ts';
import * as TileResource from './tileResourceEnum.ts';
import * as UnitTaskKind from './unitTaskKindEnum.ts';
import {
  createWorld,
  type World,
  type WorldConfig,
  destroyBuilding,
  placeBuiltBuilding,
  placeSite,
  spawnUnit,
} from './world.ts';

type TechId = Enum<typeof TechId>;

function digest(world: World): unknown {
  return {
    tick: world.tick,
    rngState: world.rngState,
    nextId: world.nextId,
    units: [...world.units.values()].map(u => ({
      ...u,
      path: u.path ? [...u.path] : null,
    })),
    buildings: [...world.buildings.values()],
    players: world.players,
    outcome: world.outcome,
  };
}

/** Drive every AI seat's brain the way its worker does. */
function runWithBrains(
  config: WorldConfig,
  maxTicks: number,
  onTick?: (w: World) => void,
): World {
  const world = createWorld(config);
  // Playbooks come off the world, which was dealt them from the seed —
  // the same lookup AiSeats does for the hosts.
  const brains = world.players
    .filter(p => p.kind === PlayerKind.ai)
    .map(p => new AiBrain(p.id, strategyOf(p.strategy), world.map.size));
  for (
    let t = 0;
    t < maxTicks && world.outcome.state === MatchState.playing;
    t++
  ) {
    const commands: PlayerCommand[] = [];
    for (const brain of brains) {
      if (brain.shouldDecide(world.tick)) {
        for (const cmd of brain.decide(world))
          commands.push({playerId: brain.playerId, cmd});
      }
    }
    tickWorld(world, commands);
    onTick?.(world);
  }
  return world;
}

describe('the AI opponent', () => {
  it('AI vs AI produces a winner with a clean economy', () => {
    const world = runWithBrains(
      // Seed 11: re-pinned for the margin grid (99's roll stood off past
      // the 90k budget).
      {
        seed: 11,
        players: [{kind: PlayerKind.ai}, {kind: PlayerKind.ai}],
        banditsEnabled: false,
      },
      90_000,
      w => {
        if (w.tick % 200 === 0) {
          expect(checkInvariants(w).violations, `at tick ${w.tick}`).toEqual(
            [],
          );
        }
      },
    );
    expect(world.outcome.state, `still playing at tick ${world.tick}`).toBe(
      MatchState.over,
    );
    // A winner exists (either seat may take it; a draw would be null).
    expect((world.outcome as {winner: number | null}).winner).not.toBeNull();
  }, 240_000);

  it('is deterministic: two identical runs match at tick 3000', () => {
    const config: WorldConfig = {
      seed: 7,
      players: [{kind: PlayerKind.human}, {kind: PlayerKind.ai}],
    };
    expect(digest(runWithBrains(config, 3000))).toEqual(
      digest(runWithBrains(config, 3000)),
    );
  });

  it('4-player mixed world is deterministic at tick 3000', () => {
    const config: WorldConfig = {
      seed: 11,
      players: [
        {kind: PlayerKind.human},
        {kind: PlayerKind.ai},
        {kind: PlayerKind.ai},
        {kind: PlayerKind.ai},
      ],
    };
    expect(digest(runWithBrains(config, 3000))).toEqual(
      digest(runWithBrains(config, 3000)),
    );
  });
});

/**
 * The strategist override (src/ai/): a Partial<AiStrategy> the LLM lays
 * over a brain's playbook. What is covered is the two promises the seam
 * makes — laid and cleared it leaves no trace, and laid with real values
 * the brain actually plays differently.
 */
function moveOrders(
  commands: SimCommand[],
): Extract<SimCommand, {kind: CommandKind.moveUnits}>[] {
  return commands.filter(c => c.kind === CommandKind.moveUnits);
}

/**
 * A muster staring at a rival castle it cannot take: seven knights of our
 * own, twelve of theirs standing in the yard, and a scout parked close
 * enough that both the castle and its garrison are lit — the gate reads only
 * what the seat can actually see, so an unlit garrison would prove nothing.
 */
/** The muster ordered anywhere but the rally spot south of the castle — the
 * same definition firstMarchTick uses, so a rally home does not read as a
 * march and a sweep into the dark does. */
function marchOrders(
  commands: SimCommand[],
  castleX: number,
  castleY: number,
): Extract<SimCommand, {kind: CommandKind.moveUnits}>[] {
  const home = {x: castleX + 1, y: castleY + 1 + 4};
  return moveOrders(commands).filter(
    m => m.unitIds.length >= 3 && (m.x !== home.x || m.y !== home.y),
  );
}

function siegeStandoff(): {world: World; brain: AiBrain} {
  const world = bareWorld();
  addStorehouse(world, 30, 30, {});
  for (let i = 0; i < 7; i++)
    spawnUnit(world, UnitTypeId.knight, 0, 33.5, 27.5 + i);
  // The rival, near enough that one scout lights castle and yard together.
  addStorehouse(world, 44, 30, {}, 1);
  for (let i = 0; i < 12; i++)
    spawnUnit(world, UnitTypeId.knight, 1, 45.5, 28.5 + i * 0.4);
  spawnUnit(world, UnitTypeId.knight, 0, 42.5, 30.5); // the scout
  world.tick = 1000; // past the steward's attack cooldown
  const brain = new AiBrain(
    0,
    AI_STRATEGIES[AiStrategyId.steward],
    world.map.size,
  );
  // These fixtures measure the ODDS gate against the printed muster of
  // seven. The stance engine would switch this found-castle world into
  // siege (bar twelve) and hide the gate behind a headcount hold, and the
  // herald would hold the march it allows — so both are pinned off; the
  // aiStances and aiWar tests own those behaviors.
  brain.setStancePolicy(false);
  brain.setWarBehaviors([]);
  return {world, brain};
}

describe('strategist overrides', () => {
  /** Ticks until the brain first marches its army away from home — the
   * observable a changed muster size moves. Under fog a brain also emits
   * one-soldier scout errands and whole-army rallies to the spot south of
   * the castle; a march is the whole muster ordered anywhere else.
   *
   * Seed 17 is pure data, re-pinned when a worldgen change rolls it a
   * valley the steward musters differently on (20260724 held it until the
   * pan clamp took a share of the scenery ring). What has to hold is only
   * that the unadvised march lands inside the budget with room for an
   * eager one to beat it: 13.7k against a 20k cap here. */
  function firstMarchTick(
    override: Partial<AiStrategy> | null,
    maxTicks: number,
  ): number {
    const world = createWorld({
      seed: 17,
      players: [{kind: PlayerKind.ai, strategy: AiStrategyId.steward}],
    });
    const brain = new AiBrain(
      0,
      strategyOf(world.players[0]!.strategy),
      world.map.size,
    );
    if (override) brain.setOverride(override);
    const castle = [...world.buildings.values()].find(
      b => b.type === BuildingTypeId.storehouse,
    )!;
    const home = {x: castle.x + 1, y: castle.y + 1 + 4};
    for (
      let t = 0;
      t < maxTicks && world.outcome.state === MatchState.playing;
      t++
    ) {
      const commands = brain.shouldDecide(world.tick)
        ? brain.decide(world)
        : [];
      for (const cmd of commands) {
        if (
          cmd.kind === CommandKind.moveUnits &&
          cmd.unitIds.length >= 3 &&
          (cmd.x !== home.x || cmd.y !== home.y)
        ) {
          return world.tick;
        }
      }
      tickWorld(
        world,
        commands.map(cmd => ({playerId: 0, cmd})),
      );
    }
    return maxTicks;
  }

  it('laid empty and cleared again, the seam leaves the game untouched', () => {
    const config: WorldConfig = {
      seed: 7,
      players: [{kind: PlayerKind.human}, {kind: PlayerKind.ai}],
    };
    const baseline = digest(runWithBrains(config, 3000));

    const world = createWorld(config);
    const brain = new AiBrain(
      1,
      strategyOf(world.players[1]!.strategy),
      world.map.size,
    );
    for (
      let t = 0;
      t < 3000 && world.outcome.state === MatchState.playing;
      t++
    ) {
      // An empty override spreads to the same values; clearing goes back to
      // the playbook object itself. Either way: the identical game.
      if (t === 1000) brain.setOverride({});
      // The march gate at its neutral value has to be as inert as no advice
      // at all — the whole reason every playbook ships marchConfidence: 0.
      if (t === 1500) brain.setOverride({marchConfidence: 0});
      if (t === 2000) brain.setOverride(null);
      const commands = brain.shouldDecide(world.tick)
        ? brain.decide(world)
        : [];
      tickWorld(
        world,
        commands.map(cmd => ({playerId: 1, cmd})),
      );
    }
    expect(digest(world)).toEqual(baseline);
  });

  it('an eager override marches the army sooner', () => {
    const patient = firstMarchTick(null, 20_000);
    const eager = firstMarchTick(
      {armyAttackSize: 3, attackCooldown: 200},
      20_000,
    );
    expect(eager).toBeLessThan(patient);
  }, 120_000);

  it('holds out of a garrison it cannot beat — and does not sweep instead', () => {
    const {world, brain} = siegeStandoff();
    brain.setOverride({marchConfidence: 60});
    // No march on the castle, and — the part worth pinning — no consolation
    // sweep either. Falling through to the sweep branch would send the whole
    // army walking into unexplored ground, which is worse than the march it
    // just refused. Rallying home is allowed, and is the point.
    expect(marchOrders(brain.decide(world), 30, 30)).toEqual([]);
  });

  it('marches on the same garrison once the odds have turned', () => {
    const {world, brain} = siegeStandoff();
    // Same defenders, a far bigger muster: the hold lifts by growing out of
    // it, which is how it lifts in a real match.
    for (let i = 0; i < 24; i++)
      spawnUnit(world, UnitTypeId.knight, 0, 33.5, 20.5 + i * 0.4);
    brain.setOverride({marchConfidence: 60});
    expect(marchOrders(brain.decide(world), 30, 30).length).toBeGreaterThan(0);
  });

  it('a hold does not outlive the forlorn clock', () => {
    // The escape valve #oddsSay promises — a seat that never likes its odds
    // still marches eventually — used to lean on the defenders' picture
    // going stale, and a working scout never lets it: the yard is re-read
    // on the refresh clock, the garrison stays inside the trust window,
    // and the veto renews itself forever. Past the forlorn line the clock
    // itself breaks the standoff.
    const {world, brain} = siegeStandoff();
    brain.setOverride({marchConfidence: 60});
    expect(marchOrders(brain.decide(world), 30, 30)).toEqual([]); // the hold, while fresh
    world.tick = AI_PACING.forlornAfter + 1020;
    expect(marchOrders(brain.decide(world), 30, 30).length).toBeGreaterThan(0);
  });

  it('marches on a good prediction before the headcount bar is met', () => {
    // Four knights against one defender: under the steward's armyAttackSize
    // of seven this seat would still be waiting, and the prediction is what
    // sends it. The accelerator is the half of this that the sweeps say is
    // worth having.
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    for (let i = 0; i < 4; i++)
      spawnUnit(world, UnitTypeId.knight, 0, 33.5, 29.5 + i);
    addStorehouse(world, 44, 30, {}, 1);
    spawnUnit(world, UnitTypeId.spearman, 1, 45.5, 30.5);
    spawnUnit(world, UnitTypeId.knight, 0, 42.5, 30.5); // scout, lighting castle and yard
    world.tick = 1000;
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    brain.setStancePolicy(false); // the printed bar of seven is the subject
    brain.setWarBehaviors([]); // and the herald would hold the march
    expect(marchOrders(brain.decide(world), 30, 30)).toEqual([]); // headcount says wait
    brain.setOverride({marchConfidence: 60});
    expect(marchOrders(brain.decide(world), 30, 30).length).toBeGreaterThan(0);
  });

  it('marches into that same garrison when the gate is off', () => {
    const {world, brain} = siegeStandoff();
    brain.setOverride({marchConfidence: 0});
    expect(marchOrders(brain.decide(world), 30, 30).length).toBeGreaterThan(0);
  });

  it('AiSeats routes advice to the seat it names, and shrugs at one it cannot find', () => {
    const world = createWorld({
      seed: 7,
      players: [
        {kind: PlayerKind.human},
        {kind: PlayerKind.ai},
        {kind: PlayerKind.ai},
      ],
    });
    const seats = new AiSeats(world);
    expect(seats.seatIds()).toEqual([1, 2]);
    seats.applyAdvice(1, {armyAttackSize: 3});
    // Advice can outlive the brain it was meant for; a seat that is not
    // there is a no-op, not a crash.
    seats.applyAdvice(9, {armyAttackSize: 3});
  });
});

/**
 * The growth-stall clamp on the muster bar (AI_PACING.growthStallAfter).
 * The blind spot it closes: an army that peaks below the playbook's size
 * and then bleeds to raids stays under the impatience ramp forever — the
 * bar chases the army down and never catches it, and the seat feeds its
 * soldiers to the war one at a time without ever fighting it.
 */
describe('the muster bar under a growth stall', () => {
  /** Five knights, a bar of seven, and an undefended rival castle the
   * scout has lit: everything but the headcount says march. */
  function shortMuster(): {world: World; brain: AiBrain} {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    for (let i = 0; i < 4; i++)
      spawnUnit(world, UnitTypeId.knight, 0, 33.5, 27.5 + i);
    addStorehouse(world, 44, 30, {}, 1);
    spawnUnit(world, UnitTypeId.knight, 0, 42.5, 30.5); // the scout, lighting it
    world.tick = 1000;
    return {
      world,
      brain: new AiBrain(
        0,
        AI_STRATEGIES[AiStrategyId.steward],
        world.map.size,
      ),
    };
  }

  it('marches what it has once the army has stopped growing', () => {
    const {world, brain} = shortMuster();
    expect(marchOrders(brain.decide(world), 30, 30)).toEqual([]); // the playbook waits
    // Long past the stall window with nobody new under arms, it marches —
    // well before the impatience ramp would have moved the bar at all.
    world.tick = 1000 + AI_PACING.growthStallAfter + 40;
    expect(world.tick).toBeLessThan(AI_PACING.staleAfter);
    expect(marchOrders(brain.decide(world), 30, 30).length).toBeGreaterThan(0);
  });

  it('keeps the full bar while the barracks is still delivering', () => {
    const {world, brain} = shortMuster();
    expect(marchOrders(brain.decide(world), 30, 30)).toEqual([]);
    // A recruit lands just before the window closes: growth restamps the
    // clock, and the seat keeps mustering toward the playbook's size.
    spawnUnit(world, UnitTypeId.knight, 0, 33.5, 31.5);
    world.tick = 1000 + AI_PACING.growthStallAfter + 40;
    expect(marchOrders(brain.decide(world), 30, 30)).toEqual([]);
  });
});

/**
 * The stall watchdog (AI_STALL) and the rules it turns on. Two promises,
 * and they are the two the risk section of the plan names: a seat that is
 * going somewhere never sees any of this, and a seat that is not gets the
 * cheapest move that could restart it.
 */
describe('the stall watchdog', () => {
  /** A village that has stopped: one gatherer with a full hut, no loose
   * serf to empty it, and nothing else to do. The shape seed 9 reaches. */
  function frozenVillage(): {world: World; brain: AiBrain; hut: Building} {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    addResourceTile(world, 40, 41);
    const hut = addBuiltHut(world, 40, 40);
    hut.stock = {[GoodId.wood]: OUTPUT_CAP};
    return {
      world,
      brain: new AiBrain(
        0,
        AI_STRATEGIES[AiStrategyId.steward],
        world.map.size,
      ),
      hut,
    };
  }

  /** Beat the brain forward to `until`, keeping the world frozen — only the
   * brain's own window advances, which is exactly what is under test. */
  function beatUntil(
    brain: AiBrain,
    world: World,
    until: number,
  ): SimCommand[] {
    let last: SimCommand[] = [];
    while (world.tick < until) {
      world.tick += AI_PACING.decisionInterval;
      if (brain.shouldDecide(world.tick)) last = brain.decide(world);
    }
    return last;
  }

  it('says nothing until the window is full, then says stalled', () => {
    const {world, brain} = frozenVillage();
    beatUntil(brain, world, AI_STALL.graceUntil);
    expect(brain.stallReport().beats).toBe(0);
    // One full window past the grace period and the reading has turned.
    beatUntil(
      brain,
      world,
      AI_STALL.graceUntil + AI_STALL.samplePeriod * AI_STALL.window,
    );
    expect(brain.stallReport().stalled).toBe(true);
    expect(brain.stallReport().beats).toBeGreaterThan(0);
  });

  it('buys a hauler with a post nobody is using, without waiting for the window', () => {
    const {world, brain, hut} = frozenVillage();
    // The first beat, not the one fourteen thousand ticks later. Zero loose
    // hands beside a capped post is the dead end itself rather than evidence
    // of one — the replay this was re-cut from has three seats reach it and
    // none of them live long enough for the watchdog to agree.
    const commands = beatUntil(brain, world, AI_PACING.decisionInterval * 2);
    expect(brain.stallReport().stalled).toBe(false);
    // The hut is capped, so its resident is producing nothing at all. He is
    // worth more carrying the pile to the storehouse than standing beside it,
    // and halting the hut is what hands him back.
    expect(commands).toContainEqual({
      kind: CommandKind.setBuildingPaused,
      buildingId: hut.id,
      paused: true,
    });
    expect(brain.stallReport().recoveries).toBeGreaterThan(0);
  });

  it('leaves the post alone once the pool is back over the floor', () => {
    // The guard that keeps this off every healthy seat: hands enough to
    // work with and the capped hut is somebody's next errand, not a village
    // to break up.
    const {world, brain, hut} = frozenVillage();
    for (let i = 0; i < AI_STRATEGIES[AiStrategyId.steward].survivalFloor; i++)
      addSerf(world, 31 + i, 31);
    const commands = beatUntil(brain, world, AI_PACING.decisionInterval * 2);
    expect(commands).not.toContainEqual({
      kind: CommandKind.setBuildingPaused,
      buildingId: hut.id,
      paused: true,
    });
  });

  it('starts the halted post again once its pile has shipped', () => {
    // The other half of the trade: the hand was borrowed, not given away.
    // A post left halted for the rest of the match is a hut thrown away.
    const {world, brain, hut} = frozenVillage();
    hut.paused = true;
    hut.stock = {};
    const commands = beatUntil(brain, world, AI_PACING.decisionInterval * 2);
    expect(commands).toContainEqual({
      kind: CommandKind.setBuildingPaused,
      buildingId: hut.id,
      paused: false,
    });
  });

  it('leaves a halted post alone while the pile it was halted over still stands', () => {
    const {world, brain, hut} = frozenVillage();
    hut.paused = true; // stock is still at OUTPUT_CAP from frozenVillage
    const commands = beatUntil(brain, world, AI_PACING.decisionInterval * 2);
    expect(commands).not.toContainEqual({
      kind: CommandKind.setBuildingPaused,
      buildingId: hut.id,
      paused: false,
    });
  });

  it('the freed hand actually rejoins the haul pool', () => {
    // The landmine this rule exists to avoid: a resident released mid-trip
    // used to keep a gather task nothing would ever advance, and dispatch,
    // staffing and wander all want a genuinely idle unit. A hand freed to
    // haul that cannot haul makes the spiral worse, not better.
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    addResourceTile(world, 40, 41);
    const hut = addBuiltHut(world, 40, 40);
    hut.stock = {[GoodId.wood]: OUTPUT_CAP};
    const worker = world.units.get(hut.workerId!)!;
    worker.task = {
      t: UnitTaskKind.gatherWork,
      tile: tileIdx(40, 41, world.map.size),
      until: 999_999,
    };
    tickWorld(
      world,
      cmds({
        kind: CommandKind.setBuildingPaused,
        buildingId: hut.id,
        paused: true,
      }),
    );
    expect(worker.kind).toBe(UnitTypeId.serf);
    // Idle, or already claimed for a haul — either is in the pool. What is
    // fatal is a leftover gather task.
    expect([UnitTaskKind.idle, UnitTaskKind.haul]).toContain(worker.task.t);
  });

  it('sells a worked-out extractor so the build order can re-site it', () => {
    const world = bareWorld();
    // An empty shelf, which is the state a wood famine actually arrives in:
    // the seat has no wood BECAUSE the hut is standing on bare ground, and
    // the sale is the only thing that can hand it any. A guard that wanted
    // the wood first was a guard the case could never clear.
    addStorehouse(world, 30, 30, {});
    const dead = addBuiltHut(world, 40, 40); // no resource tile in reach
    addResourceTile(world, 12, 12); // ...but a live grove clear across the map
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    // The very first beat: a cleared radius is a direct reading of the map
    // and a permanent one, so it does not wait out the stall window — which
    // in a real match does not open until AI_STALL.graceUntil, long after
    // the seat has spent the famine.
    world.tick += AI_PACING.decisionInterval;
    expect(brain.decide(world)).toContainEqual({
      kind: CommandKind.sellBuilding,
      buildingId: dead.id,
    });
  });

  it('saves its last planks for the woodcutter instead of buying a well', () => {
    // The other half of the wood famine. The build order takes the first
    // step that is both affordable and placeable, and every playbook prices
    // its well at 4 against a woodcutter's 6 — so a seat holding the scrap
    // of the hut it just sold bought the well with it, and the log supply
    // it was saving for never came back.
    const plank = (wood: number, grove: boolean): SimCommand[] => {
      const world = bareWorld(1, 2);
      addStorehouse(world, 10, 50, {}, 1);
      addStorehouse(world, 30, 30, {[GoodId.wood]: wood});
      if (grove) for (let x = 12; x < 18; x++) addResourceTile(world, x, 12);
      const brain = new AiBrain(
        0,
        AI_STRATEGIES[AiStrategyId.steward],
        world.map.size,
      );
      world.tick += AI_PACING.decisionInterval;
      return brain
        .decide(world)
        .filter(c => c.kind === CommandKind.placeBuilding);
    };
    const well = {building: BuildingTypeId.well};
    const cutter = {building: BuildingTypeId.woodcutter};

    // Two planks short of the cutter, with trees to put it on: hold them.
    expect(plank(4, true)).toEqual([]);
    // Enough, and the plan's own first step goes up.
    expect(plank(6, true)).toMatchObject([cutter]);
    // No trees anywhere on the map, so there is nothing to save for and
    // saving would only freeze the village: the well is the right answer
    // and the seat still lays it. This is the guard that keeps the reserve
    // from being a deadlock.
    expect(plank(4, false)).toMatchObject([well]);
  });

  it("sites a gatherer on its own side of the valley, never in a rival's yard", () => {
    // The played case (seed 55973911): a warlord whose home iron was dug
    // out found the next nearest iron on the map — the human's home seam,
    // five tiles from the human's guard tower — and laid a mine on it
    // every beat for two thousand ticks. The soldiers standing beside it
    // razed forty-six foundations, and the wood, stone, tools and hands
    // sent after each one were lost on the road. Nearest is not
    // reachable when the ground between is somebody else's yard.
    const world = bareWorld(1, 2);
    addStorehouse(world, 30, 30, {[GoodId.wood]: 20, [GoodId.stone]: 20});
    addStorehouse(world, 10, 50, {}, 1); // the rival, in the south-west
    // The only trees on the map stand at the rival's door.
    for (let x = 8; x < 14; x++) addResourceTile(world, x, 46);
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    const placed = (): SimCommand[] => {
      world.tick += AI_PACING.decisionInterval;
      return brain
        .decide(world)
        .filter(c => c.kind === CommandKind.placeBuilding);
    };
    // The plan's first step is the woodcutter, and there is wood on the
    // shelf for it: it is skipped for the grove's owner alone, and the
    // plan moves on to a step with ground of its own.
    expect(placed()).not.toContainEqual(
      expect.objectContaining({building: BuildingTypeId.woodcutter}),
    );
    // A dead rival's yard is open ground.
    world.players[1]!.alive = false;
    const cutter = placed().find(
      c =>
        c.kind === CommandKind.placeBuilding &&
        c.building === BuildingTypeId.woodcutter,
    ) as {x: number; y: number} | undefined;
    expect(cutter).toBeDefined();
    expect(Math.abs(cutter!.y - 46)).toBeLessThanOrEqual(6);
  });

  it("will not sell a worked-out extractor when the only live ground is a rival's", () => {
    // The sale is only worth making if the build order can re-site the
    // hut, and it reads the same line: a grove at a living rival's door
    // is not somewhere to go.
    const world = bareWorld(1, 2);
    addStorehouse(world, 30, 30, {});
    addStorehouse(world, 10, 50, {}, 1);
    const dead = addBuiltHut(world, 40, 40); // no resource tile in reach
    for (let x = 8; x < 14; x++) addResourceTile(world, x, 46);
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    const sale = {kind: CommandKind.sellBuilding, buildingId: dead.id};
    world.tick += AI_PACING.decisionInterval;
    expect(brain.decide(world)).not.toContainEqual(sale);
    world.players[1]!.alive = false;
    world.tick += AI_PACING.decisionInterval;
    expect(brain.decide(world)).toContainEqual(sale);
  });

  it('does not lay a foundation again on ground where the last one was razed', () => {
    // The other half of the played case: a foundation stands at a fifth
    // of its hp with nothing delivered, so soldiers already on the ground
    // raze it inside a beat — and the build order, which rebuilds losses,
    // laid the next one on the same tile the next beat, forty-six times.
    // Every one sent haulers down the road with wood that was destroyed
    // when the site died under them.
    const world = bareWorld(1, 2);
    addStorehouse(world, 10, 50, {}, 1); // a rival, so the match keeps playing
    addStorehouse(world, 30, 30, {[GoodId.wood]: 40, [GoodId.stone]: 40});
    for (let x = 12; x < 18; x++) addResourceTile(world, x, 12); // the grove
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    const beat = (): SimCommand[] => {
      world.tick += AI_PACING.decisionInterval;
      const commands = brain.decide(world);
      tickWorld(
        world,
        commands.map(cmd => ({playerId: 0, cmd})),
      );
      return commands.filter(c => c.kind === CommandKind.placeBuilding);
    };
    const cutters = (placed: SimCommand[]): SimCommand[] =>
      placed.filter(
        c =>
          c.kind === CommandKind.placeBuilding &&
          c.building === BuildingTypeId.woodcutter,
      );
    // The plan's first step goes up at the grove, and the seat reads its
    // own foundation as the step met.
    expect(cutters(beat()).length).toBe(1);
    expect(cutters(beat())).toEqual([]);
    const site = [...world.buildings.values()].find(
      b => b.type === BuildingTypeId.woodcutter,
    )!;
    expect(site.state).toBe(BuildingState.site);
    // Razed before a plank arrived.
    destroyBuilding(world, site);
    // The next beat learns of it and lays nothing there — the plan moves on
    // to a step with ground of its own, at the castle, rather than
    // stalling.
    const next = beat();
    expect(cutters(next)).toEqual([]);
    expect(next.length).toBe(1);
    for (let i = 0; i < 3; i++) expect(cutters(beat())).toEqual([]);
    // And once the mark has aged out, the grove is worth a hut again.
    world.tick += AI_SITING.razedFor;
    expect(cutters(beat()).length).toBe(1);
  });

  it('a razed house in the yard marks nothing: only outposts leave a mark', () => {
    // The castle yard is rebuilt under fire on purpose, and a house lost
    // there must not keep the next woodcutter off the grove at the door.
    const world = bareWorld(1, 2);
    // Own castle first: addStorehouse pads world.starts up to the owner it
    // is given, and a rival added first would leave seat 0's start at 0,0.
    addStorehouse(world, 30, 30, {[GoodId.wood]: 40, [GoodId.stone]: 40});
    addStorehouse(world, 10, 50, {}, 1);
    for (let x = 33; x < 38; x++) addResourceTile(world, x, 34); // at the door
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    // A house foundation two tiles from that grove, seen by the brain and
    // then razed before the next beat.
    const house = placeSite(world, BuildingTypeId.house, 0, 34, 31);
    world.tick += AI_PACING.decisionInterval;
    brain.decide(world);
    destroyBuilding(world, house);
    world.tick += AI_PACING.decisionInterval;
    const cutter = brain
      .decide(world)
      .find(
        c =>
          c.kind === CommandKind.placeBuilding &&
          c.building === BuildingTypeId.woodcutter,
      ) as {x: number; y: number} | undefined;
    expect(cutter).toBeDefined();
    expect(Math.abs(cutter!.y - 34)).toBeLessThanOrEqual(6);
  });

  it('will not sell a worked-out extractor with nowhere live to move to', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {[GoodId.wood]: 20});
    const dead = addBuiltHut(world, 40, 40);
    // No live tile anywhere on the map: selling would be losing a building
    // for nothing, since the build order has no ground to re-site onto.
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    const commands = beatUntil(
      brain,
      world,
      AI_STALL.graceUntil + AI_STALL.samplePeriod * AI_STALL.window + 100,
    );
    expect(commands).not.toContainEqual({
      kind: CommandKind.sellBuilding,
      buildingId: dead.id,
    });
  });

  it('sells both dead cutters, then raises one on live trees', () => {
    // The played case (seed 63759505): two woodcutters worked the same
    // grove flat, the shelf sat at 0-2 wood for the rest of the match, and
    // the seat never cut another log. A woodcutter costs 6 with 3 back, so
    // neither sale alone pays for the replacement and both together do —
    // which is the whole reason the affordability guard had to go.
    const world = bareWorld(1, 2);
    addStorehouse(world, 10, 50, {}, 1); // a rival, so the match keeps playing
    addStorehouse(world, 30, 30, {});
    const deadA = addBuiltHut(world, 40, 40);
    const deadB = addBuiltHut(world, 44, 40);
    for (let x = 12; x < 18; x++) addResourceTile(world, x, 12); // a live grove
    addSerf(world, 31, 31); // one hand to cart the salvage home
    // The one build step that costs less than a woodcutter, already
    // standing — as it is on any seat that has been playing long enough to
    // work a grove flat. Without it a village with nothing at all spends
    // the first four planks of the scrap on a well, which is the build
    // order's ordinary "first affordable step wins" and not this rule's
    // business.
    placeBuiltBuilding(world, BuildingTypeId.well, 0, 28, 28);
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    const seen: SimCommand[] = [];
    while (world.tick < 4000) {
      const beat = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
      seen.push(...beat);
      tickWorld(
        world,
        beat.map(cmd => ({playerId: 0, cmd})),
      );
    }
    const sold = seen.filter(c => c.kind === CommandKind.sellBuilding);
    expect(sold.map(c => c.buildingId).sort((a, z) => a - z)).toEqual([
      deadA.id,
      deadB.id,
    ]);
    // And the scrap paid for a hut back on standing timber.
    const raised = [...world.buildings.values()].filter(
      b => b.type === BuildingTypeId.woodcutter,
    );
    expect(raised.length).toBeGreaterThan(0);
    for (const b of raised) {
      expect(
        countResourceNear(world.map, b.x + 1, b.y + 1, TileResource.Wood, 8),
      ).toBeGreaterThan(0);
    }
  });

  it('starts a threatened tower, and halts it again once the ground is quiet', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const tower = placeBuiltBuilding(
      world,
      BuildingTypeId.guardTower,
      0,
      36,
      36,
    );
    tower.paused = true; // as one comes off the scaffold
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    const beat = (): SimCommand[] => {
      world.tick += AI_PACING.decisionInterval;
      return brain.shouldDecide(world.tick) ? brain.decide(world) : [];
    };
    const start = {
      kind: CommandKind.setBuildingPaused,
      buildingId: tower.id,
      paused: false,
    };
    const halt = {
      kind: CommandKind.setBuildingPaused,
      buildingId: tower.id,
      paused: true,
    };

    // Quiet ground: no reason to take anyone off a haul.
    expect(beat()).not.toContainEqual(start);

    // A raider walks into sight of the tower.
    const raider = spawnUnit(world, UnitTypeId.bandit, BANDIT, 37.5, 38.5);
    expect(beat()).toContainEqual(start);

    // Not re-issued once it is actually running.
    tower.paused = undefined;
    expect(beat()).not.toContainEqual(start);

    // He dies, and the hold keeps it running a while yet.
    raider.dead = true;
    expect(beat()).not.toContainEqual(halt);

    // Past the hold it halts — which is the whole stand-down, villagers
    // included, so there is one order and no more.
    world.tick += LEVY_HOLD;
    tower.garrison = 1;
    tower.garrisonKind = UnitTypeId.serf;
    const out = beat();
    expect(out).toContainEqual(halt);
    expect(
      out.filter(c => c.kind === CommandKind.setBuildingPaused),
    ).toHaveLength(1);
  });

  it('walks an archer up to a tower under attack instead of leaving it to the levy', () => {
    // The levy is the stopgap, not the answer. It throws rocks for 4 damage
    // on a 30-tick clock — about a quarter of what the same two men do with
    // bows — and exists to hold a wall UNTIL archers do. The manning rule
    // used to bail out the moment anything hostile came into sight, which
    // had it backwards: a seat with an archer standing in the yard answered
    // the raid with stones and kept the archer for the field.
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const tower = placeBuiltBuilding(
      world,
      BuildingTypeId.guardTower,
      0,
      36,
      36,
    );
    // Running, and the villagers are already up — the raid caught it as the
    // levy branch always used to leave it.
    tower.garrison =
      BUILDING_DEFS[BuildingTypeId.guardTower].garrison!.capacity;
    tower.garrisonKind = UnitTypeId.serf;
    spawnUnit(world, UnitTypeId.bandit, BANDIT, 37.5, 38.5);
    const archer = spawnUnit(world, UnitTypeId.archer, 0, 34.5, 34.5);
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    world.tick += AI_PACING.decisionInterval;
    const out = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
    // He is the wall's now: claimed for the tower means left out of the
    // army, so nothing marches him anywhere. A soldier at the door relieves
    // the whole levy, so the villagers go back to their errands.
    expect(
      out.some(
        c => c.kind === CommandKind.moveUnits && c.unitIds.includes(archer.id),
      ),
    ).toBe(false);
    // And the tower keeps running while he walks — a besieged wall is never
    // stood down, whoever is holding it.
    expect(out).not.toContainEqual({
      kind: CommandKind.setBuildingPaused,
      buildingId: tower.id,
      paused: true,
    });
  });

  it('keeps a besieged tower running when there is no soldier to spare', () => {
    // The other half of the same rule: the levy is still the fallback. With
    // nobody to walk up, a tower with something hostile in sight is left
    // running for the villagers to climb rather than emptied.
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const tower = placeBuiltBuilding(
      world,
      BuildingTypeId.guardTower,
      0,
      36,
      36,
    );
    tower.paused = true; // as one comes off the scaffold
    spawnUnit(world, UnitTypeId.bandit, BANDIT, 37.5, 38.5);
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    world.tick += AI_PACING.decisionInterval;
    const out = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
    expect(out).toContainEqual({
      kind: CommandKind.setBuildingPaused,
      buildingId: tower.id,
      paused: false,
    });
  });

  it('leaves a tower alone while a soldier is walking to it', () => {
    // The stand-down cycle: an archer stops counting as loose the moment
    // staffing claims him, so a seat that halts on the next quiet beat turns
    // him away at the door he has nearly reached — and he goes idle, is seen
    // loose again, and is walked over again, forever.
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const tower = placeBuiltBuilding(
      world,
      BuildingTypeId.guardTower,
      0,
      36,
      36,
    );
    const archer = spawnUnit(world, UnitTypeId.archer, 0, 40.5, 40.5);
    archer.task = {t: UnitTaskKind.staff, buildingId: tower.id};
    tower.recruitId = archer.id;
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    world.tick += AI_PACING.decisionInterval;
    const out = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
    expect(out.filter(c => c.kind === CommandKind.setBuildingPaused)).toEqual(
      [],
    );
  });

  it('lets an idle archer relieve a levy rather than standing it down', () => {
    // A soldier at the door relieves the whole levy, so a tower full of
    // villagers still has room for him. Reading the roof as full stood the
    // levy down on quiet ground with an archer standing idle beside it.
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const tower = placeBuiltBuilding(
      world,
      BuildingTypeId.guardTower,
      0,
      36,
      36,
    );
    tower.garrison =
      BUILDING_DEFS[BuildingTypeId.guardTower].garrison!.capacity;
    tower.garrisonKind = UnitTypeId.serf;
    spawnUnit(world, UnitTypeId.archer, 0, 34.5, 34.5);
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    world.tick += AI_PACING.decisionInterval;
    const out = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
    expect(out.filter(c => c.kind === CommandKind.setBuildingPaused)).toEqual(
      [],
    );
  });

  it('does not open a tower for an archer it has just marched away', () => {
    // The order is queued, not applied, so the archer still reads as idle
    // when the walls are considered. A tower opened for him is a tower
    // opened for nobody — and an empty running tower calls villagers up.
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const tower = placeBuiltBuilding(
      world,
      BuildingTypeId.guardTower,
      0,
      36,
      36,
    );
    tower.paused = true;
    const archer = spawnUnit(world, UnitTypeId.archer, 0, 34.5, 34.5);
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    world.tick += AI_PACING.decisionInterval;
    const out = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
    const marched = out.some(
      c => c.kind === CommandKind.moveUnits && c.unitIds.includes(archer.id),
    );
    const started = out.some(
      c =>
        c.kind === CommandKind.setBuildingPaused &&
        c.buildingId === tower.id &&
        !c.paused,
    );
    // Whichever the seat picks, it does not pick both for the one man.
    expect(marched && started).toBe(false);
  });

  it('claims nobody for a tower nothing can walk to', () => {
    // Staffing holds off on a post it failed to path to. Men reserved for a
    // wall while that hold stands are men kept out of the army for a walk
    // that never starts — and a walled-off tower would keep reserving them
    // for as long as it stood there.
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const tower = placeBuiltBuilding(
      world,
      BuildingTypeId.guardTower,
      0,
      36,
      36,
    );
    tower.paused = true;
    tower.staffBackoffUntil = world.tick + 10_000; // walled off, for now
    spawnUnit(world, UnitTypeId.archer, 0, 34.5, 34.5);
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    world.tick += AI_PACING.decisionInterval;
    const out = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
    // No point opening it: nobody can get in, and the archer stays the
    // army's to spend.
    expect(out.filter(c => c.kind === CommandKind.setBuildingPaused)).toEqual(
      [],
    );
  });

  it('never stands a tower its archers hold down, or up', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const tower = placeBuiltBuilding(
      world,
      BuildingTypeId.guardTower,
      0,
      36,
      36,
    );
    tower.garrison =
      BUILDING_DEFS[BuildingTypeId.guardTower].garrison!.capacity;
    tower.garrisonKind = UnitTypeId.archer;
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    world.tick += AI_PACING.decisionInterval;
    const out = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
    // Halting a tower now empties the roof whoever is on it, so the
    // quiet-ground halt is held back from one the soldiers hold: standing
    // them down would trade a wall that cannot be shot back at for two men
    // in the open, and start them climbing back up at the next sighting.
    expect(out.filter(c => c.kind === CommandKind.setBuildingPaused)).toEqual(
      [],
    );
    expect(tower.garrison).toBe(
      BUILDING_DEFS[BuildingTypeId.guardTower].garrison!.capacity,
    );
  });

  it('leaves a seat that is going somewhere byte-identical', () => {
    // The whole safety story: the watchdog is memory and a comparison, and
    // an unstalled seat must play the game it played before it existed.
    // Long enough to run past graceUntil and a full window.
    const config: WorldConfig = {
      seed: 7,
      players: [{kind: PlayerKind.human}, {kind: PlayerKind.ai}],
    };
    expect(digest(runWithBrains(config, 40_000))).toEqual(
      digest(runWithBrains(config, 40_000)),
    );
  }, 240_000);
});

/**
 * Rebuilding after a raid.
 *
 * A raid that takes the hands rather than the buildings leaves a seat that
 * looks alive and is not: every post staffed, every gatherer capped, and
 * nobody left to carry anything. The village cannot buy its way out either,
 * because the silver that pays for a hire is in a mine only a serf can
 * empty. What is covered here is the seat spending its way back — the hand
 * it frees, the hand it refuses to spend, and the silver it keeps for the
 * next one.
 */
describe('a village that lost its hands', () => {
  /** A seat with a barracks and no loose serfs — a raid's aftermath, with
   * the post that would eat the next hand still taking orders. */
  function raidedVillage(): {world: World; brain: AiBrain; barracks: Building} {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const barracks = placeBuiltBuilding(
      world,
      BuildingTypeId.barracks,
      0,
      36,
      36,
    );
    return {
      world,
      brain: new AiBrain(
        0,
        AI_STRATEGIES[AiStrategyId.steward],
        world.map.size,
      ),
      barracks,
    };
  }

  function beat(brain: AiBrain, world: World): SimCommand[] {
    world.tick += AI_PACING.decisionInterval;
    return brain.shouldDecide(world.tick) ? brain.decide(world) : [];
  }

  it('stands the barracks down while the pool is below the survival floor', () => {
    const {world, brain, barracks} = raidedVillage();
    expect(beat(brain, world)).toContainEqual({
      kind: CommandKind.setBuildingPaused,
      buildingId: barracks.id,
      paused: true,
    });
  });

  it('spends no hand on a soldier while it is short of hands', () => {
    // The trade the hold exists for: a knight is a serf plus a sword, so a
    // warm queue is a standing order against the one thing the village has
    // none of. Paired on purpose — the same seat, the same beat, one serf
    // either side of the floor.
    const {world, brain} = raidedVillage();
    for (let i = 0; i < AI_STRATEGIES[AiStrategyId.steward].survivalFloor; i++)
      addSerf(world, 31 + i, 31);
    expect(
      beat(brain, world).filter(c => c.kind === CommandKind.trainUnit),
    ).not.toEqual([]);

    const raided = raidedVillage();
    for (
      let i = 0;
      i < AI_STRATEGIES[AiStrategyId.steward].survivalFloor - 1;
      i++
    )
      addSerf(raided.world, 31 + i, 31);
    const held = beat(raided.brain, raided.world);
    expect(held.filter(c => c.kind === CommandKind.trainUnit)).toEqual([]);
    expect(held).toContainEqual({
      kind: CommandKind.setBuildingPaused,
      buildingId: raided.barracks.id,
      paused: true,
    });
  });

  it('opens the barracks again once the pool is a hand clear of the floor', () => {
    // Borrowed, not given away: a hold that outlives its reason is an army
    // the seat never builds. The margin is one hand, because taking a
    // recruit costs exactly one — reopening AT the floor hands the
    // recruiter the hand that put the seat back over it.
    const {world, brain, barracks} = raidedVillage();
    barracks.paused = true;
    const open = {
      kind: CommandKind.setBuildingPaused,
      buildingId: barracks.id,
      paused: false,
    };
    for (let i = 0; i < AI_STRATEGIES[AiStrategyId.steward].survivalFloor; i++)
      addSerf(world, 31 + i, 31);
    expect(beat(brain, world)).not.toContainEqual(open); // at the floor: the hold stands

    addSerf(world, 35, 31); // one clear of it
    expect(beat(brain, world)).toContainEqual(open);
  });

  it('does not flap across the floor, booking hauls it cannot crew', () => {
    // What the band is for. A barracks reopened at the floor takes a
    // recruit, drops the seat back under, and is held again — and each
    // opening books priority-2 bread and weapon hauls that outrank the
    // storehouse evacuation and OUTLIVE the next hold, since pausing
    // suppresses new demand but does not stand down errands already on the
    // board. On the replay this was cut from, a flapping rule served nine
    // such hauls with the two hands the seat had; with the band, one — the
    // one already in a serf's hands when the hold came down.
    const {world, brain, barracks} = raidedVillage();
    const floor = AI_STRATEGIES[AiStrategyId.steward].survivalFloor;
    for (let i = 0; i < floor; i++) addSerf(world, 31 + i, 31);
    const halt = {
      kind: CommandKind.setBuildingPaused,
      buildingId: barracks.id,
      paused: true,
    };
    const open = {
      kind: CommandKind.setBuildingPaused,
      buildingId: barracks.id,
      paused: false,
    };

    // At the floor with the barracks running, nothing happens: the rule
    // closes under the line, it does not go looking for a barracks to shut.
    expect(beat(brain, world)).not.toContainEqual(halt);

    // The recruiter takes one and the seat drops under: held.
    const serfs = [...world.units.values()].filter(
      u => u.kind === UnitTypeId.serf,
    );
    serfs[0]!.dead = true;
    expect(beat(brain, world)).toContainEqual(halt);
    barracks.paused = true; // the order lands

    // The hire lands and the pool is back at the floor exactly. Without the
    // band this is where it reopens, re-books the hauls, and takes the hand
    // straight back. With it, the hold stands and the queue is not refilled.
    serfs[0]!.dead = false;
    const atFloor = beat(brain, world);
    expect(atFloor).not.toContainEqual(open);
    expect(atFloor.filter(c => c.kind === CommandKind.trainUnit)).toEqual([]);
  });

  it('lets the recruiter take one hand past the floor, and no more', () => {
    // The accepted cost of the band's loose lower edge, pinned so it cannot
    // quietly get worse. Reopening at floor+1 hands the recruiter one, and
    // `staffingSystem` sweeps every 25 ticks against a brain deciding every
    // 20 — so a queue two deep can take a second before the hold comes back
    // down. It lands at floor-1 and stops there.
    //
    // Closing the edge (`<= floor`) removes the dip and costs the campaign
    // 448 wins of 640 against 491 — worse than having no rule at all. A
    // seat that will not train while it sits AT its floor never fields an
    // army, and sitting at the floor is what a raided village does.
    const world = bareWorld(1, 2);
    addStorehouse(world, 30, 30, {[GoodId.food]: 40, [GoodId.sword]: 40});
    addStorehouse(world, 60, 60, {}, 1); // a rival, so the match does not end at tick 1
    const barracks = placeBuiltBuilding(
      world,
      BuildingTypeId.barracks,
      0,
      36,
      36,
    );
    barracks.inputs = {[GoodId.food]: 30, [GoodId.sword]: 30};
    barracks.paused = true;
    const floor = AI_STRATEGIES[AiStrategyId.steward].survivalFloor;
    for (let i = 0; i < floor + 1; i++) addSerf(world, 31 + i, 31);
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    const loose = (): number =>
      [...world.units.values()].filter(
        u => !u.dead && u.kind === UnitTypeId.serf,
      ).length;
    let low = loose();
    for (let t = 0; t < 2000; t++) {
      const commands = brain.shouldDecide(world.tick)
        ? brain.decide(world)
        : [];
      tickWorld(
        world,
        commands.map(cmd => ({playerId: 0, cmd})),
      );
      low = Math.min(low, loose());
    }
    expect(low).toBe(floor - 1); // one hand of overshoot
    expect(barracks.paused).toBe(true); // and the hold caught it there
  });

  it('keeps the hire money back from a tech while it is short of hands', () => {
    // Every tech is priced in silver and so is a hand. A seat that spends
    // its way past the hire is a seat that stays short forever.
    //
    // The steward's first tech is Soldiery at 6 silver (defs/techs.ts), and
    // the shelf has to be able to AFFORD it or the guard is not what the
    // assertion is reading — an unaffordable tech is refused a line earlier
    // and the test would pass with the guard deleted.
    const soldiery = TECH_DEFS[TechId.soldiery].cost[GoodId.silver]!;
    const world = bareWorld();
    const shelf = addStorehouse(world, 30, 30, {
      [GoodId.silver]: soldiery + 1,
      [GoodId.wheat]: 20,
    });
    placeBuiltBuilding(world, BuildingTypeId.abbey, 0, 36, 36);
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    expect(
      beat(brain, world).filter(c => c.kind === CommandKind.research),
    ).toEqual([]);

    // And the sum has to count the hire this same beat already ordered:
    // commands apply in the order they are pushed, so the four silver the
    // panic branch just spent is gone before research is charged. Ten
    // silver looks like enough for a 6-silver tech with a hire left over
    // and is not — it is 10 - 4 - 6 = 0.
    shelf.stock[GoodId.silver] = HIRE_SERF_COST + soldiery;
    const beat10 = beat(brain, world);
    expect(beat10.filter(c => c.kind === CommandKind.hireSerf)).not.toEqual([]);
    expect(beat10.filter(c => c.kind === CommandKind.research)).toEqual([]);

    // Not a blanket ban: with the hand, the tech and the NEXT hand all paid
    // for, the queue runs even below the floor.
    shelf.stock[GoodId.silver] = HIRE_SERF_COST * 2 + soldiery;
    expect(
      beat(brain, world).filter(c => c.kind === CommandKind.research),
    ).not.toEqual([]);

    // And with the pool back over the floor the guard is silent entirely —
    // the playbook's own research reserve takes over from here.
    for (let i = 0; i < AI_STRATEGIES[AiStrategyId.steward].survivalFloor; i++)
      addSerf(world, 31 + i, 31);
    shelf.stock[GoodId.silver] = soldiery;
    expect(
      beat(brain, world).filter(c => c.kind === CommandKind.research),
    ).not.toEqual([]);
  });

  it('actually unfreezes: the pile moves and a hand comes back', () => {
    // End to end, against the sim rather than the command list — the shape
    // a four-player replay (seed 47786976) froze in for eleven thousand
    // ticks: a capped hut, a resident standing beside it, and not one loose
    // serf in the village.
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    addResourceTile(world, 40, 41);
    const hut = addBuiltHut(world, 40, 40);
    hut.stock = {[GoodId.wood]: OUTPUT_CAP};
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    let sawSerf = false;
    for (let t = 0; t < 3000; t++) {
      const commands = brain.shouldDecide(world.tick)
        ? brain.decide(world)
        : [];
      tickWorld(
        world,
        commands.map(cmd => ({playerId: 0, cmd})),
      );
      sawSerf ||= [...world.units.values()].some(
        u => !u.dead && u.kind === UnitTypeId.serf,
      );
    }
    expect(sawSerf).toBe(true);
    expect(hut.stock[GoodId.wood] ?? 0).toBeLessThan(OUTPUT_CAP);
  });
});

describe('a forge nobody is buying from', () => {
  /**
   * The Abbot's two-line armory, standing and idle: swords at the first
   * anvil, bowstaves at the second, which is the playbook's own weaponMix
   * — so `forgeTheCounter` has nothing to re-tune and the glut rule is the
   * only thing in the beat with an opinion about a Smith.
   */
  function armory(stock: GoodAmounts): {
    world: World;
    brain: AiBrain;
    swords: Building;
    bows: Building;
  } {
    const world = bareWorld();
    addStorehouse(world, 30, 30, stock);
    const swords = placeBuiltBuilding(
      world,
      BuildingTypeId.weaponsmith,
      0,
      36,
      36,
    );
    const bows = placeBuiltBuilding(
      world,
      BuildingTypeId.weaponsmith,
      0,
      40,
      36,
    );
    swords.recipeIndex = AI_STRATEGIES[AiStrategyId.abbot].weaponMix[0]!;
    bows.recipeIndex = AI_STRATEGIES[AiStrategyId.abbot].weaponMix[1]!;
    return {
      world,
      brain: new AiBrain(0, AI_STRATEGIES[AiStrategyId.abbot], world.map.size),
      swords,
      bows,
    };
  }

  function beat(brain: AiBrain, world: World): SimCommand[] {
    world.tick += AI_PACING.decisionInterval;
    return brain.shouldDecide(world.tick) ? brain.decide(world) : [];
  }

  const halt = (b: Building): SimCommand => ({
    kind: CommandKind.setBuildingPaused,
    buildingId: b.id,
    paused: true,
  });
  const start = (b: Building): SimCommand => ({
    kind: CommandKind.setBuildingPaused,
    buildingId: b.id,
    paused: false,
  });

  it('halts the anvil whose weapon is piling up, and only that one', () => {
    // The bug this rule is for: a bowstave is three wood, the storehouse is
    // bottomless so the forge's own buffer never fills, and the standing
    // order runs forever. The sword line is untouched in the same beat —
    // the rule reads each anvil's own recipe against its own pile.
    const {world, brain, swords, bows} = armory({
      [GoodId.bow]: 12,
      [GoodId.sword]: 1,
    });
    const orders = beat(brain, world);
    expect(orders).toContainEqual(halt(bows));
    expect(orders).not.toContainEqual(halt(swords));
  });

  it('holds its fire between the lines, so an anvil is not flapped', () => {
    // Halting empties the post and starting it calls a hand back across the
    // village, so a forge that stopped and started over a single arrowhead
    // would spend its worker walking. Between the two lines, whatever each
    // anvil is doing it keeps doing.
    const running = armory({[GoodId.bow]: 6});
    expect(beat(running.brain, running.world)).not.toContainEqual(
      halt(running.bows),
    );

    const held = armory({[GoodId.bow]: 6});
    held.bows.paused = true;
    expect(beat(held.brain, held.world)).not.toContainEqual(start(held.bows));
  });

  it('starts it again once the barracks has drawn the pile down', () => {
    // Nothing here is decided permanently: the pile is the only thing the
    // rule reads, so training the archers the forge already paid for is
    // what puts it back to work.
    const {world, brain, bows} = armory({[GoodId.bow]: 2});
    bows.paused = true;
    expect(beat(brain, world)).toContainEqual(start(bows));
  });

  it('leaves an anvil with a batch in its queue alone', () => {
    // A queued order jumps the standing recipe, and `keepTheToolsComing` is
    // what puts tools there — so a forge with a queue is a forge making
    // something the village asked for by name.
    const {world, brain, bows} = armory({[GoodId.bow]: 12});
    bows.forgeQueue = [{recipeIndex: 4, started: false}];
    expect(beat(brain, world)).not.toContainEqual(halt(bows));
  });

  it('starts a halted anvil rather than leave a post without its tool', () => {
    // The guarantee that lets the rule above stand every forge in the
    // village down. Nine of the ten posts are gated on a tool and the Smith
    // is the only source of one, so the tool line may never be halted out
    // of existence — it is bought back here instead of paid for by holding
    // a forge open against a shortage that has not happened.
    const {world, brain, swords, bows} = armory({
      [GoodId.bow]: 12,
      [GoodId.sword]: 12,
      [GoodId.axe]: 0,
    });
    world.players[0]!.techs.researched.push(TechId.ironworking);
    swords.paused = true;
    bows.paused = true;
    // A woodcutter standing open with no axe on the shelf and none coming.
    addResourceTile(world, 20, 21);
    addBuiltHut(world, 20, 20, false);

    const orders = beat(brain, world);
    const woken = orders.find(
      c => c.kind === CommandKind.setBuildingPaused && c.paused === false,
    );
    expect(woken).toBeDefined();
    const axe = BUILDING_DEFS[
      BuildingTypeId.weaponsmith
    ].recipeOptions!.findIndex(o => (o.recipe.outputs[GoodId.axe] ?? 0) > 0);
    expect(orders).toContainEqual({
      kind: CommandKind.enqueueForge,
      buildingId: (woken as {buildingId: number}).buildingId,
      recipeIndex: axe,
    });
  });

  it("gives a woken anvil one order, not two rules' worth", () => {
    // The overlap the wake path has to claim against: a pile under the
    // clear line is one `holdTheGlutForge` wants started too, and a post
    // standing open for a tool is one `keepTheToolsComing` wants started
    // for its own reason. Both are right; the anvil takes one order.
    const {world, brain, swords, bows} = armory({
      [GoodId.bow]: 2,
      [GoodId.sword]: 2,
      [GoodId.axe]: 0,
    });
    world.players[0]!.techs.researched.push(TechId.ironworking);
    swords.paused = true;
    bows.paused = true;
    addResourceTile(world, 20, 21);
    addBuiltHut(world, 20, 20, false);

    const opened = beat(brain, world)
      .filter(
        c => c.kind === CommandKind.setBuildingPaused && c.paused === false,
      )
      .map(c => (c as {buildingId: number}).buildingId);
    expect(opened).toEqual([...new Set(opened)]);
  });
});

describe('the seat that sees its seam running out', () => {
  /**
   * A village whose silver mine is nearly through its home seam, with a
   * second seam out past the far side of the valley. Everything the
   * printed build order would otherwise want is either already standing,
   * unaffordable on the shelf below, or anchored on ground this bare map
   * does not have — so the only foundation a beat can lay is the one under
   * test.
   */
  function minedOut(
    leftInReach: number,
    opts: {reserve?: boolean; successor?: boolean; rival?: boolean} = {},
  ): {world: World; brain: AiBrain; mine: Building} {
    const world = bareWorld(1, opts.rival ? 2 : 1);
    // Exactly one mine's worth of materials: enough for the successor,
    // not enough for the abbey the plan wants next.
    addStorehouse(world, 30, 30, {[GoodId.wood]: 8, [GoodId.stone]: 4});
    // A living rival whose castle stands over the reserve, so the seam is
    // its yard rather than this seat's (siting.ts rivalGround). After our
    // own: addStorehouse pads world.starts up to the owner it is given.
    if (opts.rival) addStorehouse(world, 30, 60, {}, 1);
    // The plan's cheap wants, already standing, so the build order has
    // nothing it can afford this beat and the reserve rule is what speaks.
    // The mill is on the list since the mines started eating: with the
    // bread chain ungated it is the next thing the plan reaches for, and
    // it costs exactly the mine's worth of materials below — so without it
    // the build order spends them and `ctx.placed` stands the rule down.
    for (const [type, x, y] of [
      [BuildingTypeId.house, 27, 30],
      [BuildingTypeId.well, 27, 33],
      [BuildingTypeId.wheatFarm, 24, 30],
      [BuildingTypeId.mill, 24, 34],
    ] as const) {
      placeBuiltBuilding(world, type, 0, x, y);
    }
    const mine = placeBuiltBuilding(
      world,
      BuildingTypeId.silverMine,
      0,
      36,
      30,
    );
    // What the mine can still reach, in one tile it can walk to.
    if (leftInReach > 0)
      addResourceTile(world, 38, 31, TileResource.SilverDep, leftInReach);
    // And the reserve, out of the mine's reach entirely.
    if (opts.reserve !== false) {
      for (let i = 0; i < 4; i++)
        addResourceTile(world, 30 + i, 55, TileResource.SilverDep, 30);
    }
    if (opts.successor) placeSite(world, BuildingTypeId.silverMine, 0, 31, 53);
    return {
      world,
      brain: new AiBrain(
        0,
        AI_STRATEGIES[AiStrategyId.steward],
        world.map.size,
      ),
      mine,
    };
  }

  function beat(brain: AiBrain, world: World): SimCommand[] {
    world.tick += AI_PACING.decisionInterval;
    return brain.shouldDecide(world.tick) ? brain.decide(world) : [];
  }

  /** The mines this beat ordered dug, as footprint origins. */
  function mineSites(commands: SimCommand[]): {x: number; y: number}[] {
    return commands
      .filter(
        c =>
          c.kind === CommandKind.placeBuilding &&
          c.building === BuildingTypeId.silverMine,
      )
      .map(c => ({x: (c as {x: number}).x, y: (c as {y: number}).y}));
  }

  it('opens the reserve seam before the working one is dug out', () => {
    // The complaint this answers: the silver simply stops. A seat that
    // waits for the last load spends the whole gap between the seams
    // unable to hire a hand or finish a tech — so it moves while the mine
    // it has is still producing.
    const {world, brain} = minedOut(10);
    const sites = mineSites(beat(brain, world));
    expect(sites.length).toBe(1);
    // At the reserve, not beside the mine that is running out: the site
    // has to be within a mine's reach (4) of the far seam.
    const [site] = sites as [{x: number; y: number}];
    expect(Math.abs(site.y - 55)).toBeLessThanOrEqual(5);
  });

  it('leaves a mine alone while its seam still holds ore', () => {
    const {world, brain} = minedOut(90);
    expect(mineSites(beat(brain, world))).toEqual([]);
  });

  it('digs nothing when the map has no second seam to dig', () => {
    // Nowhere to go is not a reason to spend a mine's materials on a hole
    // beside the one that is already empty.
    const {world, brain} = minedOut(10, {reserve: false});
    expect(mineSites(beat(brain, world))).toEqual([]);
  });

  it("leaves a seam in a living rival's yard alone, and digs it once the rival is gone", () => {
    // The only second seam on the map lies at a rival's door. A mine laid
    // there is a foundation for the rival's soldiers to raze and a road
    // for its haulers to die on (the seed-55973911 replay: forty-six of
    // them), so the seat holds its tired mine instead — until the rival's
    // castle falls, when the seam is nobody's and the successor goes up.
    const {world, brain} = minedOut(10, {rival: true});
    expect(mineSites(beat(brain, world))).toEqual([]);
    world.players[1]!.alive = false;
    const sites = mineSites(beat(brain, world));
    expect(sites.length).toBe(1);
    expect(Math.abs(sites[0]!.y - 55)).toBeLessThanOrEqual(5);
  });

  it('lays one successor, not one a beat while it goes up', () => {
    const {world, brain} = minedOut(10, {successor: true});
    expect(mineSites(beat(brain, world))).toEqual([]);
  });

  it('waits for the materials rather than ordering a hole it cannot pay for', () => {
    const {world, brain} = minedOut(10);
    const store = [...world.buildings.values()].find(
      b => b.type === BuildingTypeId.storehouse,
    )!;
    store.stock = {...store.stock, [GoodId.stone]: 0};
    expect(mineSites(beat(brain, world))).toEqual([]);
  });
});

/**
 * Which side of the village a tower goes up on. The complaint (a played
 * four-seat game, seed 96655595): the seat in the middle of the valley put
 * both its towers eight tiles due NORTH of its castle, with one rival to
 * the south and two to the east — the spiral hands back the first legal
 * tile it reads, and it reads each ring from the north-west corner, so the
 * side was whichever one happened to have a gap in it.
 */
describe('the tower that faces the war', () => {
  /**
   * A village with exactly one thing left to build: a tower, on a shelf
   * holding exactly one tower's worth of stone and wood. The printed
   * playbook is overridden down to that one step, so nothing else can win
   * the beat and the site under test is the only one ordered.
   */
  function watchtower(rival?: {x: number; y: number}): {
    world: World;
    brain: AiBrain;
  } {
    const world = bareWorld(1, rival ? 2 : 1);
    addStorehouse(world, 30, 30, {[GoodId.wood]: 6, [GoodId.stone]: 12});
    if (rival) addStorehouse(world, rival.x, rival.y, {}, 1);
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    brain.setOverride({
      build: [
        {
          type: BuildingTypeId.guardTower,
          count: 1,
          anchor: BuildAnchor.base,
        },
      ],
    });
    return {world, brain};
  }

  function beat(brain: AiBrain, world: World): SimCommand[] {
    world.tick += AI_PACING.decisionInterval;
    return brain.shouldDecide(world.tick) ? brain.decide(world) : [];
  }

  /** The tower this beat ordered, as its footprint's middle. */
  function towerAt(commands: SimCommand[]): {x: number; y: number} {
    const site = commands.find(
      c =>
        c.kind === CommandKind.placeBuilding &&
        c.building === BuildingTypeId.guardTower,
    );
    expect(site).toBeDefined();
    const {x, y} = site as {x: number; y: number};
    return {x: x + 1, y: y + 1};
  }

  it("stands between the castle and the rival's corner", () => {
    // Nobody has scouted anything here: the dealt plateaus are public
    // (siting.ts nearestRivalStart, the same table the build order reads
    // to decide whose ground a seam is), so a blind seat still knows
    // which way the neighbours live.
    const east = watchtower({x: 60, y: 30});
    expect(towerAt(beat(east.brain, east.world)).x).toBeGreaterThan(31);
    const north = watchtower({x: 30, y: 5});
    expect(towerAt(beat(north.brain, north.world)).y).toBeLessThan(31);
  });

  it('faces a camp it has found over a corner it has only been dealt', () => {
    // The rival's plateau lies east and unvisited; the camp stands west
    // with a man of ours beside it. Raids come out of both, and the one
    // this seat has actually laid eyes on is the one it can measure.
    const {world, brain} = watchtower({x: 60, y: 30});
    placeBuiltBuilding(world, BuildingTypeId.banditCamp, BANDIT, 8, 30);
    spawnUnit(world, UnitTypeId.serf, 0, 12.5, 31.5);
    expect(towerAt(beat(brain, world)).x).toBeLessThan(31);
  });

  it('sites by nearness alone in a valley with nothing in it', () => {
    // No rival, no camp, nothing found: the old answer, unchanged — a
    // seat with no side to face does not invent one.
    const {world, brain} = watchtower();
    const plain = findSpot(world, BuildingTypeId.guardTower, 31, 31)!;
    expect(towerAt(beat(brain, world))).toEqual({
      x: plain.x + 1,
      y: plain.y + 1,
    });
  });
});

describe('the road to a far post', () => {
  /**
   * A village with its abbey up, a full shelf, and one post — near the
   * castle or out in the country, which is the whole question.
   */
  function withPost(
    far: boolean,
    techs: TechId[] = [],
    shelf: GoodAmounts = {},
  ): {world: World; brain: AiBrain} {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {
      [GoodId.wheat]: 10,
      [GoodId.stone]: 10,
      [GoodId.wood]: 10,
      [GoodId.silver]: 20,
      ...shelf,
    });
    placeBuiltBuilding(world, BuildingTypeId.abbey, 0, 27, 27);
    // Twenty-four tiles of road — the reserve seam's kind of distance —
    // or three, the larder's.
    addBuiltHut(world, far ? 54 : 33, 30, false);
    world.players[0]!.techs.researched.push(...techs);
    return {
      world,
      brain: new AiBrain(
        0,
        AI_STRATEGIES[AiStrategyId.steward],
        world.map.size,
      ),
    };
  }

  function researchOrdered(brain: AiBrain, world: World): TechId | undefined {
    world.tick += AI_PACING.decisionInterval;
    const commands = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
    for (const c of commands)
      if (c.kind === CommandKind.research) return c.tech;
    return undefined;
  }

  it('sends for the boots first while a post is out in the country', () => {
    // The reserve seam is twenty tiles of walking each way, and at that
    // length the cheapest thing on the board is a shorter walk. The
    // printed line opens on Soldiery; the road outranks it.
    const {world, brain} = withPost(true);
    expect(researchOrdered(brain, world)).toBe(TechId.cobbledBoots);
  });

  it('keeps to the printed line when every post is at the door', () => {
    const {world, brain} = withPost(false);
    expect(researchOrdered(brain, world)).toBe(TechId.soldiery);
  });

  it('paves the long road once the boots are in', () => {
    // Masonry is in no playbook but the abbot's, and last there — paving
    // is a comfort on a short road. On a long one it is 35% off every
    // load, aimed by the traffic itself.
    const {world, brain} = withPost(true, [TechId.cobbledBoots]);
    expect(researchOrdered(brain, world)).toBe(TechId.masonry);
  });

  it('leaves the paving alone on a village that walks nowhere', () => {
    const {world, brain} = withPost(false, [TechId.cobbledBoots]);
    expect(researchOrdered(brain, world)).toBe(TechId.soldiery);
  });

  it('lets the plan run rather than waiting on stone it has not got', () => {
    // The queue's own rule is to name a tech and then wait until it can
    // afford that one. The road does not get that: it is an optimization,
    // and a seat sitting on an empty quarry while Ironworking waits for a
    // tech its playbook never asked for is a plan held hostage.
    const {world, brain} = withPost(true, [TechId.cobbledBoots], {
      [GoodId.stone]: 0,
    });
    expect(researchOrdered(brain, world)).toBe(TechId.soldiery);
  });

  it('returns to the plan once the road techs are in', () => {
    const {world, brain} = withPost(true, [
      TechId.cobbledBoots,
      TechId.masonry,
    ]);
    expect(researchOrdered(brain, world)).toBe(TechId.soldiery);
  });
});
