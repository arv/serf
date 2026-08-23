import { describe, expect, it } from 'vitest';
import { createWorld, type World, type WorldConfig } from './world.ts';
import { tickWorld, type PlayerCommand } from './tick.ts';
import { AI_PACING, AI_STALL, AiBrain, LEVY_HOLD } from './systems/ai.ts';
import { AiSeats } from './aiSeats.ts';
import { strategyOf, type AiStrategy } from './defs/aiStrategies.ts';
import { checkInvariants } from './debug/invariants.ts';
import { AI_STRATEGIES } from './defs/aiStrategies.ts';
import { placeBuiltBuilding, spawnUnit } from './world.ts';
import { BUILDING_DEFS, OUTPUT_CAP } from './defs/buildings.ts';
import { tileIdx } from '../shared/grid.ts';
import { BANDIT, type Building } from './entities.ts';
import { addBuiltHut, addResourceTile, addStorehouse, bareWorld, cmds } from './testUtils.ts';
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
   * the castle; a march is the whole muster ordered anywhere else. */
  function firstMarchTick(override: Partial<AiStrategy> | null, maxTicks: number): number {
    const world = createWorld({ seed: 20260724, players: [{ kind: 'ai', strategy: 'steward' }] });
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

  it('buys a hauler with a post nobody is using', () => {
    const { world, brain, hut } = frozenVillage();
    beatUntil(brain, world, AI_STALL.graceUntil + AI_STALL.samplePeriod * AI_STALL.window + 100);
    const commands = beatUntil(brain, world, world.tick + AI_PACING.decisionInterval * 2);
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
