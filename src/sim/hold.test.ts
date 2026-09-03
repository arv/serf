import {describe, expect, it} from 'vitest';
import * as CommandKind from './commandKindEnum.ts';
import {sanitizeCommand} from './commands.ts';
import {checkInvariants} from './debug/invariants.ts';
import {UNIT_DEFS} from './defs/units.ts';
import * as UnitTypeId from './defs/unitTypeIdEnum.ts';
import {addStorehouse, bareWorld, cmds} from './testUtils.ts';
import {tickWorld} from './tick.ts';
import type {Unit} from './units.ts';
import * as UnitTaskKind from './unitTaskKindEnum.ts';
import {spawnUnit, type World} from './world.ts';

/**
 * Hold ground: Warcraft's Hold Position. The whole promise is negative —
 * the man does not move — so most of what is checked here is that a
 * position stays put where the idle stance would have carried it off,
 * with the idle stance run beside it as the control.
 */

const MID = 24;

/**
 * Two human seats on a bare map, and a soldier of seat 0's at the middle.
 * Each seat gets a castle in a far corner: the storehouse is the
 * elimination token, and a seat without one is out on the first tick —
 * and an eliminated seat's orders are dropped at the door.
 */
function stand(kind: keyof typeof UNIT_DEFS): {world: World; man: Unit} {
  const world = bareWorld(7, 2);
  world.banditsEnabled = false;
  const far = world.map.size - 6;
  addStorehouse(world, 2, 2, {}, 0);
  addStorehouse(world, far, far, {}, 1);
  const man = spawnUnit(world, kind, 0, MID + 0.5, MID + 0.5);
  return {world, man};
}

function hold(world: World, ...ids: number[]): void {
  tickWorld(world, cmds({kind: CommandKind.holdGround, unitIds: ids}));
}

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

describe('the hold ground order', () => {
  it('puts a soldier in the hold stance where he stands, and drops his walk', () => {
    const {world, man} = stand(UnitTypeId.knight);
    // Send him off first, so there is a route to drop.
    tickWorld(
      world,
      cmds({
        kind: CommandKind.moveUnits,
        unitIds: [man.id],
        x: MID + 12,
        y: MID,
      }),
    );
    run(world, 5);
    expect(man.path).not.toBeNull();
    const x = man.x;
    const y = man.y;

    hold(world, man.id);

    expect(man.task).toEqual({t: UnitTaskKind.hold});
    expect(man.path).toBeNull();
    run(world, 40);
    expect(man.x).toBe(x);
    expect(man.y).toBe(y);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('skips civilians: a serf keeps his errand', () => {
    const {world} = stand(UnitTypeId.knight);
    const serf = spawnUnit(world, UnitTypeId.serf, 0, MID + 3.5, MID + 0.5);

    hold(world, serf.id);

    expect(serf.task.t).not.toBe(UnitTaskKind.hold);
  });

  it('refuses another seat’s man', () => {
    const {world} = stand(UnitTypeId.knight);
    const theirs = spawnUnit(world, UnitTypeId.knight, 1, MID + 3.5, MID + 0.5);

    hold(world, theirs.id);

    expect(theirs.task.t).not.toBe(UnitTaskKind.hold);
  });
});

describe('a soldier holding ground', () => {
  it('does not chase what an idle soldier would', () => {
    // A serf of the other seat, three tiles off: inside a knight's acquire
    // radius, well outside his reach. Idle, he walks over and cuts him
    // down; holding, he stays exactly where he is.
    const chase = (holding: boolean): number => {
      const {world, man} = stand(UnitTypeId.knight);
      const prey = spawnUnit(world, UnitTypeId.serf, 1, MID + 3.5, MID + 0.5);
      prey.task = {t: UnitTaskKind.idle, until: Number.MAX_SAFE_INTEGER};
      if (holding) hold(world, man.id);
      const x0 = man.x;
      run(world, 30);
      return Math.abs(man.x - x0);
    };
    expect(chase(false)).toBeGreaterThan(1);
    expect(chase(true)).toBe(0);
  });

  it('strikes what comes within reach, without stepping toward it', () => {
    const {world, man} = stand(UnitTypeId.archer);
    const range = UNIT_DEFS[UnitTypeId.archer].combat!.range;
    hold(world, man.id);
    // A spearman parked inside bow reach and told to stand still himself.
    const target = spawnUnit(
      world,
      UnitTypeId.spearman,
      1,
      MID + 0.5 + range - 1,
      MID + 0.5,
    );
    const hp = target.hp;
    const x = man.x;
    const y = man.y;

    run(world, 3);

    expect(man.targetId).toBe(target.id);
    expect(target.hp).toBeLessThan(hp);
    expect(man.x).toBe(x);
    expect(man.y).toBe(y);
    expect(man.task).toEqual({t: UnitTaskKind.hold});
  });

  it('does not kite: an archer holds his ground against a charge', () => {
    // The idle archer's shoot-and-scoot backs him away from a closing
    // spearman; held, he stands and looses at point blank.
    const {world, man} = stand(UnitTypeId.archer);
    hold(world, man.id);
    const spear = spawnUnit(
      world,
      UnitTypeId.spearman,
      1,
      MID + 3.5,
      MID + 0.5,
    );
    const x = man.x;
    const y = man.y;
    const hp = spear.hp;

    run(world, 40);

    expect(man.x).toBe(x);
    expect(man.y).toBe(y);
    expect(spear.hp).toBeLessThan(hp);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('lets a target go the moment it leaves his reach', () => {
    const {world, man} = stand(UnitTypeId.knight);
    hold(world, man.id);
    const foe = spawnUnit(world, UnitTypeId.serf, 1, MID + 1.3, MID + 0.5);
    foe.task = {t: UnitTaskKind.idle, until: Number.MAX_SAFE_INTEGER};
    run(world, 1);
    expect(man.targetId).toBe(foe.id);

    // Teleported out of reach (still inside the acquire radius he is not
    // using): dropped, not chased.
    foe.x = MID + 4.5;
    run(world, 1);

    expect(man.targetId).toBeUndefined();
    expect(man.path).toBeNull();
  });

  it('hits a wall he was told to hold at', () => {
    const {world, man} = stand(UnitTypeId.knight);
    // Their castle, its west face one tile east of him.
    const keep = addStorehouse(world, MID + 1, MID - 1, {}, 1);
    const hp = keep.hp;
    hold(world, man.id);

    run(world, 3);

    expect(man.targetId).toBe(keep.id);
    expect(man.targetIsBuilding).toBe(true);
    expect(keep.hp).toBeLessThan(hp);
    expect(man.path).toBeNull();
  });

  it('is released by any other order', () => {
    const {world, man} = stand(UnitTypeId.knight);
    hold(world, man.id);
    expect(man.task.t).toBe(UnitTaskKind.hold);

    tickWorld(
      world,
      cmds({
        kind: CommandKind.moveUnits,
        unitIds: [man.id],
        x: MID + 6,
        y: MID,
        attack: true,
      }),
    );
    expect(man.task.t).toBe(UnitTaskKind.attackMove);

    // And a focus order: naming a target is an order to go and fight it.
    hold(world, man.id);
    const foe = spawnUnit(world, UnitTypeId.knight, 1, MID + 5.5, MID + 0.5);
    tickWorld(
      world,
      cmds({
        kind: CommandKind.focusTarget,
        unitIds: [man.id],
        targetId: foe.id,
      }),
    );
    expect(man.task.t).not.toBe(UnitTaskKind.hold);
    expect(man.targetId).toBe(foe.id);
  });
});

describe('the hold ground order on the wire', () => {
  it('screens its unit list like a move order', () => {
    expect(
      sanitizeCommand({kind: CommandKind.holdGround, unitIds: [3, 4]}),
    ).toEqual({kind: CommandKind.holdGround, unitIds: [3, 4]});
    expect(sanitizeCommand({kind: CommandKind.holdGround})).toBeNull();
    expect(
      sanitizeCommand({kind: CommandKind.holdGround, unitIds: [3, 'x']}),
    ).toBeNull();
    expect(
      sanitizeCommand({kind: CommandKind.holdGround, unitIds: [1.5]}),
    ).toBeNull();
  });
});
