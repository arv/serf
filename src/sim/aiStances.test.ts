import {describe, expect, it} from 'vitest';
import {
  POSTURES,
  stanceWarKnobs,
  type StancePick,
} from './defs/aiPostures.ts';
import {AI_STRATEGIES, AI_STRATEGY_ORDER} from './defs/aiStrategies.ts';
import * as AiStrategyId from './defs/aiStrategyIdEnum.ts';
import * as PostureId from './defs/postureIdEnum.ts';
import * as UnitTypeId from './defs/unitTypeIdEnum.ts';
import * as CommandKind from './commandKindEnum.ts';
import {AI_STANCE, AiBrain} from './systems/ai.ts';
import {addStorehouse, bareWorld} from './testUtils.ts';
import type {World} from './world.ts';
import {spawnUnit} from './world.ts';

/**
 * The stance engine: a playbook's moods, switched by the match.
 *
 * What is under test is the state machine and its clocks — the fortify
 * break-in on danger, the dwell that stops flapping, the found-stance
 * taking over once a rival castle is on explored ground — and that a
 * stance actually colors the strategy the beat plays. Whether the moods
 * WIN is the bake-off's question, not this file's.
 */

const BASE = 10;

/** A village to hold a stance in: castle at (10,10), owner 0. */
function village(): World {
  const world = bareWorld(1, 2);
  addStorehouse(world, BASE, BASE, {});
  return world;
}

function brainFor(id: (typeof AI_STRATEGY_ORDER)[number], world: World) {
  return new AiBrain(0, AI_STRATEGIES[id], world.map.size);
}

/** A rival knight in the yard — visible, hostile, close. */
function raiderAtGates(world: World): void {
  spawnUnit(world, UnitTypeId.knight, 1, BASE + 3.5, BASE + 3.5);
}

/** A rival castle close enough that the seat's own light explores it —
 * the storage flag is what makes a storehouse a castle to the brain. */
function rivalCastleNearby(world: World): {x: number; y: number} {
  addStorehouse(world, BASE + 8, BASE, {}, 1);
  return {x: BASE + 8, y: BASE};
}

describe('stanceWarKnobs', () => {
  it('resolves a pick to the posture’s war knobs, holds layered over', () => {
    const pick: StancePick = {
      posture: PostureId.raid,
      hold: {armyAttackSize: 10},
    };
    expect(stanceWarKnobs(pick)).toEqual({
      armyAttackSize: 10, // held, not the raid stance's 5
      attackCooldown: POSTURES[PostureId.raid].knobs.attackCooldown,
      homeGuard: POSTURES[PostureId.raid].knobs.homeGuard,
      prefersRivals: POSTURES[PostureId.raid].knobs.prefersRivals,
      barracksQueueDepth: POSTURES[PostureId.raid].knobs.barracksQueueDepth,
    });
  });

  it('every playbook’s cascade names real postures', () => {
    for (const id of AI_STRATEGY_ORDER) {
      const st = AI_STRATEGIES[id].stances;
      expect(POSTURES[st.found.posture], `${id} found`).toBeDefined();
      if (st.opening)
        expect(POSTURES[st.opening.posture], `${id} opening`).toBeDefined();
    }
  });
});

describe('the fortify break-in', () => {
  it('breaks stance the same beat hostiles reach the yard', () => {
    const world = village();
    raiderAtGates(world);
    const brain = brainFor(AiStrategyId.steward, world);
    brain.decide(world);
    expect(brain.stanceReport().state).toBe('fortify');
  });

  it('does not break a warlord — pressure answers pressure', () => {
    const world = village();
    raiderAtGates(world);
    const brain = brainFor(AiStrategyId.warlord, world);
    brain.decide(world);
    expect(brain.stanceReport().state).toBe('opening');
  });

  it('reverts through the clocks, not the same beat the raider dies', () => {
    const world = village();
    const raider = spawnUnit(world, UnitTypeId.knight, 1, BASE + 3.5, BASE + 3.5);
    const brain = brainFor(AiStrategyId.steward, world);
    brain.decide(world);
    expect(brain.stanceReport().state).toBe('fortify');
    raider.dead = true;
    // The next beat is inside the dwell: still fortified.
    world.tick = AI_STANCE.dwell - 200;
    brain.decide(world);
    expect(brain.stanceReport().state).toBe('fortify');
    // Past the dwell, on an eval beat: the mood lifts.
    world.tick = AI_STANCE.dwell + AI_STANCE.evalPeriod;
    brain.decide(world);
    expect(brain.stanceReport().state).toBe('opening');
  });
});

describe('the found stance', () => {
  it('takes over once a rival castle stands on explored ground', () => {
    const world = village();
    rivalCastleNearby(world);
    const brain = brainFor(AiStrategyId.steward, world);
    world.tick = 0;
    brain.decide(world);
    // The dwell holds the opening on the first beat…
    expect(brain.stanceReport().state).toBe('opening');
    // …and the switch lands once the clocks allow.
    world.tick = AI_STANCE.dwell;
    brain.decide(world);
    expect(brain.stanceReport().state).toBe('found');
  });

  it('waits for the army a late-push playbook demands', () => {
    const world = village();
    rivalCastleNearby(world);
    const brain = brainFor(AiStrategyId.abbot, world);
    world.tick = AI_STANCE.dwell;
    brain.decide(world);
    // Abbot's foundAfterArmy is 10 and nobody is standing: opening holds.
    expect(brain.stanceReport().state).toBe('opening');
    for (let i = 0; i < 10; i++)
      spawnUnit(world, UnitTypeId.knight, 0, BASE - 2 + i * 0.1, BASE - 2);
    world.tick += AI_STANCE.evalPeriod;
    brain.decide(world);
    expect(brain.stanceReport().state).toBe('found');
  });
});

describe('the stance colors the beat', () => {
  /** Seven knights, a found castle, a cooled clock: the printed steward
   * (bar 7) marches; the siege stance it switches into (bar 12) holds. */
  function sevenKnightsAndACastle(): {
    world: World;
    castle: {x: number; y: number};
  } {
    const world = village();
    const castle = rivalCastleNearby(world);
    for (let i = 0; i < 7; i++)
      spawnUnit(world, UnitTypeId.knight, 0, BASE - 2 + i * 0.1, BASE - 2);
    world.tick = 1500; // past dwell, past the printed 900-tick cooldown
    return {world, castle};
  }

  const marchesOn = (
    commands: readonly {kind: number; x?: number; y?: number}[],
    castle: {x: number; y: number},
  ): boolean =>
    commands.some(
      c =>
        c.kind === CommandKind.moveUnits &&
        c.x === castle.x + 1 &&
        c.y === castle.y + 1,
    );

  it('a stanceless steward marches at seven; the stance holds for twelve', () => {
    const off = sevenKnightsAndACastle();
    const offBrain = brainFor(AiStrategyId.steward, off.world);
    offBrain.setStancePolicy(false);
    offBrain.setWarBehaviors([]); // the herald's hold is aiWar's subject
    expect(marchesOn(offBrain.decide(off.world), off.castle)).toBe(true);

    const on = sevenKnightsAndACastle();
    const onBrain = brainFor(AiStrategyId.steward, on.world);
    onBrain.setWarBehaviors([]);
    expect(marchesOn(onBrain.decide(on.world), on.castle)).toBe(false);
    expect(onBrain.stanceReport().state).toBe('found');
  });

  it('advice still outranks the stance — the lab’s steering survives', () => {
    const {world, castle} = sevenKnightsAndACastle();
    const brain = brainFor(AiStrategyId.steward, world);
    brain.setWarBehaviors([]);
    // Siege stance would hold at twelve; advice drops the bar to four.
    brain.setOverride({armyAttackSize: 4, attackCooldown: 300});
    expect(marchesOn(brain.decide(world), castle)).toBe(true);
  });
});
