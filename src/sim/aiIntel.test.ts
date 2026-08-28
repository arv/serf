import {describe, expect, it} from 'vitest';
import {AI_STRATEGIES} from './defs/aiStrategies.ts';
import * as AiStrategyId from './defs/aiStrategyIdEnum.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as UnitTypeId from './defs/unitTypeIdEnum.ts';
import {AiBrain, AI_INTEL} from './systems/ai.ts';
import {addStorehouse, bareWorld} from './testUtils.ts';
import {placeBuiltBuilding, spawnUnit, type World} from './world.ts';

/**
 * The intelligence picture: what a seat knows about a rival, and how it
 * came to know it.
 *
 * The picture used to be one snapshot per rival, which is why a seat
 * marched believing the enemy had three soldiers — three being all one lone
 * scout ever lit at once (tools/aiLab/README.md, "The combat predictor").
 * What is pinned here is the accumulation that replaced it, the facts that
 * hang off it, and the two bounds that keep brain-local memory from growing
 * over a 120k-tick standoff.
 */

/** Our castle at (30,30), a rival castle in sight of it, nothing else. */
function watchWorld(): {world: World; brain: AiBrain} {
  const world = bareWorld(1, 2);
  addStorehouse(world, 30, 30, {});
  addStorehouse(world, 44, 30, {}, 1);
  spawnUnit(world, UnitTypeId.knight, 0, 42.5, 30.5); // our scout, lighting their yard
  world.tick = 1000;
  return {
    world,
    brain: new AiBrain(0, AI_STRATEGIES[AiStrategyId.steward], world.map.size),
  };
}

function picture(
  brain: AiBrain,
): ReturnType<AiBrain['intelReport']>[number] | undefined {
  return brain.intelReport().find(r => r.owner === 1);
}

describe('the intelligence picture', () => {
  it('adds up soldiers seen at different moments instead of overwriting', () => {
    const {world, brain} = watchWorld();
    const first = [
      spawnUnit(world, UnitTypeId.spearman, 1, 43.5, 30.5),
      spawnUnit(world, UnitTypeId.spearman, 1, 43.5, 31.5),
    ];
    brain.decide(world);
    expect(picture(brain)?.total).toBe(2);

    // They march off over the hill; two others take their place. A snapshot
    // would still read two — this is the whole point of the roster.
    for (const u of first) {
      u.x = 90.5;
      u.y = 90.5;
    }
    spawnUnit(world, UnitTypeId.spearman, 1, 43.5, 30.5);
    spawnUnit(world, UnitTypeId.spearman, 1, 43.5, 31.5);
    world.tick += 20;
    brain.decide(world);
    expect(picture(brain)?.total).toBe(4);
  });

  it('does not count corpses', () => {
    const {world, brain} = watchWorld();
    const fallen = spawnUnit(world, UnitTypeId.spearman, 1, 43.5, 30.5);
    fallen.dead = true;
    brain.decide(world);
    expect(picture(brain)?.total ?? 0).toBe(0);
  });

  it('lets a man age out of the picture when nobody has seen him since', () => {
    const {world, brain} = watchWorld();
    const seen = spawnUnit(world, UnitTypeId.spearman, 1, 43.5, 30.5);
    brain.decide(world);
    expect(picture(brain)?.total).toBe(1);
    seen.x = 90.5;
    world.tick += AI_INTEL.trustFor + 20;
    brain.decide(world);
    expect(picture(brain)?.total).toBe(0);
  });

  it('remembers the biggest the roster has been, not only what is left of it', () => {
    const {world, brain} = watchWorld();
    const host = Array.from({length: 4}, (_, i) =>
      spawnUnit(world, UnitTypeId.spearman, 1, 43.5, 29.5 + i * 0.5),
    );
    // Long enough for the trend series to take a sample of the full host.
    for (let i = 0; i < 3; i++) {
      brain.decide(world);
      world.tick += AI_INTEL.samplePeriod;
    }
    for (const u of host) u.x = 90.5;
    world.tick += AI_INTEL.trustFor;
    brain.decide(world);
    const pic = picture(brain);
    expect(pic?.total).toBe(0);
    expect(pic?.peak).toBe(4);
  });

  it('stamps first contact, and calls a raid a raid only when it is a force', () => {
    const {world, brain} = watchWorld();
    // One man at our gates is a scout, not an attack.
    const lone = spawnUnit(world, UnitTypeId.spearman, 1, 33.5, 30.5);
    brain.decide(world);
    expect(picture(brain)?.firstSoldierTick).toBe(1000);
    expect(picture(brain)?.firstAttackTick).toBe(-1);

    // `minSighting` of them at once is.
    for (let i = 1; i < AI_INTEL.minSighting; i++) {
      spawnUnit(world, UnitTypeId.spearman, 1, 33.5, 30.5 + i);
    }
    world.tick += 20;
    brain.decide(world);
    expect(picture(brain)?.firstAttackTick).toBe(1020);
    // And first contact is not re-stamped by the second visitor.
    expect(picture(brain)?.firstSoldierTick).toBe(1000);
    expect(lone.dead).toBe(false);
  });

  it('counts the village it has found at minute five, and only what it has found', () => {
    const {world, brain} = watchWorld();
    placeBuiltBuilding(world, BuildingTypeId.barracks, 1, 42, 33); // in our scout's light
    placeBuiltBuilding(world, BuildingTypeId.barracks, 1, 80, 80); // over the horizon
    world.tick = AI_INTEL.earlyMark;
    brain.decide(world);
    // The castle and the near barracks; never the one nobody has seen.
    expect(picture(brain)?.buildingsAtFive).toBe(2);
  });

  it('says it does not know before minute five rather than guessing zero', () => {
    const {world, brain} = watchWorld();
    world.tick = AI_INTEL.earlyMark - 20;
    brain.decide(world);
    expect(picture(brain)?.buildingsAtFive ?? -1).toBe(-1);
  });

  it('keeps the trend series bounded, however long the standoff runs', () => {
    const {world, brain} = watchWorld();
    spawnUnit(world, UnitTypeId.spearman, 1, 43.5, 30.5);
    // Six hundred samples' worth of match — a standoff that reaches the
    // bake-off's 120k horizon. The window must not have grown with it.
    for (let t = 0; t < 120_000; t += AI_INTEL.samplePeriod) {
      world.tick = 1000 + t;
      brain.decide(world);
    }
    const trend = picture(brain)?.trend;
    expect(trend).not.toBeNull();
    const span = (trend?.toTick ?? 0) - (trend?.fromTick ?? 0);
    expect(span).toBeLessThanOrEqual(
      (AI_INTEL.seriesLen - 1) * AI_INTEL.samplePeriod,
    );
  });

  it('re-reads a doorstep on the refresh clock even while one straggler is in sight', () => {
    // The bug this pins: a single rival soldier wandering in and out of the
    // light used to reset `refreshAfter` as though the yard had been read,
    // so a harassed seat never once looked at what was massing behind it.
    const {world, brain} = watchWorld();
    spawnUnit(world, UnitTypeId.spearman, 1, 33.5, 30.5); // the straggler, always in view
    for (let i = 0; i < 3; i++)
      spawnUnit(world, UnitTypeId.knight, 0, 33.5, 27.5 + i);
    brain.decide(world);
    const before = picture(brain)?.reads ?? 0;
    // Well past the refresh clock, with the straggler still standing there.
    for (let t = 0; t <= AI_INTEL.refreshAfter + 2000; t += 20) {
      world.tick = 1000 + t;
      brain.decide(world);
    }
    expect(picture(brain)?.reads ?? 0).toBeGreaterThan(before);
  });
});
