import {describe, expect, it} from 'vitest';
import type {Enum} from '../shared/enum.ts';
import * as BuildingState from './buildingStateEnum.ts';
import * as CommandKind from './commandKindEnum.ts';
import {AI_STRATEGIES} from './defs/aiStrategies.ts';
import * as AiStrategyId from './defs/aiStrategyIdEnum.ts';
import {BUILDING_DEFS} from './defs/buildings.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as TechId from './defs/techIdEnum.ts';
import {nearestSeamGround} from './map.ts';
import * as MatchState from './matchStateEnum.ts';
import * as PlayerKind from './playerKindEnum.ts';
import {AiBrain} from './systems/ai.ts';
import {bareWorld} from './testUtils.ts';
import {tickWorld} from './tick.ts';
import * as TileResource from './tileResourceEnum.ts';
import {createWorld, depleteResourceTile, type World} from './world.ts';

type AiStrategyId = Enum<typeof AiStrategyId>;

/**
 * The economic win, played by a seat rather than described.
 *
 * The Monument shipped with nothing that could reach it: no playbook named
 * the building or Deep Mining, and the brain only researches from its own
 * `researchOrder`. Three things were in the way once that was fixed, and
 * each is pinned below, because each was measured and none is obvious.
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

describe('the ground a Monument is anchored on', () => {
  it('is the seam OR its spoil, so a worked-out seam still anchors one', () => {
    // The last of the three, and the one that cost the most to find. The
    // build order anchored on live ore (`nearestClaimableResource`), which
    // is right for a mine and wrong for the Monument: its own placement
    // rule counts a worked-out seam, so a seat that banked its whole seam
    // before it could pay lost the ANCHOR the tick the last load came up.
    // Measured on four seeds: the anchor went dark at the same tick the
    // gold stopped rising, and 3 of 8 seeds laid a monument. With the two
    // agreeing on what counts as ground, 6 of 8 did.
    const world = bareWorld();
    const i = 40 * world.map.size + 40;
    world.map.resource[i] = TileResource.GoldDep;
    world.map.resourceAmt[i] = 3;
    expect(nearestSeamGround(world.map, TileResource.GoldDep, 30, 30)).toBe(i);

    while (world.map.resource[i] === TileResource.GoldDep)
      depleteResourceTile(world, i);
    expect(world.map.resource[i]).toBe(TileResource.GoldSpoil);
    // A mine would find nothing here now — and that is correct, there is
    // nothing to dig. The Monument's anchor still sees the ground.
    expect(nearestSeamGround(world.map, TileResource.GoldDep, 30, 30)).toBe(i);
  });

  it('ignores a seam that is only spoil for a resource that leaves none', () => {
    // Only gold spoils; iron and silver clear to bare ground the way they
    // always did, and the anchor must not invent ground for them.
    const world = bareWorld();
    const i = 40 * world.map.size + 40;
    world.map.resource[i] = TileResource.IronDep;
    world.map.resourceAmt[i] = 2;
    expect(nearestSeamGround(world.map, TileResource.IronDep, 30, 30)).toBe(i);
    while (world.map.resource[i] === TileResource.IronDep)
      depleteResourceTile(world, i);
    expect(nearestSeamGround(world.map, TileResource.IronDep, 30, 30)).toBe(-1);
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
    let soldiers = 0;
    for (const u of world.units.values()) {
      if (!u.dead && u.owner === 0 && u.kind >= 3 && u.kind <= 5) soldiers++;
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
