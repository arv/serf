import {describe, expect, it} from 'vitest';
import * as CommandKind from './commandKindEnum.ts';
import type {SimCommand} from './commands.ts';
import {checkInvariants} from './debug/invariants.ts';
import {WAYPOINT_QUEUE_CAP} from './defs/balance.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as UnitTypeId from './defs/unitTypeIdEnum.ts';
import {hashWorld} from './hash.ts';
import {deserializeWorld, serializeWorld} from './save.ts';
import {addSerf, addStorehouse, bareWorld, cmds} from './testUtils.ts';
import {tickWorld} from './tick.ts';
import * as UnitTaskKind from './unitTaskKindEnum.ts';
import {placeBuiltBuilding, spawnUnit, type World} from './world.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

/** Tick until the unit stands idle, or the guard runs out. */
function walkOut(world: World, id: number, guard = 20 * 60): number {
  let ticks = 0;
  while (world.units.get(id)!.task.t !== UnitTaskKind.idle && ticks++ < guard) {
    tickWorld(world, []);
  }
  return ticks;
}

/** Tick until the condition holds, or the guard runs out. */
function until(world: World, cond: () => boolean, guard = 20 * 60): boolean {
  for (let i = 0; i < guard; i++) {
    if (cond()) return true;
    tickWorld(world, []);
  }
  return cond();
}

function tileOf(world: World, id: number): {x: number; y: number} {
  const u = world.units.get(id)!;
  return {x: Math.floor(u.x), y: Math.floor(u.y)};
}

/**
 * The Shift-click route: legs queued behind the order being walked, taken
 * in turn. Knights rather than serfs, so an idle beat between legs cannot
 * be a stroll — and the storehouse is the elimination token, without which
 * the seat is dead and every order refused.
 */
describe('queued waypoints', () => {
  it('walks the legs in the order they were given, then stands', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 10.5, 10.5);
    tickWorld(
      world,
      cmds(
        {kind: CommandKind.moveUnits, unitIds: [knight.id], x: 20, y: 10},
        {
          kind: CommandKind.moveUnits,
          unitIds: [knight.id],
          x: 20,
          y: 20,
          queue: true,
        },
        {
          kind: CommandKind.moveUnits,
          unitIds: [knight.id],
          x: 10,
          y: 20,
          queue: true,
        },
      ),
    );
    expect(knight.task.t).toBe(UnitTaskKind.move);
    expect(knight.orders).toEqual([
      {x: 20, y: 20},
      {x: 10, y: 20},
    ]);

    // The first leg is walked to its end before the second begins: the
    // knight is never seen heading south before he has reached x=20.
    while (Math.floor(knight.x) < 20) {
      expect(knight.y).toBeCloseTo(10.5, 3);
      tickWorld(world, []);
    }
    walkOut(world, knight.id);
    expect(tileOf(world, knight.id)).toEqual({x: 10, y: 20});
    expect(knight.orders).toBeUndefined();
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('takes a queued order at once when there is nothing to wait behind', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 10.5, 10.5);
    tickWorld(
      world,
      cmds({
        kind: CommandKind.moveUnits,
        unitIds: [knight.id],
        x: 20,
        y: 10,
        queue: true,
      }),
    );
    expect(knight.task.t).toBe(UnitTaskKind.move);
    expect(knight.orders).toBeUndefined();
  });

  it('drops the whole route on a fresh order', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 10.5, 10.5);
    tickWorld(
      world,
      cmds(
        {kind: CommandKind.moveUnits, unitIds: [knight.id], x: 20, y: 10},
        {
          kind: CommandKind.moveUnits,
          unitIds: [knight.id],
          x: 20,
          y: 20,
          queue: true,
        },
      ),
    );
    run(world, 5);
    tickWorld(
      world,
      cmds({kind: CommandKind.moveUnits, unitIds: [knight.id], x: 10, y: 15}),
    );
    expect(knight.orders).toBeUndefined();
    walkOut(world, knight.id);
    expect(tileOf(world, knight.id)).toEqual({x: 10, y: 15});
  });

  it('keeps the kind of order each leg was given', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 10.5, 10.5);
    tickWorld(
      world,
      cmds(
        {kind: CommandKind.moveUnits, unitIds: [knight.id], x: 12, y: 10},
        {
          kind: CommandKind.moveUnits,
          unitIds: [knight.id],
          x: 12,
          y: 20,
          attack: true,
          queue: true,
        },
      ),
    );
    // The second leg goes out as the attack-move it was queued as, aimed
    // where it was told.
    expect(until(world, () => knight.task.t === UnitTaskKind.attackMove)).toBe(
      true,
    );
    expect(knight.task).toMatchObject({
      t: UnitTaskKind.attackMove,
      destX: 12,
      destY: 20,
    });
  });

  it('skips a leg that cannot be walked and carries on to the next', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 10.5, 10.5);
    // A leg into the far corner, walled off before it comes due.
    tickWorld(
      world,
      cmds(
        {kind: CommandKind.moveUnits, unitIds: [knight.id], x: 12, y: 10},
        {
          kind: CommandKind.moveUnits,
          unitIds: [knight.id],
          x: 62,
          y: 62,
          queue: true,
        },
        {
          kind: CommandKind.moveUnits,
          unitIds: [knight.id],
          x: 10,
          y: 20,
          queue: true,
        },
      ),
    );
    // A ring of wall round the clicked tile: the one inside is open ground
    // the spread will happily aim at, and no route reaches it.
    const size = world.map.size;
    for (let x = 61; x <= 63; x++)
      for (let y = 61; y <= 63; y++)
        if (x !== 62 || y !== 62) world.map.blocked[y * size + x] = 1;
    walkOut(world, knight.id, 20 * 120);
    expect(tileOf(world, knight.id)).toEqual({x: 10, y: 20});
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('holds at most the cap, dropping what comes after', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 10.5, 10.5);
    const orders: SimCommand[] = [
      {kind: CommandKind.moveUnits, unitIds: [knight.id], x: 20, y: 10},
    ];
    for (let i = 0; i < WAYPOINT_QUEUE_CAP + 3; i++) {
      orders.push({
        kind: CommandKind.moveUnits,
        unitIds: [knight.id],
        x: 20 + i,
        y: 20,
        queue: true,
      });
    }
    tickWorld(world, cmds(...orders));
    expect(knight.orders).toHaveLength(WAYPOINT_QUEUE_CAP);
    expect(knight.orders![0]).toEqual({x: 20, y: 20});
    expect(knight.orders!.at(-1)).toEqual({
      x: 20 + WAYPOINT_QUEUE_CAP - 1,
      y: 20,
    });
  });

  it('sends a squad that came due together as one group', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const a = spawnUnit(world, UnitTypeId.knight, 0, 10.5, 10.5);
    const b = spawnUnit(world, UnitTypeId.knight, 0, 10.5, 11.5);
    tickWorld(
      world,
      cmds(
        {kind: CommandKind.moveUnits, unitIds: [a.id, b.id], x: 14, y: 11},
        {
          kind: CommandKind.moveUnits,
          unitIds: [a.id, b.id],
          x: 14,
          y: 30,
          queue: true,
        },
      ),
    );
    // Each man carries his own tile of the spread from the moment the leg
    // is queued — they will not come due together, so it cannot be dealt then.
    expect(a.orders![0]).not.toEqual(b.orders![0]);
    walkOut(world, a.id);
    walkOut(world, b.id);
    // Two men, two tiles: the group spread, not both on the tile clicked.
    const ta = tileOf(world, a.id);
    const tb = tileOf(world, b.id);
    expect(ta).not.toEqual(tb);
    expect(Math.abs(ta.x - 14) + Math.abs(ta.y - 30)).toBeLessThanOrEqual(2);
    expect(Math.abs(tb.x - 14) + Math.abs(tb.y - 30)).toBeLessThanOrEqual(2);
  });

  it('becomes the assault it would have been, when the leg lands on a camp', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const camp = placeBuiltBuilding(
      world,
      BuildingTypeId.banditCamp,
      1,
      30,
      10,
    );
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 10.5, 10.5);
    tickWorld(
      world,
      cmds(
        {kind: CommandKind.moveUnits, unitIds: [knight.id], x: 12, y: 10},
        {
          kind: CommandKind.moveUnits,
          unitIds: [knight.id],
          x: camp.x + 1,
          y: camp.y + 1,
          queue: true,
        },
      ),
    );
    walkOut(world, knight.id, 20 * 10);
    expect(knight.task).toEqual({t: UnitTaskKind.raid, buildingId: camp.id});
    expect(knight.targetId).toBe(camp.id);
  });

  it('waits behind a serf’s errand no more than it would have anyway', () => {
    // A serf with a job is not under an order: the queued click drops the
    // errand and goes now, the way the unshifted click always has.
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const serf = addSerf(world, 10, 10);
    tickWorld(
      world,
      cmds({
        kind: CommandKind.moveUnits,
        unitIds: [serf.id],
        x: 20,
        y: 10,
        queue: true,
      }),
    );
    expect(serf.task.t).toBe(UnitTaskKind.move);
    expect(serf.orders).toBeUndefined();
  });

  it('survives a save, and is part of the digest', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 10.5, 10.5);
    tickWorld(
      world,
      cmds(
        {kind: CommandKind.moveUnits, unitIds: [knight.id], x: 20, y: 10},
        {
          kind: CommandKind.moveUnits,
          unitIds: [knight.id],
          x: 20,
          y: 20,
          queue: true,
        },
      ),
    );
    run(world, 5);
    const before = hashWorld(world);
    const loaded = deserializeWorld(serializeWorld(world));
    expect(hashWorld(loaded)).toBe(before);
    expect(loaded.units.get(knight.id)!.orders).toEqual([{x: 20, y: 20}]);

    // Same men, same tiles, one route still to walk: not the same world.
    knight.orders = undefined;
    expect(hashWorld(world)).not.toBe(before);

    walkOut(loaded, knight.id);
    expect(tileOf(loaded, knight.id)).toEqual({x: 20, y: 20});
  });
});
