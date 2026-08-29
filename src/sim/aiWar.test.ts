import {describe, expect, it} from 'vitest';
import * as CommandKind from './commandKindEnum.ts';
import type {SimCommand} from './commands.ts';
import {AI_STRATEGIES} from './defs/aiStrategies.ts';
import * as AiStrategyId from './defs/aiStrategyIdEnum.ts';
import * as UnitTypeId from './defs/unitTypeIdEnum.ts';
import {AI_WAR, AiBrain} from './systems/ai.ts';
import {addBuiltHut, addStorehouse, bareWorld} from './testUtils.ts';
import type {Unit} from './units.ts';
import * as WarBehaviorId from './warBehaviorIdEnum.ts';
import type {World} from './world.ts';
import {spawnUnit} from './world.ts';

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
