import {describe, expect, it} from 'vitest';
import * as CommandKind from './commandKindEnum.ts';
import type {SimCommand} from './commands.ts';
import {AI_STRATEGIES} from './defs/aiStrategies.ts';
import * as AiStrategyId from './defs/aiStrategyIdEnum.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as DifficultyId from './defs/difficultyEnum.ts';
import * as UnitTypeId from './defs/unitTypeIdEnum.ts';
import {AI_INTEL, AI_WAR, AiBrain} from './systems/ai.ts';
import {addBuiltHut, addStorehouse, bareWorld} from './testUtils.ts';
import type {Unit} from './units.ts';
import * as WarBehaviorId from './warBehaviorIdEnum.ts';
import type {World} from './world.ts';
import {placeBuiltBuilding, spawnUnit} from './world.ts';

/**
 * The war behaviors (warBehaviorIdEnum, AI_WAR): the reactive verbs that
 * make a seat visibly answer the match. What is under test is that each
 * verb fires when its situation holds, stands down when it does not, and
 * leaves the fingerprints warReport() promises — whether the verbs WIN is
 * the bake-off's question, not this file's.
 */

const BASE = 10;

function village(): World {
  const world = bareWorld(1, 3);
  addStorehouse(world, BASE, BASE, {});
  return world;
}

function knights(world: World, n: number, owner = 0, x = BASE - 2): Unit[] {
  const out: Unit[] = [];
  for (let i = 0; i < n; i++)
    out.push(spawnUnit(world, UnitTypeId.knight, owner, x + i * 0.1, BASE - 2));
  return out;
}

type Move = {
  kind: typeof CommandKind.moveUnits;
  unitIds: number[];
  x: number;
  y: number;
  attack?: true | 'half';
};
const moves = (commands: SimCommand[]): Move[] =>
  commands.filter(c => c.kind === CommandKind.moveUnits) as Move[];

describe('harassment sorties', () => {
  it('sends a walk-in-quiet party at a rival economy building', () => {
    const world = village();
    addBuiltHut(world, BASE + 8, BASE, false, 1);
    knights(world, 5); // above the steward's party of four, below its bar
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    world.tick = 1300; // past the steward's 1200-tick harass cooldown
    const sortie = moves(brain.decide(world)).find(m => m.attack === 'half');
    expect(sortie).toBeDefined();
    expect(sortie!.unitIds).toHaveLength(4);
    expect(brain.warReport().sorties).toBe(1);
  });

  it('a personality without harass never harasses', () => {
    const world = village();
    addBuiltHut(world, BASE + 8, BASE, false, 1);
    knights(world, 6);
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.abbot],
      world.map.size,
    );
    world.tick = 5000;
    brain.decide(world);
    expect(brain.warReport().sorties).toBe(0);
  });

  it('pulls the party home the beat its target falls, and counts the strike', () => {
    const world = village();
    const hut = addBuiltHut(world, BASE + 8, BASE, false, 1);
    knights(world, 5);
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    world.tick = 1300;
    const party = moves(brain.decide(world)).find(m => m.attack === 'half')!;
    hut.dead = true;
    world.tick += 20;
    const home = moves(brain.decide(world)).find(
      m => m.attack === undefined && m.unitIds.length === party.unitIds.length,
    );
    expect(home).toBeDefined();
    expect(home!.unitIds).toEqual(party.unitIds);
    expect(brain.warReport().sortieStrikes).toBe(1);
    expect(brain.warReport().sortieWithdrawals).toBe(0);
  });

  it('never launches a party its own withdrawal gate would break at the door', () => {
    // The oscillation this pins: #launchSortie used to pick its target
    // blind, and #manageSortie read the defenders one beat later — so a
    // seat facing a garrisoned rival launched and recalled a party every
    // harass clock, a twenty-tick walk out the gate and back, all match.
    const world = village();
    const hut = addBuiltHut(world, BASE + 8, BASE, false, 1);
    knights(world, 5);
    // A defense the party of four cannot survive, standing at the hut in
    // the castle's own light.
    for (let i = 0; i < 8; i++)
      spawnUnit(
        world,
        UnitTypeId.knight,
        1,
        hut.x + 0.5,
        hut.y + 1.5 + i * 0.1,
      );
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    brain.setStancePolicy(false);
    world.tick = 1300;
    expect(
      moves(brain.decide(world)).find(m => m.attack === 'half'),
    ).toBeUndefined();
    expect(brain.warReport().sorties).toBe(0);
  });

  it('avenges the rival whose raid last reached the yard, not the nearest', () => {
    const world = village();
    addBuiltHut(world, BASE + 6, BASE, false, 1); // rival 1: nearer
    const grudgeHut = addBuiltHut(world, BASE + 9, BASE, false, 2);
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    // Rival 2 raids: three of theirs at the gates in one look.
    const raiders = knights(world, 3, 2, BASE + 2);
    world.tick = 100;
    brain.decide(world);
    for (const r of raiders) r.dead = true;
    // The next muster window: the sortie goes for the grudge's hut.
    knights(world, 5);
    world.tick = 1300;
    const sortie = moves(brain.decide(world)).find(m => m.attack === 'half');
    expect(sortie).toBeDefined();
    expect(sortie!.x).toBe(Math.floor(grudgeHut.x + grudgeHut.w / 2));
  });
});

describe('outpost defense', () => {
  it('sends idle soldiers at a raider on a far building', () => {
    const world = village();
    const mine = addBuiltHut(world, BASE + 20, BASE, false, 0);
    spawnUnit(world, UnitTypeId.knight, 1, BASE + 21.5, BASE + 1.5);
    knights(world, 4);
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    world.tick = 500;
    const call = moves(brain.decide(world)).find(
      m => m.attack === true && m.x === Math.floor(mine.x + mine.w / 2),
    );
    expect(call).toBeDefined();
    expect(call!.unitIds.length).toBeLessThanOrEqual(3);
    expect(brain.warReport().outpostDefenses).toBe(1);
  });

  it('leaves a building inside the homeGuard belt to the homeGuard', () => {
    const world = village();
    addBuiltHut(world, BASE + 6, BASE, false, 0); // inside outpostRange
    spawnUnit(world, UnitTypeId.knight, 1, BASE + 7.5, BASE + 1.5);
    knights(world, 4);
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.warlord], // no fortify break to muddy it
      world.map.size,
    );
    world.tick = 500;
    brain.decide(world);
    expect(brain.warReport().outpostDefenses).toBe(0);
  });
});

describe('the losing march', () => {
  /** March twelve knights at a found castle, then gut the army. */
  function routedMarch(id: AiStrategyId.steward | AiStrategyId.warlord): {
    world: World;
    brain: AiBrain;
  } {
    const world = village();
    addStorehouse(world, BASE + 8, BASE, {}, 1);
    const army = knights(world, 12);
    const brain = new AiBrain(0, AI_STRATEGIES[id], world.map.size);
    // The retreat is the subject; the herald would hold the march it needs.
    brain.setWarBehaviors([WarBehaviorId.retreatMarch]);
    world.tick = 1500; // past dwell and every cooldown: the march fires
    const marched = moves(brain.decide(world)).some(
      m => m.unitIds.length === 12,
    );
    expect(marched).toBe(true);
    // The assault goes badly: eight fall, and a garrison stands revealed.
    for (const u of army.slice(0, 8)) u.dead = true;
    knights(world, 10, 1, BASE + 7);
    world.tick += 40;
    return {world, brain};
  }

  it('a steward turns home under a quarter odds at half strength', () => {
    const {world, brain} = routedMarch(AiStrategyId.steward);
    const survivors = moves(brain.decide(world)).find(
      m => m.attack === undefined && m.unitIds.length === 4,
    );
    expect(survivors).toBeDefined();
    expect(brain.warReport().marchRetreats).toBe(1);
  });

  it('a warlord never does', () => {
    const {world, brain} = routedMarch(AiStrategyId.warlord);
    brain.decide(world);
    expect(brain.warReport().marchRetreats).toBe(0);
  });
});

describe('the wiped march', () => {
  /** The rival castle's tile, as the all-in march orders it. */
  const CASTLE = {x: BASE + 9, y: BASE + 1};
  const marchesOn = (commands: SimCommand[]): Move | undefined =>
    moves(commands).find(m => m.x === CASTLE.x && m.y === CASTLE.y);

  /** March `n` knights at a found castle and lose every one of them. */
  function wipedMarch(
    tier: DifficultyId.easy | DifficultyId.normal | DifficultyId.hard,
    n: number,
  ): {world: World; brain: AiBrain} {
    const world = village();
    addStorehouse(world, BASE + 8, BASE, {}, 1);
    const army = knights(world, n);
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.warlord],
      world.map.size,
      tier,
    );
    brain.setWarBehaviors([WarBehaviorId.wipedMarch]);
    world.tick = 1500; // past dwell and every cooldown: the march fires
    expect(marchesOn(brain.decide(world))?.unitIds.length).toBe(n);
    for (const u of army) u.dead = true;
    world.tick += 40;
    expect(marchesOn(brain.decide(world))).toBeUndefined();
    return {world, brain};
  }

  it('the same number does not march twice, and one more does', () => {
    // The played case (seed 55973911): three knights at a tower and an
    // army, every cooldown, for twenty thousand ticks. What died is the
    // lesson — the next march on that castle wants more than that.
    const {world, brain} = wipedMarch(DifficultyId.hard, 6);
    expect(brain.warReport().wipes).toBe(1);
    knights(world, 6);
    world.tick += 2000; // past the attack cooldown, short of impatience
    expect(marchesOn(brain.decide(world))).toBeUndefined();
    knights(world, 1, 0, BASE + 1);
    world.tick += 40;
    expect(marchesOn(brain.decide(world))?.unitIds.length).toBe(7);
  });

  it('outranks the growth-stall clamp that was feeding the men', () => {
    // An army that cannot grow past what already died is not "as big as
    // it is getting", it is known to be too small: the clamp that drops
    // the bar to whatever stands does not get to march it.
    const {world, brain} = wipedMarch(DifficultyId.hard, 6);
    knights(world, 3);
    world.tick += 6000; // past growthStallAfter, short of staleAfter
    expect(marchesOn(brain.decide(world))).toBeUndefined();
  });

  it('is a lesson about one castle, not about marching', () => {
    const {world, brain} = wipedMarch(DifficultyId.hard, 6);
    // The castle that wiped the march falls to someone else: nothing to
    // remember, and the next target is marched on at the bar.
    const castle = [...world.buildings.values()].find(b => b.owner === 1)!;
    castle.dead = true;
    addStorehouse(world, BASE, BASE + 8, {}, 2);
    knights(world, 6);
    world.tick += 2000;
    const next = moves(brain.decide(world)).find(
      m => m.x === BASE + 1 && m.y === BASE + 9,
    );
    expect(next?.unitIds.length).toBe(6);
  });

  it('on normal the lesson is learned too; on easy it is not', () => {
    expect(wipedMarch(DifficultyId.normal, 6).brain.warReport().wipes).toBe(1);
    // Easy musters three higher, so it takes more men to get a march out.
    const {world, brain} = wipedMarch(DifficultyId.easy, 10);
    expect(brain.warReport().wipes).toBe(0);
    knights(world, 10);
    world.tick += 2000;
    expect(marchesOn(brain.decide(world))?.unitIds.length).toBe(10);
  });
});

describe('the flanking march', () => {
  /** A castle thirty tiles east, with a tower on the straight road to it
   * — and a hut of ours beside each, so the seat has laid eyes on both. */
  const CASTLE = {x: 40, y: 12};
  const TOWER = {x: 28, y: 11, w: 2, h: 2};
  const REACH = 5 + 2; // an archer's range from the wall
  function towered(
    tier: DifficultyId.normal | DifficultyId.hard,
    tower = true,
  ): {world: World; brain: AiBrain; army: Unit[]} {
    const world = village();
    addStorehouse(world, CASTLE.x, CASTLE.y, {}, 1);
    if (tower) {
      const t = placeBuiltBuilding(
        world,
        BuildingTypeId.guardTower,
        1,
        TOWER.x,
        TOWER.y,
      );
      t.garrison = 2;
      t.garrisonKind = UnitTypeId.archer;
    }
    addBuiltHut(world, 31, 15, false);
    addBuiltHut(world, 38, 16, false);
    const army = knights(world, 8, 0, BASE - 2);
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.warlord],
      world.map.size,
      tier,
    );
    brain.setWarBehaviors([WarBehaviorId.flankMarch]);
    world.tick = 1500;
    return {world, brain, army};
  }
  const towerDist = (x: number, y: number): number => {
    const px = Math.max(TOWER.x, Math.min(x + 0.5, TOWER.x + TOWER.w));
    const py = Math.max(TOWER.y, Math.min(y + 0.5, TOWER.y + TOWER.h));
    return Math.hypot(x + 0.5 - px, y + 0.5 - py);
  };
  const isCastle = (m: Move): boolean =>
    m.x === CASTLE.x + 1 && m.y === CASTLE.y + 1;

  it('walks round a known tower in legs, and only then at the castle', () => {
    const {world, brain, army} = towered(DifficultyId.hard);
    const legs: Move[] = [];
    for (let i = 0; i < 12; i++) {
      const order = moves(brain.decide(world)).find(
        m => m.unitIds.length === 8,
      );
      expect(order, `leg ${i}`).toBeDefined();
      legs.push(order!);
      if (isCastle(order!)) break;
      // The army walks the leg (teleported: the sim is not under test).
      for (const u of army) {
        u.x = order!.x + 0.5;
        u.y = order!.y + 0.5;
        u.task = {t: 1, until: world.tick};
      }
      world.tick += 40;
    }
    expect(legs.length).toBeGreaterThan(1);
    expect(isCastle(legs[legs.length - 1]!)).toBe(true);
    // Every waypoint stands outside the tower's arrows.
    for (const leg of legs.slice(0, -1))
      expect(towerDist(leg.x, leg.y)).toBeGreaterThan(REACH);
    expect(brain.warReport().flanked).toBe(1);
  });

  it('marches straight when no tower stands on the road', () => {
    const {world, brain} = towered(DifficultyId.hard, false);
    const order = moves(brain.decide(world)).find(m => m.unitIds.length === 8);
    expect(order && isCastle(order)).toBe(true);
    expect(brain.warReport().flanked).toBe(0);
  });

  it("is hard's alone", () => {
    const {world, brain} = towered(DifficultyId.normal);
    const order = moves(brain.decide(world)).find(m => m.unitIds.length === 8);
    expect(order && isCastle(order)).toBe(true);
  });
});

describe('the homeGuard and the march', () => {
  /** March twelve knights out at a found castle, with the reactive verbs
   * off so the recall branch is the only thing left to speak. */
  function marchedOut(): {world: World; brain: AiBrain} {
    const world = village();
    addStorehouse(world, BASE + 8, BASE, {}, 1);
    knights(world, 12);
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.abbot], // homeGuard 14: the belt under test
      world.map.size,
    );
    brain.setWarBehaviors([]); // no herald hold, no retreat: the recall is the subject
    brain.setStancePolicy(false);
    world.tick = 1500;
    const marched = moves(brain.decide(world)).some(
      m => m.unitIds.length === 12,
    );
    expect(marched).toBe(true);
    return {world, brain};
  }

  it('a straggler at the gates does not recall the march', () => {
    // The oscillation this pins: any lone rival fighter inside the belt
    // used to yank the whole announced assault home — herald, march,
    // recall, re-herald, for as long as anyone's stray patrol wandered by.
    const {world, brain} = marchedOut();
    spawnUnit(world, UnitTypeId.knight, 1, BASE + 0.5, BASE + 1.5);
    world.tick += 500; // past the rally cooldown, well short of re-muster
    expect(
      moves(brain.decide(world)).find(
        m => m.attack === true && m.unitIds.length === 12,
      ),
    ).toBeUndefined();
  });

  it('a real force at the gates still does', () => {
    const {world, brain} = marchedOut();
    for (let i = 0; i < AI_INTEL.minSighting; i++)
      spawnUnit(world, UnitTypeId.knight, 1, BASE + 0.5, BASE + 1.5 + i * 0.2);
    world.tick += 500;
    const recall = moves(brain.decide(world)).find(
      m => m.attack === true && m.unitIds.length === 12,
    );
    expect(recall).toBeDefined();
    expect(recall!.y).toBe(BASE + 1 + 4); // home: the castle rally point
  });
});

describe('the herald', () => {
  /** Twelve knights and a found rival castle: an assault worth announcing. */
  function assaultReady(): {world: World; brain: AiBrain} {
    const world = village();
    addStorehouse(world, BASE + 8, BASE, {}, 1);
    knights(world, 12);
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    world.tick = 1500;
    return {world, brain};
  }

  it('announces the assault, holds the lead, then marches', () => {
    const {world, brain} = assaultReady();
    const first = brain.decide(world);
    const heraldCmd = first.find(c => c.kind === CommandKind.herald);
    expect(heraldCmd).toBeDefined();
    expect(heraldCmd).toMatchObject({target: 1, count: 12});
    expect(moves(first)).toEqual([]); // the army stands while the words land
    expect(brain.warReport().heralds).toBe(1);
    // Inside the lead: still standing.
    world.tick += AI_WAR.heraldLead - 100;
    expect(moves(brain.decide(world)).some(m => m.unitIds.length === 12)).toBe(
      false,
    );
    // Past it: the march fires, once.
    world.tick += 200;
    expect(moves(brain.decide(world)).some(m => m.unitIds.length === 12)).toBe(
      true,
    );
    expect(brain.warReport().heralds).toBe(1);
  });

  it('only a rival castle is owed the courtesy — the dark is swept unannounced', () => {
    const world = village();
    // No rival buildings found: a full muster goes searching instead of
    // marching, and no herald sounds for it. (Camps take the same branch —
    // isPlayerOwner(target.owner) gates the announcement.)
    knights(world, 12);
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    world.tick = 1500;
    brain.decide(world);
    expect(brain.warReport().heralds).toBe(0);
  });
});

describe('the scout that runs', () => {
  it('flees at half blood, filing what it was sent for', () => {
    const world = village();
    knights(world, 3);
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.steward],
      world.map.size,
    );
    world.tick = 100;
    // Discovery appoints the fastest idle soldier and walks him out.
    const errand = moves(brain.decide(world)).find(m => m.unitIds.length === 1);
    expect(errand).toBeDefined();
    const scout = world.units.get(errand!.unitIds[0]!)!;
    scout.hp = 30; // under half of a knight's 80
    world.tick += 20;
    const flight = moves(brain.decide(world)).find(
      m => m.unitIds.length === 1 && m.unitIds[0] === scout.id,
    );
    expect(flight).toBeDefined();
    expect(flight!.attack).toBeUndefined();
    expect(brain.warReport().scoutFled).toBe(1);
  });
});
