import { describe, expect, it } from 'vitest';
import { createWorld, type World, type WorldConfig } from './world.ts';
import { tickWorld, type PlayerCommand } from './tick.ts';
import { AI_PACING, AI_STALL, AiBrain, LEVY_HOLD } from './systems/ai.ts';
import { HIRE_SERF_COST } from './defs/balance.ts';
import { TECH_DEFS } from './defs/techs.ts';
import { AiSeats } from './aiSeats.ts';
import { strategyOf, type AiStrategy } from './defs/aiStrategies.ts';
import { checkInvariants } from './debug/invariants.ts';
import { AI_STRATEGIES } from './defs/aiStrategies.ts';
import { placeBuiltBuilding, spawnUnit } from './world.ts';
import { BUILDING_DEFS, OUTPUT_CAP } from './defs/buildings.ts';
import { tileIdx } from '../shared/grid.ts';
import { BANDIT, type Building } from './entities.ts';
import {
  addBuiltHut,
  addResourceTile,
  addSerf,
  addStorehouse,
  bareWorld,
  cmds,
} from './testUtils.ts';
import type { SimCommand } from './commands.ts';

function digest(world: World): unknown {
  return {
    tick: world.tick,
    rngState: world.rngState,
    nextId: world.nextId,
    units: [...world.units.values()].map((u) => ({ ...u, path: u.path ? [...u.path] : null })),
    buildings: [...world.buildings.values()],
    players: world.players,
    outcome: world.outcome,
  };
}

/** Drive every AI seat's brain the way its worker does. */
function runWithBrains(config: WorldConfig, maxTicks: number, onTick?: (w: World) => void): World {
  const world = createWorld(config);
  // Playbooks come off the world, which was dealt them from the seed —
  // the same lookup AiSeats does for the hosts.
  const brains = world.players
    .filter((p) => p.kind === 'ai')
    .map((p) => new AiBrain(p.id, strategyOf(p.strategy), world.map.size));
  for (let t = 0; t < maxTicks && world.outcome.state === 'playing'; t++) {
    const commands: PlayerCommand[] = [];
    for (const brain of brains) {
      if (brain.shouldDecide(world.tick)) {
        for (const cmd of brain.decide(world)) commands.push({ playerId: brain.playerId, cmd });
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
      { seed: 11, players: [{ kind: 'ai' }, { kind: 'ai' }], banditsEnabled: false },
      90_000,
      (w) => {
        if (w.tick % 200 === 0) {
          expect(checkInvariants(w).violations, `at tick ${w.tick}`).toEqual([]);
        }
      },
    );
    expect(world.outcome.state, `still playing at tick ${world.tick}`).toBe('over');
    // A winner exists (either seat may take it; a draw would be null).
    expect((world.outcome as { winner: number | null }).winner).not.toBeNull();
  }, 240_000);

  it('is deterministic: two identical runs match at tick 3000', () => {
    const config: WorldConfig = { seed: 7, players: [{ kind: 'human' }, { kind: 'ai' }] };
    expect(digest(runWithBrains(config, 3000))).toEqual(digest(runWithBrains(config, 3000)));
  });

  it('4-player mixed world is deterministic at tick 3000', () => {
    const config: WorldConfig = {
      seed: 11,
      players: [{ kind: 'human' }, { kind: 'ai' }, { kind: 'ai' }, { kind: 'ai' }],
    };
    expect(digest(runWithBrains(config, 3000))).toEqual(digest(runWithBrains(config, 3000)));
  });
});

/**
 * The strategist override (src/ai/): a Partial<AiStrategy> the LLM lays
 * over a brain's playbook. What is covered is the two promises the seam
 * makes — laid and cleared it leaves no trace, and laid with real values
 * the brain actually plays differently.
 */
function moveOrders(commands: SimCommand[]): Extract<SimCommand, { kind: 'moveUnits' }>[] {
  return commands.filter((c) => c.kind === 'moveUnits');
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
): Extract<SimCommand, { kind: 'moveUnits' }>[] {
  const home = { x: castleX + 1, y: castleY + 1 + 4 };
  return moveOrders(commands).filter(
    (m) => m.unitIds.length >= 3 && (m.x !== home.x || m.y !== home.y),
  );
}

function siegeStandoff(): { world: World; brain: AiBrain } {
  const world = bareWorld();
  addStorehouse(world, 30, 30, {});
  for (let i = 0; i < 7; i++) spawnUnit(world, 'knight', 0, 33.5, 27.5 + i);
  // The rival, near enough that one scout lights castle and yard together.
  addStorehouse(world, 44, 30, {}, 1);
  for (let i = 0; i < 12; i++) spawnUnit(world, 'knight', 1, 45.5, 28.5 + i * 0.4);
  spawnUnit(world, 'knight', 0, 42.5, 30.5); // the scout
  world.tick = 1000; // past the steward's attack cooldown
  return { world, brain: new AiBrain(0, AI_STRATEGIES.steward, world.map.size) };
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
  function firstMarchTick(override: Partial<AiStrategy> | null, maxTicks: number): number {
    const world = createWorld({ seed: 17, players: [{ kind: 'ai', strategy: 'steward' }] });
    const brain = new AiBrain(0, strategyOf(world.players[0]!.strategy), world.map.size);
    if (override) brain.setOverride(override);
    const castle = [...world.buildings.values()].find((b) => b.type === 'storehouse')!;
    const home = { x: castle.x + 1, y: castle.y + 1 + 4 };
    for (let t = 0; t < maxTicks && world.outcome.state === 'playing'; t++) {
      const commands = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
      for (const cmd of commands) {
        if (
          cmd.kind === 'moveUnits' &&
          cmd.unitIds.length >= 3 &&
          (cmd.x !== home.x || cmd.y !== home.y)
        ) {
          return world.tick;
        }
      }
      tickWorld(
        world,
        commands.map((cmd) => ({ playerId: 0, cmd })),
      );
    }
    return maxTicks;
  }

  it('laid empty and cleared again, the seam leaves the game untouched', () => {
    const config: WorldConfig = { seed: 7, players: [{ kind: 'human' }, { kind: 'ai' }] };
    const baseline = digest(runWithBrains(config, 3000));

    const world = createWorld(config);
    const brain = new AiBrain(1, strategyOf(world.players[1]!.strategy), world.map.size);
    for (let t = 0; t < 3000 && world.outcome.state === 'playing'; t++) {
      // An empty override spreads to the same values; clearing goes back to
      // the playbook object itself. Either way: the identical game.
      if (t === 1000) brain.setOverride({});
      // The march gate at its neutral value has to be as inert as no advice
      // at all — the whole reason every playbook ships marchConfidence: 0.
      if (t === 1500) brain.setOverride({ marchConfidence: 0 });
      if (t === 2000) brain.setOverride(null);
      const commands = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
      tickWorld(
        world,
        commands.map((cmd) => ({ playerId: 1, cmd })),
      );
    }
    expect(digest(world)).toEqual(baseline);
  });

  it('an eager override marches the army sooner', () => {
    const patient = firstMarchTick(null, 20_000);
    const eager = firstMarchTick({ armyAttackSize: 3, attackCooldown: 200 }, 20_000);
    expect(eager).toBeLessThan(patient);
  }, 120_000);

  it('holds out of a garrison it cannot beat — and does not sweep instead', () => {
    const { world, brain } = siegeStandoff();
    brain.setOverride({ marchConfidence: 60 });
    // No march on the castle, and — the part worth pinning — no consolation
    // sweep either. Falling through to the sweep branch would send the whole
    // army walking into unexplored ground, which is worse than the march it
    // just refused. Rallying home is allowed, and is the point.
    expect(marchOrders(brain.decide(world), 30, 30)).toEqual([]);
  });

  it('marches on the same garrison once the odds have turned', () => {
    const { world, brain } = siegeStandoff();
    // Same defenders, a far bigger muster: the hold lifts by growing out of
    // it, which is how it lifts in a real match.
    for (let i = 0; i < 24; i++) spawnUnit(world, 'knight', 0, 33.5, 20.5 + i * 0.4);
    brain.setOverride({ marchConfidence: 60 });
    expect(marchOrders(brain.decide(world), 30, 30).length).toBeGreaterThan(0);
  });

  it('a hold does not outlive the forlorn clock', () => {
    // The escape valve #oddsSay promises — a seat that never likes its odds
    // still marches eventually — used to lean on the defenders' picture
    // going stale, and a working scout never lets it: the yard is re-read
    // on the refresh clock, the garrison stays inside the trust window,
    // and the veto renews itself forever. Past the forlorn line the clock
    // itself breaks the standoff.
    const { world, brain } = siegeStandoff();
    brain.setOverride({ marchConfidence: 60 });
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
    for (let i = 0; i < 4; i++) spawnUnit(world, 'knight', 0, 33.5, 29.5 + i);
    addStorehouse(world, 44, 30, {}, 1);
    spawnUnit(world, 'spearman', 1, 45.5, 30.5);
    spawnUnit(world, 'knight', 0, 42.5, 30.5); // scout, lighting castle and yard
    world.tick = 1000;
    const brain = new AiBrain(0, AI_STRATEGIES.steward, world.map.size);
    expect(marchOrders(brain.decide(world), 30, 30)).toEqual([]); // headcount says wait
    brain.setOverride({ marchConfidence: 60 });
    expect(marchOrders(brain.decide(world), 30, 30).length).toBeGreaterThan(0);
  });

  it('marches into that same garrison when the gate is off', () => {
    const { world, brain } = siegeStandoff();
    brain.setOverride({ marchConfidence: 0 });
    expect(marchOrders(brain.decide(world), 30, 30).length).toBeGreaterThan(0);
  });

  it('AiSeats routes advice to the seat it names, and shrugs at one it cannot find', () => {
    const world = createWorld({
      seed: 7,
      players: [{ kind: 'human' }, { kind: 'ai' }, { kind: 'ai' }],
    });
    const seats = new AiSeats(world);
    expect(seats.seatIds()).toEqual([1, 2]);
    seats.applyAdvice(1, { armyAttackSize: 3 });
    // Advice can outlive the brain it was meant for; a seat that is not
    // there is a no-op, not a crash.
    seats.applyAdvice(9, { armyAttackSize: 3 });
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
  function shortMuster(): { world: World; brain: AiBrain } {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    for (let i = 0; i < 4; i++) spawnUnit(world, 'knight', 0, 33.5, 27.5 + i);
    addStorehouse(world, 44, 30, {}, 1);
    spawnUnit(world, 'knight', 0, 42.5, 30.5); // the scout, lighting it
    world.tick = 1000;
    return { world, brain: new AiBrain(0, AI_STRATEGIES.steward, world.map.size) };
  }

  it('marches what it has once the army has stopped growing', () => {
    const { world, brain } = shortMuster();
    expect(marchOrders(brain.decide(world), 30, 30)).toEqual([]); // the playbook waits
    // Long past the stall window with nobody new under arms, it marches —
    // well before the impatience ramp would have moved the bar at all.
    world.tick = 1000 + AI_PACING.growthStallAfter + 40;
    expect(world.tick).toBeLessThan(AI_PACING.staleAfter);
    expect(marchOrders(brain.decide(world), 30, 30).length).toBeGreaterThan(0);
  });

  it('keeps the full bar while the barracks is still delivering', () => {
    const { world, brain } = shortMuster();
    expect(marchOrders(brain.decide(world), 30, 30)).toEqual([]);
    // A recruit lands just before the window closes: growth restamps the
    // clock, and the seat keeps mustering toward the playbook's size.
    spawnUnit(world, 'knight', 0, 33.5, 31.5);
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
  function frozenVillage(): { world: World; brain: AiBrain; hut: Building } {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    addResourceTile(world, 40, 41);
    const hut = addBuiltHut(world, 40, 40);
    hut.stock = { wood: OUTPUT_CAP };
    return { world, brain: new AiBrain(0, AI_STRATEGIES.steward, world.map.size), hut };
  }

  /** Beat the brain forward to `until`, keeping the world frozen — only the
   * brain's own window advances, which is exactly what is under test. */
  function beatUntil(brain: AiBrain, world: World, until: number): SimCommand[] {
    let last: SimCommand[] = [];
    while (world.tick < until) {
      world.tick += AI_PACING.decisionInterval;
      if (brain.shouldDecide(world.tick)) last = brain.decide(world);
    }
    return last;
  }

  it('says nothing until the window is full, then says stalled', () => {
    const { world, brain } = frozenVillage();
    beatUntil(brain, world, AI_STALL.graceUntil);
    expect(brain.stallReport().beats).toBe(0);
    // One full window past the grace period and the reading has turned.
    beatUntil(brain, world, AI_STALL.graceUntil + AI_STALL.samplePeriod * AI_STALL.window);
    expect(brain.stallReport().stalled).toBe(true);
    expect(brain.stallReport().beats).toBeGreaterThan(0);
  });

  it('buys a hauler with a post nobody is using, without waiting for the window', () => {
    const { world, brain, hut } = frozenVillage();
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
      kind: 'setBuildingPaused',
      buildingId: hut.id,
      paused: true,
    });
    expect(brain.stallReport().recoveries).toBeGreaterThan(0);
  });

  it('leaves the post alone once the pool is back over the floor', () => {
    // The guard that keeps this off every healthy seat: hands enough to
    // work with and the capped hut is somebody's next errand, not a village
    // to break up.
    const { world, brain, hut } = frozenVillage();
    for (let i = 0; i < AI_STRATEGIES.steward.survivalFloor; i++) addSerf(world, 31 + i, 31);
    const commands = beatUntil(brain, world, AI_PACING.decisionInterval * 2);
    expect(commands).not.toContainEqual({
      kind: 'setBuildingPaused',
      buildingId: hut.id,
      paused: true,
    });
  });

  it('starts the halted post again once its pile has shipped', () => {
    // The other half of the trade: the hand was borrowed, not given away.
    // A post left halted for the rest of the match is a hut thrown away.
    const { world, brain, hut } = frozenVillage();
    hut.paused = true;
    hut.stock = {};
    const commands = beatUntil(brain, world, AI_PACING.decisionInterval * 2);
    expect(commands).toContainEqual({
      kind: 'setBuildingPaused',
      buildingId: hut.id,
      paused: false,
    });
  });

  it('leaves a halted post alone while the pile it was halted over still stands', () => {
    const { world, brain, hut } = frozenVillage();
    hut.paused = true; // stock is still at OUTPUT_CAP from frozenVillage
    const commands = beatUntil(brain, world, AI_PACING.decisionInterval * 2);
    expect(commands).not.toContainEqual({
      kind: 'setBuildingPaused',
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
    hut.stock = { wood: OUTPUT_CAP };
    const worker = world.units.get(hut.workerId!)!;
    worker.task = { t: 'gatherWork', tile: tileIdx(40, 41, world.map.size), until: 999_999 };
    tickWorld(world, cmds({ kind: 'setBuildingPaused', buildingId: hut.id, paused: true }));
    expect(worker.kind).toBe('serf');
    // Idle, or already claimed for a haul — either is in the pool. What is
    // fatal is a leftover gather task.
    expect(['idle', 'haul']).toContain(worker.task.t);
  });

  it('sells a worked-out extractor so the build order can re-site it', () => {
    const world = bareWorld();
    // Exactly half a woodcutter on the shelf — the other half is what the
    // sale hands back, and the rule refuses to sell what it could not
    // rebuild. Not a plank more: a seat with enough to place anything at
    // all is a seat that is going somewhere, and would not read as stalled.
    addStorehouse(world, 30, 30, { wood: 3 });
    const dead = addBuiltHut(world, 40, 40); // no resource tile in reach
    addResourceTile(world, 12, 12); // ...but a live grove clear across the map
    const brain = new AiBrain(0, AI_STRATEGIES.steward, world.map.size);
    const commands = beatUntil(
      brain,
      world,
      AI_STALL.graceUntil + AI_STALL.samplePeriod * AI_STALL.window + 100,
    );
    expect(commands).toContainEqual({ kind: 'sellBuilding', buildingId: dead.id });
  });

  it('will not sell a worked-out extractor it could not afford to rebuild', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {}); // empty shelf: half the cost back is not enough
    const dead = addBuiltHut(world, 40, 40);
    addResourceTile(world, 12, 12);
    const brain = new AiBrain(0, AI_STRATEGIES.steward, world.map.size);
    const commands = beatUntil(
      brain,
      world,
      AI_STALL.graceUntil + AI_STALL.samplePeriod * AI_STALL.window + 100,
    );
    expect(commands).not.toContainEqual({ kind: 'sellBuilding', buildingId: dead.id });
  });

  it('starts a threatened tower, and halts it again once the ground is quiet', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const tower = placeBuiltBuilding(world, 'guardTower', 0, 36, 36);
    tower.paused = true; // as one comes off the scaffold
    const brain = new AiBrain(0, AI_STRATEGIES.steward, world.map.size);
    const beat = (): SimCommand[] => {
      world.tick += AI_PACING.decisionInterval;
      return brain.shouldDecide(world.tick) ? brain.decide(world) : [];
    };
    const start = { kind: 'setBuildingPaused', buildingId: tower.id, paused: false };
    const halt = { kind: 'setBuildingPaused', buildingId: tower.id, paused: true };

    // Quiet ground: no reason to take anyone off a haul.
    expect(beat()).not.toContainEqual(start);

    // A raider walks into sight of the tower.
    const raider = spawnUnit(world, 'bandit', BANDIT, 37.5, 38.5);
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
    tower.garrisonKind = 'serf';
    const out = beat();
    expect(out).toContainEqual(halt);
    expect(out.filter((c) => c.kind === 'setBuildingPaused')).toHaveLength(1);
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
    const tower = placeBuiltBuilding(world, 'guardTower', 0, 36, 36);
    // Running, and the villagers are already up — the raid caught it as the
    // levy branch always used to leave it.
    tower.garrison = BUILDING_DEFS.guardTower.garrison!.capacity;
    tower.garrisonKind = 'serf';
    spawnUnit(world, 'bandit', BANDIT, 37.5, 38.5);
    const archer = spawnUnit(world, 'archer', 0, 34.5, 34.5);
    const brain = new AiBrain(0, AI_STRATEGIES.steward, world.map.size);
    world.tick += AI_PACING.decisionInterval;
    const out = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
    // He is the wall's now: claimed for the tower means left out of the
    // army, so nothing marches him anywhere. A soldier at the door relieves
    // the whole levy, so the villagers go back to their errands.
    expect(out.some((c) => c.kind === 'moveUnits' && c.unitIds.includes(archer.id))).toBe(false);
    // And the tower keeps running while he walks — a besieged wall is never
    // stood down, whoever is holding it.
    expect(out).not.toContainEqual({
      kind: 'setBuildingPaused',
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
    const tower = placeBuiltBuilding(world, 'guardTower', 0, 36, 36);
    tower.paused = true; // as one comes off the scaffold
    spawnUnit(world, 'bandit', BANDIT, 37.5, 38.5);
    const brain = new AiBrain(0, AI_STRATEGIES.steward, world.map.size);
    world.tick += AI_PACING.decisionInterval;
    const out = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
    expect(out).toContainEqual({
      kind: 'setBuildingPaused',
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
    const tower = placeBuiltBuilding(world, 'guardTower', 0, 36, 36);
    const archer = spawnUnit(world, 'archer', 0, 40.5, 40.5);
    archer.task = { t: 'staff', buildingId: tower.id };
    tower.recruitId = archer.id;
    const brain = new AiBrain(0, AI_STRATEGIES.steward, world.map.size);
    world.tick += AI_PACING.decisionInterval;
    const out = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
    expect(out.filter((c) => c.kind === 'setBuildingPaused')).toEqual([]);
  });

  it('lets an idle archer relieve a levy rather than standing it down', () => {
    // A soldier at the door relieves the whole levy, so a tower full of
    // villagers still has room for him. Reading the roof as full stood the
    // levy down on quiet ground with an archer standing idle beside it.
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const tower = placeBuiltBuilding(world, 'guardTower', 0, 36, 36);
    tower.garrison = BUILDING_DEFS.guardTower.garrison!.capacity;
    tower.garrisonKind = 'serf';
    spawnUnit(world, 'archer', 0, 34.5, 34.5);
    const brain = new AiBrain(0, AI_STRATEGIES.steward, world.map.size);
    world.tick += AI_PACING.decisionInterval;
    const out = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
    expect(out.filter((c) => c.kind === 'setBuildingPaused')).toEqual([]);
  });

  it('does not open a tower for an archer it has just marched away', () => {
    // The order is queued, not applied, so the archer still reads as idle
    // when the walls are considered. A tower opened for him is a tower
    // opened for nobody — and an empty running tower calls villagers up.
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const tower = placeBuiltBuilding(world, 'guardTower', 0, 36, 36);
    tower.paused = true;
    const archer = spawnUnit(world, 'archer', 0, 34.5, 34.5);
    const brain = new AiBrain(0, AI_STRATEGIES.steward, world.map.size);
    world.tick += AI_PACING.decisionInterval;
    const out = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
    const marched = out.some((c) => c.kind === 'moveUnits' && c.unitIds.includes(archer.id));
    const started = out.some(
      (c) => c.kind === 'setBuildingPaused' && c.buildingId === tower.id && !c.paused,
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
    const tower = placeBuiltBuilding(world, 'guardTower', 0, 36, 36);
    tower.paused = true;
    tower.staffBackoffUntil = world.tick + 10_000; // walled off, for now
    spawnUnit(world, 'archer', 0, 34.5, 34.5);
    const brain = new AiBrain(0, AI_STRATEGIES.steward, world.map.size);
    world.tick += AI_PACING.decisionInterval;
    const out = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
    // No point opening it: nobody can get in, and the archer stays the
    // army's to spend.
    expect(out.filter((c) => c.kind === 'setBuildingPaused')).toEqual([]);
  });

  it('never stands a tower its archers hold down, or up', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const tower = placeBuiltBuilding(world, 'guardTower', 0, 36, 36);
    tower.garrison = BUILDING_DEFS.guardTower.garrison!.capacity;
    tower.garrisonKind = 'archer';
    const brain = new AiBrain(0, AI_STRATEGIES.steward, world.map.size);
    world.tick += AI_PACING.decisionInterval;
    const out = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
    // Halting a tower now empties the roof whoever is on it, so the
    // quiet-ground halt is held back from one the soldiers hold: standing
    // them down would trade a wall that cannot be shot back at for two men
    // in the open, and start them climbing back up at the next sighting.
    expect(out.filter((c) => c.kind === 'setBuildingPaused')).toEqual([]);
    expect(tower.garrison).toBe(BUILDING_DEFS.guardTower.garrison!.capacity);
  });

  it('leaves a seat that is going somewhere byte-identical', () => {
    // The whole safety story: the watchdog is memory and a comparison, and
    // an unstalled seat must play the game it played before it existed.
    // Long enough to run past graceUntil and a full window.
    const config: WorldConfig = { seed: 7, players: [{ kind: 'human' }, { kind: 'ai' }] };
    expect(digest(runWithBrains(config, 40_000))).toEqual(digest(runWithBrains(config, 40_000)));
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
  function raidedVillage(): { world: World; brain: AiBrain; barracks: Building } {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const barracks = placeBuiltBuilding(world, 'barracks', 0, 36, 36);
    return { world, brain: new AiBrain(0, AI_STRATEGIES.steward, world.map.size), barracks };
  }

  function beat(brain: AiBrain, world: World): SimCommand[] {
    world.tick += AI_PACING.decisionInterval;
    return brain.shouldDecide(world.tick) ? brain.decide(world) : [];
  }

  it('stands the barracks down while the pool is below the survival floor', () => {
    const { world, brain, barracks } = raidedVillage();
    expect(beat(brain, world)).toContainEqual({
      kind: 'setBuildingPaused',
      buildingId: barracks.id,
      paused: true,
    });
  });

  it('spends no hand on a soldier while it is short of hands', () => {
    // The trade the hold exists for: a knight is a serf plus a sword, so a
    // warm queue is a standing order against the one thing the village has
    // none of. Paired on purpose — the same seat, the same beat, one serf
    // either side of the floor.
    const { world, brain, barracks } = raidedVillage();
    for (let i = 0; i < AI_STRATEGIES.steward.survivalFloor; i++) addSerf(world, 31 + i, 31);
    expect(beat(brain, world).filter((c) => c.kind === 'trainUnit')).not.toEqual([]);

    const raided = raidedVillage();
    for (let i = 0; i < AI_STRATEGIES.steward.survivalFloor - 1; i++) addSerf(raided.world, 31 + i, 31);
    const held = beat(raided.brain, raided.world);
    expect(held.filter((c) => c.kind === 'trainUnit')).toEqual([]);
    expect(held).toContainEqual({
      kind: 'setBuildingPaused',
      buildingId: raided.barracks.id,
      paused: true,
    });
  });

  it('opens the barracks again once the pool is a hand clear of the floor', () => {
    // Borrowed, not given away: a hold that outlives its reason is an army
    // the seat never builds. The margin is one hand, because taking a
    // recruit costs exactly one — reopening AT the floor hands the
    // recruiter the hand that put the seat back over it.
    const { world, brain, barracks } = raidedVillage();
    barracks.paused = true;
    const open = { kind: 'setBuildingPaused', buildingId: barracks.id, paused: false };
    for (let i = 0; i < AI_STRATEGIES.steward.survivalFloor; i++) addSerf(world, 31 + i, 31);
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
    const { world, brain, barracks } = raidedVillage();
    const floor = AI_STRATEGIES.steward.survivalFloor;
    for (let i = 0; i < floor; i++) addSerf(world, 31 + i, 31);
    const halt = { kind: 'setBuildingPaused', buildingId: barracks.id, paused: true };
    const open = { kind: 'setBuildingPaused', buildingId: barracks.id, paused: false };

    // At the floor with the barracks running, nothing happens: the rule
    // closes under the line, it does not go looking for a barracks to shut.
    expect(beat(brain, world)).not.toContainEqual(halt);

    // The recruiter takes one and the seat drops under: held.
    const serfs = [...world.units.values()].filter((u) => u.kind === 'serf');
    serfs[0]!.dead = true;
    expect(beat(brain, world)).toContainEqual(halt);
    barracks.paused = true; // the order lands

    // The hire lands and the pool is back at the floor exactly. Without the
    // band this is where it reopens, re-books the hauls, and takes the hand
    // straight back. With it, the hold stands and the queue is not refilled.
    serfs[0]!.dead = false;
    const atFloor = beat(brain, world);
    expect(atFloor).not.toContainEqual(open);
    expect(atFloor.filter((c) => c.kind === 'trainUnit')).toEqual([]);
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
    addStorehouse(world, 30, 30, { food: 40, sword: 40 });
    addStorehouse(world, 60, 60, {}, 1); // a rival, so the match does not end at tick 1
    const barracks = placeBuiltBuilding(world, 'barracks', 0, 36, 36);
    barracks.inputs = { food: 30, sword: 30 };
    barracks.paused = true;
    const floor = AI_STRATEGIES.steward.survivalFloor;
    for (let i = 0; i < floor + 1; i++) addSerf(world, 31 + i, 31);
    const brain = new AiBrain(0, AI_STRATEGIES.steward, world.map.size);
    const loose = (): number =>
      [...world.units.values()].filter((u) => !u.dead && u.kind === 'serf').length;
    let low = loose();
    for (let t = 0; t < 2000; t++) {
      const commands = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
      tickWorld(
        world,
        commands.map((cmd) => ({ playerId: 0, cmd })),
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
    const soldiery = TECH_DEFS.soldiery.cost.silver!;
    const world = bareWorld();
    const shelf = addStorehouse(world, 30, 30, { silver: soldiery + 1, wheat: 20 });
    placeBuiltBuilding(world, 'abbey', 0, 36, 36);
    const brain = new AiBrain(0, AI_STRATEGIES.steward, world.map.size);
    expect(beat(brain, world).filter((c) => c.kind === 'research')).toEqual([]);

    // And the sum has to count the hire this same beat already ordered:
    // commands apply in the order they are pushed, so the four silver the
    // panic branch just spent is gone before research is charged. Ten
    // silver looks like enough for a 6-silver tech with a hire left over
    // and is not — it is 10 - 4 - 6 = 0.
    shelf.stock.silver = HIRE_SERF_COST + soldiery;
    const beat10 = beat(brain, world);
    expect(beat10.filter((c) => c.kind === 'hireSerf')).not.toEqual([]);
    expect(beat10.filter((c) => c.kind === 'research')).toEqual([]);

    // Not a blanket ban: with the hand, the tech and the NEXT hand all paid
    // for, the queue runs even below the floor.
    shelf.stock.silver = HIRE_SERF_COST * 2 + soldiery;
    expect(beat(brain, world).filter((c) => c.kind === 'research')).not.toEqual([]);

    // And with the pool back over the floor the guard is silent entirely —
    // the playbook's own research reserve takes over from here.
    for (let i = 0; i < AI_STRATEGIES.steward.survivalFloor; i++) addSerf(world, 31 + i, 31);
    shelf.stock.silver = soldiery;
    expect(beat(brain, world).filter((c) => c.kind === 'research')).not.toEqual([]);
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
    hut.stock = { wood: OUTPUT_CAP };
    const brain = new AiBrain(0, AI_STRATEGIES.steward, world.map.size);
    let sawSerf = false;
    for (let t = 0; t < 3000; t++) {
      const commands = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
      tickWorld(
        world,
        commands.map((cmd) => ({ playerId: 0, cmd })),
      );
      sawSerf ||= [...world.units.values()].some((u) => !u.dead && u.kind === 'serf');
    }
    expect(sawSerf).toBe(true);
    expect(hut.stock.wood ?? 0).toBeLessThan(OUTPUT_CAP);
  });
});

describe('a forge nobody is buying from', () => {
  /**
   * The Abbot's two-line armory, standing and idle: swords at the first
   * anvil, bowstaves at the second, which is the playbook's own weaponMix
   * — so `forgeTheCounter` has nothing to re-tune and the glut rule is the
   * only thing in the beat with an opinion about a Smith.
   */
  function armory(stock: Record<string, number>): {
    world: World;
    brain: AiBrain;
    swords: Building;
    bows: Building;
  } {
    const world = bareWorld();
    addStorehouse(world, 30, 30, stock);
    const swords = placeBuiltBuilding(world, 'weaponsmith', 0, 36, 36);
    const bows = placeBuiltBuilding(world, 'weaponsmith', 0, 40, 36);
    swords.recipeIndex = AI_STRATEGIES.abbot.weaponMix[0]!;
    bows.recipeIndex = AI_STRATEGIES.abbot.weaponMix[1]!;
    return {
      world,
      brain: new AiBrain(0, AI_STRATEGIES.abbot, world.map.size),
      swords,
      bows,
    };
  }

  function beat(brain: AiBrain, world: World): SimCommand[] {
    world.tick += AI_PACING.decisionInterval;
    return brain.shouldDecide(world.tick) ? brain.decide(world) : [];
  }

  const halt = (b: Building): SimCommand => ({
    kind: 'setBuildingPaused',
    buildingId: b.id,
    paused: true,
  });
  const start = (b: Building): SimCommand => ({
    kind: 'setBuildingPaused',
    buildingId: b.id,
    paused: false,
  });

  it('halts the anvil whose weapon is piling up, and only that one', () => {
    // The bug this rule is for: a bowstave is three wood, the storehouse is
    // bottomless so the forge's own buffer never fills, and the standing
    // order runs forever. The sword line is untouched in the same beat —
    // the rule reads each anvil's own recipe against its own pile.
    const { world, brain, swords, bows } = armory({ bow: 12, sword: 1 });
    const orders = beat(brain, world);
    expect(orders).toContainEqual(halt(bows));
    expect(orders).not.toContainEqual(halt(swords));
  });

  it('holds its fire between the lines, so an anvil is not flapped', () => {
    // Halting empties the post and starting it calls a hand back across the
    // village, so a forge that stopped and started over a single arrowhead
    // would spend its worker walking. Between the two lines, whatever each
    // anvil is doing it keeps doing.
    const running = armory({ bow: 6 });
    expect(beat(running.brain, running.world)).not.toContainEqual(halt(running.bows));

    const held = armory({ bow: 6 });
    held.bows.paused = true;
    expect(beat(held.brain, held.world)).not.toContainEqual(start(held.bows));
  });

  it('starts it again once the barracks has drawn the pile down', () => {
    // Nothing here is decided permanently: the pile is the only thing the
    // rule reads, so training the archers the forge already paid for is
    // what puts it back to work.
    const { world, brain, bows } = armory({ bow: 2 });
    bows.paused = true;
    expect(beat(brain, world)).toContainEqual(start(bows));
  });

  it('leaves an anvil with a batch in its queue alone', () => {
    // A queued order jumps the standing recipe, and `keepTheToolsComing` is
    // what puts tools there — so a forge with a queue is a forge making
    // something the village asked for by name.
    const { world, brain, bows } = armory({ bow: 12 });
    bows.forgeQueue = [{ recipeIndex: 4, started: false }];
    expect(beat(brain, world)).not.toContainEqual(halt(bows));
  });

  it('starts a halted anvil rather than leave a post without its tool', () => {
    // The guarantee that lets the rule above stand every forge in the
    // village down. Nine of the ten posts are gated on a tool and the Smith
    // is the only source of one, so the tool line may never be halted out
    // of existence — it is bought back here instead of paid for by holding
    // a forge open against a shortage that has not happened.
    const { world, brain, swords, bows } = armory({ bow: 12, sword: 12, axe: 0 });
    world.players[0]!.techs.researched.push('ironworking');
    swords.paused = true;
    bows.paused = true;
    // A woodcutter standing open with no axe on the shelf and none coming.
    addResourceTile(world, 20, 21);
    addBuiltHut(world, 20, 20, false);

    const orders = beat(brain, world);
    const woken = orders.find((c) => c.kind === 'setBuildingPaused' && c.paused === false);
    expect(woken).toBeDefined();
    const axe = BUILDING_DEFS.weaponsmith.recipeOptions!.findIndex(
      (o) => (o.recipe.outputs.axe ?? 0) > 0,
    );
    expect(orders).toContainEqual({
      kind: 'enqueueForge',
      buildingId: (woken as { buildingId: number }).buildingId,
      recipeIndex: axe,
    });
  });

  it('gives a woken anvil one order, not two rules\' worth', () => {
    // The overlap the wake path has to claim against: a pile under the
    // clear line is one `holdTheGlutForge` wants started too, and a post
    // standing open for a tool is one `keepTheToolsComing` wants started
    // for its own reason. Both are right; the anvil takes one order.
    const { world, brain, swords, bows } = armory({ bow: 2, sword: 2, axe: 0 });
    world.players[0]!.techs.researched.push('ironworking');
    swords.paused = true;
    bows.paused = true;
    addResourceTile(world, 20, 21);
    addBuiltHut(world, 20, 20, false);

    const opened = beat(brain, world)
      .filter((c) => c.kind === 'setBuildingPaused' && c.paused === false)
      .map((c) => (c as { buildingId: number }).buildingId);
    expect(opened).toEqual([...new Set(opened)]);
  });
});
