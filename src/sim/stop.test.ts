import {describe, expect, it} from 'vitest';
import * as CommandKind from './commandKindEnum.ts';
import {checkInvariants} from './debug/invariants.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as GoodId from './defs/goodIdEnum.ts';
import type {UNIT_DEFS} from './defs/units.ts';
import * as UnitTypeId from './defs/unitTypeIdEnum.ts';
import {addSerf, addSite, addStorehouse, bareWorld, cmds} from './testUtils.ts';
import {tickWorld} from './tick.ts';
import type {Unit} from './units.ts';
import * as UnitTaskKind from './unitTaskKindEnum.ts';
import {placeBuiltBuilding, spawnUnit, type World} from './world.ts';

/**
 * Stop: the order that ends an order. Everything it promises is about
 * what stops happening — the feet, the route behind the leg, the chase —
 * so most of what is checked here is a position that stays put and a
 * queue that is gone, with the orders it must NOT touch (an errand, a
 * hold) standing beside them as the controls.
 */

const MID = 24;

/** Seat 0's man at the middle of a two-seat valley, both keeps far off. */
function stand(kind: keyof typeof UNIT_DEFS): {world: World; man: Unit} {
  const world = bareWorld(7, 2);
  world.banditsEnabled = false;
  const far = world.map.size - 6;
  addStorehouse(world, 2, 2, {}, 0);
  addStorehouse(world, far, far, {}, 1);
  const man = spawnUnit(world, kind, 0, MID + 0.5, MID + 0.5);
  return {world, man};
}

function stop(world: World, ...ids: number[]): void {
  tickWorld(world, cmds({kind: CommandKind.stopUnits, unitIds: ids}));
}

function send(
  world: World,
  id: number,
  x: number,
  y: number,
  extra: {attack?: true | 'half'; queue?: true} = {},
): void {
  tickWorld(
    world,
    cmds({kind: CommandKind.moveUnits, unitIds: [id], x, y, ...extra}),
  );
}

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

describe('the stop order', () => {
  it('drops the march and leaves him standing where he is', () => {
    const {world, man} = stand(UnitTypeId.knight);
    send(world, man.id, MID + 12, MID);
    run(world, 5);
    expect(man.path).not.toBeNull();
    const x = man.x;
    const y = man.y;

    stop(world, man.id);

    // Idle and eligible at once — the stance a march ending would have
    // left him in, not a cooldown of its own.
    expect(man.task.t).toBe(UnitTaskKind.idle);
    expect(man.task).toHaveProperty('until');
    expect((man.task as {until: number}).until).toBeLessThanOrEqual(world.tick);
    expect(man.path).toBeNull();
    run(world, 40);
    expect(man.x).toBe(x);
    expect(man.y).toBe(y);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('ends an attack-move', () => {
    const {world, man} = stand(UnitTypeId.knight);
    send(world, man.id, MID + 12, MID, {attack: true});
    run(world, 5);
    expect(man.task.t).toBe(UnitTaskKind.attackMove);
    const x = man.x;

    stop(world, man.id);
    run(world, 40);

    expect(man.task.t).toBe(UnitTaskKind.idle);
    expect(man.x).toBe(x);
  });

  it('takes the route queued behind the leg he is walking with it', () => {
    const {world, man} = stand(UnitTypeId.knight);
    send(world, man.id, MID + 6, MID);
    send(world, man.id, MID + 12, MID, {queue: true});
    run(world, 5);
    expect(man.orders?.length).toBe(1);

    stop(world, man.id);
    // Long enough for the waypoint step to have handed him a next leg,
    // had one survived: "stop" is not "stop, then carry on".
    const x = man.x;
    run(world, 60);

    expect(man.orders).toBeUndefined();
    expect(man.task.t).toBe(UnitTaskKind.idle);
    expect(man.x).toBe(x);
  });

  it('calls off an assault on a building', () => {
    const {world, man} = stand(UnitTypeId.knight);
    // Their woodcutter, out east: a move onto it is the assault order.
    const hut = placeBuiltBuilding(
      world,
      BuildingTypeId.woodcutter,
      1,
      MID + 10,
      MID,
    );
    send(world, man.id, hut.x, hut.y);
    expect(man.task.t).toBe(UnitTaskKind.raid);

    stop(world, man.id);

    expect(man.task.t).toBe(UnitTaskKind.idle);
    expect(man.targetId).toBeUndefined();
    expect(man.targetIsBuilding).toBeUndefined();
  });

  it('takes a civilian’s walk too', () => {
    const {world} = stand(UnitTypeId.knight);
    const serf = spawnUnit(world, UnitTypeId.serf, 0, MID + 3.5, MID + 0.5);
    send(world, serf.id, MID + 12, MID);
    run(world, 5);
    expect(serf.path).not.toBeNull();
    const x = serf.x;

    stop(world, serf.id);

    expect(serf.task.t).toBe(UnitTaskKind.idle);
    expect(serf.path).toBeNull();
    expect(serf.x).toBe(x);
  });

  it('leaves an errand alone: a hauling serf keeps his job', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {[GoodId.wood]: 5});
    addSite(world, 40, 40); // a site wanting wood puts a job on the board
    const serf = addSerf(world, 31, 33);
    for (let i = 0; i < 600 && serf.jobId === undefined; i++) {
      tickWorld(world, []);
    }
    expect(serf.task.t).toBe(UnitTaskKind.haul);
    const job = serf.jobId;

    stop(world, serf.id);

    expect(serf.task.t).toBe(UnitTaskKind.haul);
    expect(serf.jobId).toBe(job);
    expect(serf.path).not.toBeNull();
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('leaves a soldier holding ground holding', () => {
    const {world, man} = stand(UnitTypeId.knight);
    tickWorld(world, cmds({kind: CommandKind.holdGround, unitIds: [man.id]}));
    expect(man.task.t).toBe(UnitTaskKind.hold);

    stop(world, man.id);

    expect(man.task.t).toBe(UnitTaskKind.hold);
  });

  it('refuses another seat’s man', () => {
    const {world} = stand(UnitTypeId.knight);
    const theirs = spawnUnit(world, UnitTypeId.knight, 1, MID + 3.5, MID + 0.5);
    theirs.task = {t: UnitTaskKind.move};

    stop(world, theirs.id);

    expect(theirs.task.t).toBe(UnitTaskKind.move);
  });
});

describe('a soldier who has stopped', () => {
  it('still answers an enemy that comes within reach — this is not a hold', () => {
    // The hold's chase test, run the other way round: a stopped man is an
    // idle man, so the serf three tiles off is his to cut down.
    const {world, man} = stand(UnitTypeId.knight);
    const prey = spawnUnit(world, UnitTypeId.serf, 1, MID + 3.5, MID + 0.5);
    prey.task = {t: UnitTaskKind.idle, until: Number.MAX_SAFE_INTEGER};
    send(world, man.id, MID, MID + 12);
    run(world, 3);

    stop(world, man.id);
    const x0 = man.x;
    run(world, 30);

    expect(Math.abs(man.x - x0)).toBeGreaterThan(1);
  });
});
