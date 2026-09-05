import {describe, expect, it} from 'vitest';
import {AI_STRATEGIES} from './defs/aiStrategies.ts';
import * as AiStrategyId from './defs/aiStrategyIdEnum.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as MatchState from './matchStateEnum.ts';
import * as PlayerKind from './playerKindEnum.ts';
import {AiBrain} from './systems/ai.ts';
import {tickWorld} from './tick.ts';
import {createWorld} from './world.ts';

/**
 * `AiStrategy.holdsGround` — the flag that lets a seat refuse to march.
 *
 * It exists for the Monument: an economic victory is a clock that runs while
 * you hold ground, and no seat that marches on the bandit camp will ever
 * demonstrate one — razing the camp ends the campaign long before a monument
 * could pay for itself. The Mason is the playbook that sets it, and
 * aiMonument.test.ts is where the shipped seat is measured; this file stays
 * because it tests the MECHANISM on a synthetic seat rather than the
 * playbook, and the negative below is one no playbook test can state —
 * the Steward's own line, one flag apart from itself.
 *
 * What is asserted is the negative that no number could buy. The muster bar
 * is eroded three ways in the brain — the impatience ramp, the growth-stall
 * clamp, and a favourable odds reading — so a playbook that merely prints a
 * high `armyAttackSize` still marches eventually. Measured before the flag
 * existed: a seat printing 16 razed the camp in 29 of 32 campaigns.
 */
function playCampaign(holdsGround: boolean, ticks: number) {
  const id = AiStrategyId.steward;
  const world = createWorld({
    seed: 101,
    players: [{kind: PlayerKind.ai, strategy: id}],
  });
  const strategy = {...AI_STRATEGIES[id], holdsGround};
  const brain = new AiBrain(0, strategy, world.map.size, undefined);
  for (
    let t = 0;
    t < ticks && world.outcome.state === MatchState.playing;
    t++
  ) {
    const cmds = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
    tickWorld(
      world,
      cmds.map(cmd => ({playerId: 0, cmd})),
    );
  }
  const campStands = [...world.buildings.values()].some(
    b => !b.dead && b.type === BuildingTypeId.banditCamp,
  );
  return {world, campStands};
}

describe('a seat that holds ground', () => {
  it('never razes the camp, where the same playbook marching does', () => {
    // The control: the Steward's own line, which is written to march and
    // does. If this stops razing the camp the test below proves nothing, so
    // it is asserted rather than assumed.
    const marching = playCampaign(false, 40_000);
    expect(marching.campStands, 'control seat never took the camp').toBe(false);

    // The same playbook, same seed, same ticks — one flag apart. The camp is
    // untouched because nobody ever walked to it.
    const holding = playCampaign(true, 40_000);
    expect(holding.campStands).toBe(true);
  });

  it('keeps an army at home rather than disbanding it', () => {
    // Holding ground is not pacifism: the seat still trains, and what it
    // trains stays alive because it never walks into a camp's guards. A seat
    // with no soldiers would satisfy the test above for the wrong reason.
    const {world} = playCampaign(true, 40_000);
    let soldiers = 0;
    for (const u of world.units.values()) {
      if (!u.dead && u.owner === 0 && u.kind >= 3 && u.kind <= 5) soldiers++;
    }
    expect(soldiers).toBeGreaterThan(0);
  });
});
