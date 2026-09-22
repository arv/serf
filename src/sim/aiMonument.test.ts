import {describe, expect, it} from 'vitest';
import type {Enum} from '../shared/enum.ts';
import * as BuildingState from './buildingStateEnum.ts';
import * as CommandKind from './commandKindEnum.ts';
import {AI_STRATEGIES} from './defs/aiStrategies.ts';
import * as AiStrategyId from './defs/aiStrategyIdEnum.ts';
import * as BuildAnchor from './defs/buildAnchorEnum.ts';
import {BUILDING_DEFS} from './defs/buildings.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as TechId from './defs/techIdEnum.ts';
import {UNIT_DEFS} from './defs/units.ts';
import * as MatchState from './matchStateEnum.ts';
import * as PlayerKind from './playerKindEnum.ts';
import {AiBrain} from './systems/ai.ts';
import {tickWorld} from './tick.ts';
import {createWorld, type World} from './world.ts';

type AiStrategyId = Enum<typeof AiStrategyId>;

/**
 * The economic win, played by a seat rather than described.
 *
 * The Monument shipped with nothing that could reach it: no playbook named
 * the building or Deep Mining, and the brain only researches from its own
 * `researchOrder`. What stood in the way once that was fixed is pinned
 * below, because each of those things was measured and none of them is
 * obvious.
 */

/** Play one solo campaign to the end, or to `maxTicks`. */
function playOut(seed: number, id: AiStrategyId, maxTicks = 90_000): World {
  const world = createWorld({
    seed,
    players: [{kind: PlayerKind.ai, strategy: id}],
  });
  const brain = new AiBrain(0, AI_STRATEGIES[id], world.map.size);
  for (
    let t = 0;
    t < maxTicks && world.outcome.state === MatchState.playing;
    t++
  ) {
    const cmds = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
    tickWorld(
      world,
      cmds.map(cmd => ({playerId: 0, cmd})),
    );
  }
  return world;
}

function monumentOf(world: World): boolean {
  for (const b of world.buildings.values()) {
    if (
      !b.dead &&
      b.owner === 0 &&
      b.type === BuildingTypeId.monument &&
      b.state === BuildingState.built
    ) {
      return true;
    }
  }
  return false;
}

describe('the Mason', () => {
  it('raises a Monument, and wins by it rather than by razing anything', () => {
    // Seed 102 of the sixteen this playbook was tuned on. Twelve of those
    // sixteen end this way — every one of the Mason's wins is a Monument,
    // because `holdsGround` means it never takes the camp and the solo win
    // has no other door. The Steward and the Fletcher take 14 of the same
    // sixteen, and take them roughly twice as fast (the Fletcher's median
    // win is 26k ticks against the Mason's 63k): slower and slightly worse
    // is what an economic alternative is supposed to look like.
    const world = playOut(102, AiStrategyId.mason);
    expect(world.outcome, `ended at tick ${world.tick}`).toEqual({
      state: MatchState.over,
      winner: 0,
    });
    expect(monumentOf(world), 'a Monument is standing').toBe(true);
    // ...and the camp it never marched on is standing too, which is what
    // makes the win economic rather than incidental.
    const camp = [...world.buildings.values()].some(
      b => !b.dead && b.type === BuildingTypeId.banditCamp,
    );
    expect(camp, 'the bandit camp was never razed').toBe(true);
  }, 240_000);

  it('asks for the tech as well as the building, which is what nothing did before', () => {
    // The gate that made every earlier attempt fail silently: the brain
    // researches from `researchOrder` and nothing else, so a playbook that
    // named the Monument without naming the tech placed nothing, forever,
    // and `isBuildingUnlocked` refused the command without a word.
    const mason = AI_STRATEGIES[AiStrategyId.mason];
    expect(mason.researchOrder).toContain(TechId.deepMining);
    const wants = (type: number): boolean =>
      mason.build.some(step => step.type === type);
    expect(wants(BuildingTypeId.goldMine)).toBe(true);
    expect(wants(BuildingTypeId.monument)).toBe(true);

    // The Monument is the Mason's alone. The GOLD is not — the Warlord has
    // dug it since gilded arms existed, which is the contrast worth having:
    // two seats want the same seam, one to win with and one to sharpen
    // swords with, and on a map with one seam they cannot both have it.
    for (const [id, other] of Object.entries(AI_STRATEGIES)) {
      if (Number(id) === AiStrategyId.mason) continue;
      expect(
        other.build.some(step => step.type === BuildingTypeId.monument),
        `${other.name} should not be building monuments`,
      ).toBe(false);
    }
    expect(
      AI_STRATEGIES[AiStrategyId.warlord].researchOrder,
      'the Warlord still wants the gold for its own reasons',
    ).toContain(TechId.deepMining);
  });

  it('doubles the bread chain, because the Monument is bought in loaves', () => {
    // Twenty bread, banked, while three mines each eat a ration. With one
    // chain the castle shelf sat at two to four loaves for forty thousand
    // ticks and the seat stood at the monument step every beat with the
    // gold and the stone already banked behind it.
    const mason = AI_STRATEGIES[AiStrategyId.mason];
    for (const type of [
      BuildingTypeId.wheatFarm,
      BuildingTypeId.mill,
      BuildingTypeId.bakery,
    ]) {
      const step = mason.build.find(s => s.type === type);
      expect(step?.more?.count, `${type} should be doubled`).toBe(2);
    }
  });
});

describe('the ground a Monument is sited on', () => {
  it("is the seat's own town, not the seam it is gilded from", () => {
    // The step anchored on the gold while the building had a placement rule
    // that demanded it. With the rule gone the anchor was the whole of what
    // still pushed the plinth out to the middle of the map — the one patch
    // worldgen deals to nobody, guarded by the bandit camp, and the
    // furthest ground from a garrison this playbook never marches
    // (`holdsGround`). The gold is still carted from there; the masonry is
    // not done there.
    const step = AI_STRATEGIES[AiStrategyId.mason].build.find(
      s => s.type === BuildingTypeId.monument,
    );
    expect(step?.anchor).toBe(BuildAnchor.base);
  });
});

describe('a garrison at strength', () => {
  it('stands the barracks down, so the bread stops being eaten', () => {
    // `holdsGround` said the army is a garrison and `armyAttackSize` is the
    // size it wants; nothing enforced it. A seat that never marches never
    // loses anybody, so it recruited forever — 30 to 41 soldiers on a
    // playbook printing 7, four seeds of four — and every recruit is two or
    // three loaves plus a standing call for more.
    const world = playOut(101, AiStrategyId.mason, 40_000);
    // Counted off `combat` rather than an id range, because that is the
    // predicate garrisonIsEnough itself counts by (RuleContext.soldierCount):
    // a test that measured a different set could pass while the rule capped
    // the wrong thing.
    let soldiers = 0;
    for (const u of world.units.values()) {
      if (!u.dead && u.owner === 0 && UNIT_DEFS[u.kind].combat) soldiers++;
    }
    const size = AI_STRATEGIES[AiStrategyId.mason].armyAttackSize;
    // A little over is the queue landing: orders already started still
    // finish. Far over is the bug this rule exists for.
    expect(
      soldiers,
      `garrison of ${soldiers} against a printed ${size}`,
    ).toBeLessThan(size * 2);
  }, 240_000);

  it('leaves a marching playbook recruiting, since its losses cap it instead', () => {
    // The rule is gated on `holdsGround` for a reason: capping a marching
    // seat at its own muster bar would stand the barracks down exactly when
    // the seat was about to need it. The Steward is the control.
    const world = playOut(101, AiStrategyId.steward, 25_000);
    const barracks = [...world.buildings.values()].find(
      b => !b.dead && b.owner === 0 && b.type === BuildingTypeId.barracks,
    );
    if (barracks) expect(barracks.paused ?? false).toBe(false);
  }, 240_000);
});

describe('the Mason is a playbook like any other', () => {
  it('names a building the build menu can actually offer', () => {
    for (const step of AI_STRATEGIES[AiStrategyId.mason].build) {
      expect(
        BUILDING_DEFS[step.type],
        `step ${step.type} has no def`,
      ).toBeDefined();
      expect(BUILDING_DEFS[step.type].systemOnly ?? false).toBe(false);
    }
  });

  it('never sends anyone out: no harass block, and it holds ground', () => {
    const mason = AI_STRATEGIES[AiStrategyId.mason];
    expect(mason.holdsGround).toBe(true);
    expect(mason.harass).toBeUndefined();
  });

  it('never sends its soldiers at a building, however long it plays', () => {
    // The flag's guarantee read off the commands rather than the data:
    // aiHoldsGround.test.ts proves the mechanism on a synthetic seat, and
    // this proves the shipped playbook wired it up. `focusTarget` with
    // `building` is the only order in the game that names a camp or a
    // castle, so a seat that never issues one never marches on either.
    const world = createWorld({
      seed: 101,
      players: [{kind: PlayerKind.ai, strategy: AiStrategyId.mason}],
    });
    const brain = new AiBrain(
      0,
      AI_STRATEGIES[AiStrategyId.mason],
      world.map.size,
    );
    let sieges = 0;
    for (
      let t = 0;
      t < 40_000 && world.outcome.state === MatchState.playing;
      t++
    ) {
      const cmds = brain.shouldDecide(world.tick) ? brain.decide(world) : [];
      for (const cmd of cmds) {
        if (cmd.kind === CommandKind.focusTarget && cmd.building) sieges++;
      }
      tickWorld(
        world,
        cmds.map(cmd => ({playerId: 0, cmd})),
      );
    }
    expect(sieges).toBe(0);
  }, 240_000);
});
