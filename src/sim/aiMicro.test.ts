import {describe, expect, it} from 'vitest';
import {AiSeats} from './aiSeats.ts';
import * as CommandKind from './commandKindEnum.ts';
import {sanitizeCommand} from './commands.ts';
import * as AiStrategyId from './defs/aiStrategyIdEnum.ts';
import * as DifficultyId from './defs/difficultyEnum.ts';
import {UNIT_DEFS} from './defs/units.ts';
import * as UnitTypeId from './defs/unitTypeIdEnum.ts';
import * as PlayerKind from './playerKindEnum.ts';
import {ALL_WAR_BEHAVIORS, WAR_BEHAVIOR_KEYS} from './systems/ai.ts';
import {tickWorld} from './tick.ts';
import * as UnitTaskKind from './unitTaskKindEnum.ts';
import {createWorld, spawnUnit, type World} from './world.ts';

/**
 * Micro — focus fire and pulling the wounded out — as a capability only
 * `hard` is granted (Difficulty.micro).
 *
 * The order that names a target is new surface, and the sim re-checks
 * every command whether it came from a click, a brain or a socket, so the
 * checks are tested from the wire side too: an order naming your own
 * soldier, or a corpse, must change nothing.
 */

/** Two seats nose to nose, with a small fight already joined. */
function skirmish(
  difficulty?: (typeof DifficultyId)[keyof typeof DifficultyId],
): {
  world: World;
  mine: number[];
  theirs: number[];
} {
  const world = createWorld({
    seed: 11,
    mapSize: 64,
    banditsEnabled: false,
    ...(difficulty ? {difficulty} : {}),
    players: [
      {kind: PlayerKind.ai, strategy: AiStrategyId.steward},
      {kind: PlayerKind.ai, strategy: AiStrategyId.steward},
    ],
  });
  const mid = Math.floor(world.map.size / 2);
  const mine: number[] = [];
  const theirs: number[] = [];
  for (let i = 0; i < 4; i++) {
    mine.push(spawnUnit(world, UnitTypeId.spearman, 0, mid + i * 0.6, mid).id);
    theirs.push(
      spawnUnit(world, UnitTypeId.spearman, 1, mid + i * 0.6, mid + 1.2).id,
    );
  }
  return {world, mine, theirs};
}

describe('the war-behavior roster', () => {
  it('lists every behavior the enum declares', () => {
    // ALL_WAR_BEHAVIORS is a hand-written array, so nothing in the type
    // system notices an id left out of it — and `#warOn` refuses anything
    // missing, which silently disables the behavior rather than failing.
    // Both micro verbs shipped switched off for exactly one commit that
    // way. WAR_BEHAVIOR_KEYS is an exhaustive Record and the compiler DOES
    // hold it, so it is the honest roll call to check the array against.
    const byId = (a: number, b: number): number => a - b;
    expect([...ALL_WAR_BEHAVIORS].sort(byId)).toEqual(
      Object.keys(WAR_BEHAVIOR_KEYS).map(Number).sort(byId),
    );
  });
});

describe('the focusTarget order', () => {
  it('puts named soldiers on one enemy', () => {
    const {world, mine, theirs} = skirmish();
    tickWorld(world, []); // let the sim acquire naturally first
    const victim = theirs[2]!;
    tickWorld(world, [
      {
        playerId: 0,
        cmd: {kind: CommandKind.focusTarget, unitIds: mine, targetId: victim},
      },
    ]);
    for (const id of mine) {
      const u = world.units.get(id)!;
      // A soldier walking under a plain move is left alone by design — the
      // combat system disengages those before it looks at targets at all.
      if (u.task.t === UnitTaskKind.move) continue;
      expect(u.targetIsBuilding).toBe(false);
      expect(u.targetId).toBe(victim);
    }
  });

  it('refuses an order naming your own man, or a dead one', () => {
    const {world, mine, theirs} = skirmish();
    tickWorld(world, []);
    const before = mine.map(id => world.units.get(id)!.targetId);
    // Your own soldier is not a target.
    tickWorld(world, [
      {
        playerId: 0,
        cmd: {kind: CommandKind.focusTarget, unitIds: mine, targetId: mine[1]!},
      },
    ]);
    expect(mine.map(id => world.units.get(id)!.targetId)).toEqual(before);
    // Nor is a corpse.
    const corpse = world.units.get(theirs[0]!)!;
    corpse.dead = true;
    tickWorld(world, [
      {
        playerId: 0,
        cmd: {
          kind: CommandKind.focusTarget,
          unitIds: mine,
          targetId: corpse.id,
        },
      },
    ]);
    for (const id of mine) {
      expect(world.units.get(id)!.targetId).not.toBe(corpse.id);
    }
  });

  it('cannot be used to order somebody else’s soldiers', () => {
    const {world, theirs} = skirmish();
    tickWorld(world, []);
    const before = theirs.map(id => world.units.get(id)!.targetId);
    // Seat 0 naming seat 1's men: every one of them is skipped on owner.
    tickWorld(world, [
      {
        playerId: 0,
        cmd: {
          kind: CommandKind.focusTarget,
          unitIds: theirs,
          targetId: theirs[0]!,
        },
      },
    ]);
    expect(theirs.map(id => world.units.get(id)!.targetId)).toEqual(before);
  });

  it('survives the wire the way every other order does', () => {
    const good = sanitizeCommand({
      kind: CommandKind.focusTarget,
      unitIds: [1, 2],
      targetId: 3,
    });
    expect(good).toEqual({
      kind: CommandKind.focusTarget,
      unitIds: [1, 2],
      targetId: 3,
    });
    // Shape here, existence at the door: an id that names nothing is let
    // through exactly as `moveUnits` lets one through, and the apply step
    // drops it when the lookup misses. Every command in this file draws
    // the line in the same place.
    expect(
      sanitizeCommand({
        kind: CommandKind.focusTarget,
        unitIds: [1],
        targetId: -1,
      }),
    ).not.toBeNull();
    expect(
      sanitizeCommand({
        kind: CommandKind.focusTarget,
        unitIds: 'all',
        targetId: 3,
      }),
    ).toBeNull();
    expect(
      sanitizeCommand({
        kind: CommandKind.focusTarget,
        unitIds: [1.5],
        targetId: 3,
      }),
    ).toBeNull();
  });
});

describe('micro as a tier capability', () => {
  /** Play a seat's brain over a joined fight and collect what it orders. */
  const ordersOver = (
    difficulty: (typeof DifficultyId)[keyof typeof DifficultyId] | undefined,
    hurt: boolean,
  ): number[] => {
    const {world, mine} = skirmish(difficulty);
    const seats = new AiSeats(world);
    if (hurt) {
      // One man on his last legs, the rest hale — the shape withdrawWounded
      // exists for, and never more than half the line.
      const u = world.units.get(mine[0]!)!;
      u.hp = Math.ceil(UNIT_DEFS[u.kind].hp * 0.2);
    }
    const kinds: number[] = [];
    for (let t = 0; t < 200; t++) {
      const cmds = seats.decide(world);
      for (const c of cmds) if (c.playerId === 0) kinds.push(c.cmd.kind);
      tickWorld(world, cmds);
    }
    return kinds;
  };

  it('only hard gives a focus order', () => {
    expect(ordersOver(DifficultyId.hard, false)).toContain(
      CommandKind.focusTarget,
    );
    // Normal and easy run the pre-micro brain exactly: no such order exists
    // for them, at any point in the fight.
    expect(ordersOver(DifficultyId.normal, false)).not.toContain(
      CommandKind.focusTarget,
    );
    expect(ordersOver(DifficultyId.easy, false)).not.toContain(
      CommandKind.focusTarget,
    );
    expect(ordersOver(undefined, false)).not.toContain(CommandKind.focusTarget);
  });

  it('counts what it did, so a verb that never fires is visible', () => {
    const {world, mine} = skirmish(DifficultyId.hard);
    const seats = new AiSeats(world);
    const u = world.units.get(mine[0]!)!;
    u.hp = Math.ceil(UNIT_DEFS[u.kind].hp * 0.2);
    for (let t = 0; t < 200; t++) tickWorld(world, seats.decide(world));
    const report = seats.brainFor(0)!.warReport();
    expect(report.focused).toBeGreaterThan(0);
  });
});
