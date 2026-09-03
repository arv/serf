import {describe, expect, it} from 'vitest';
import * as CommandKind from './commandKindEnum.ts';
import {checkInvariants} from './debug/invariants.ts';
import * as UnitTypeId from './defs/unitTypeIdEnum.ts';
import {BANDIT} from './entities.ts';
import {hashWorld} from './hash.ts';
import {deserializeWorld, serializeWorld} from './save.ts';
import {addSerf, addStorehouse, bareWorld, cmds} from './testUtils.ts';
import {tickWorld} from './tick.ts';
import type {Unit} from './units.ts';
import * as UnitTaskKind from './unitTaskKindEnum.ts';
import {spawnUnit, type World} from './world.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

/** The patrol order, as the client sends it: P-click, or Shift-P-click. */
function patrol(
  world: World,
  unitIds: number[],
  x: number,
  y: number,
  queue = false,
): void {
  tickWorld(
    world,
    cmds({
      kind: CommandKind.moveUnits,
      unitIds,
      x,
      y,
      patrol: true,
      ...(queue ? {queue: true as const} : {}),
    }),
  );
}

/**
 * The spots a unit stands on over the next `ticks`, out of the ones
 * named, each logged once as it is reached (consecutive repeats folded).
 */
function visits(
  world: World,
  unit: Unit,
  spots: readonly {x: number; y: number}[],
  ticks: number,
): string[] {
  const out: string[] = [];
  const log = (): void => {
    const x = Math.floor(unit.x);
    const y = Math.floor(unit.y);
    if (!spots.some(s => s.x === x && s.y === y)) return;
    const key = `${x},${y}`;
    if (out.at(-1) !== key) out.push(key);
  };
  log();
  for (let i = 0; i < ticks; i++) {
    tickWorld(world, []);
    log();
  }
  return out;
}

const beat = (x: number, y: number) =>
  ({x, y, attack: true, patrol: true}) as const;
const home = (x: number, y: number) =>
  ({x, y, attack: true, patrol: true, home: true}) as const;

/**
 * A beat walked round and round. Knights, with the storehouse that keeps
 * the seat alive, for the reasons waypoints.test.ts gives.
 */
describe('the patrol', () => {
  it('walks there and back, and there again, and never ends on its own', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 10.5, 10.5);
    patrol(world, [knight.id], 20, 10);
    // Set out at once, as a live attack-move, with the way home behind it
    // — the far end is already on the road, so the route is home, there.
    expect(knight.task).toMatchObject({
      t: UnitTaskKind.attackMove,
      destX: 20,
      destY: 10,
    });
    expect(knight.orders).toEqual([home(10, 10), beat(20, 10)]);

    const ends = [
      {x: 10, y: 10},
      {x: 20, y: 10},
    ];
    expect(visits(world, knight, ends, 20 * 60).slice(0, 5)).toEqual([
      '10,10',
      '20,10',
      '10,10',
      '20,10',
      '10,10',
    ]);
    expect(knight.task.t).toBe(UnitTaskKind.attackMove);
    expect(knight.orders).toHaveLength(2);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('fights what it meets on the beat, then walks on', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 10.5, 10.5);
    patrol(world, [knight.id], 20, 10);
    run(world, 20 * 3);
    const bandit = spawnUnit(world, UnitTypeId.bandit, BANDIT, 15.5, 12.5);
    for (let i = 0; i < 20 * 60 && !bandit.dead; i++) tickWorld(world, []);
    expect(bandit.dead).toBe(true);
    expect(knight.dead).toBe(false);
    // The fight consumed the leg, not the beat: he was still on his way
    // out, so the way home is still ahead of him, and he reaches both
    // ends again.
    expect(knight.orders).toEqual([home(10, 10), beat(20, 10)]);
    const seen = new Set(
      visits(
        world,
        knight,
        [
          {x: 10, y: 10},
          {x: 20, y: 10},
        ],
        20 * 60,
      ),
    );
    expect(seen).toEqual(new Set(['10,10', '20,10']));
  });

  it('brings a squad back to its own spots, not to one tile', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const ids = [0, 1, 2].map(
      i => spawnUnit(world, UnitTypeId.knight, 0, 10.5, 10.5 + i).id,
    );
    patrol(world, ids, 20, 11);
    const homes = ids.map(id => world.units.get(id)!.orders![0]!);
    const fars = ids.map(id => world.units.get(id)!.orders![1]!);
    // Each man's way home is the tile he stood on; his far end is his
    // own tile of the spread — three of each, no two alike.
    expect(homes.map(h => `${h.x},${h.y}`).sort()).toEqual([
      '10,10',
      '10,11',
      '10,12',
    ]);
    expect(new Set(fars.map(f => `${f.x},${f.y}`)).size).toBe(3);
    // A squad marches at its slowest member's pace both ways — knights
    // all, so no cap binds and none is dealt.
    for (const wp of [...homes, ...fars]) expect(wp.pace).toBeUndefined();
  });

  it('adds a spot to the beat with Shift', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 10.5, 10.5);
    patrol(world, [knight.id], 20, 10);
    patrol(world, [knight.id], 20, 20, true);
    expect(knight.orders).toEqual([beat(20, 20), home(10, 10), beat(20, 10)]);

    // Three spots, walked round in the order they were given, home last:
    // there, the new one, home, there again.
    const spots = [
      {x: 10, y: 10},
      {x: 20, y: 10},
      {x: 20, y: 20},
    ];
    expect(visits(world, knight, spots, 20 * 90).slice(0, 6)).toEqual([
      '10,10',
      '20,10',
      '20,20',
      '10,10',
      '20,10',
      '20,20',
    ]);
  });

  it('keeps the spots in the order they were given, home last', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 10.5, 10.5);
    patrol(world, [knight.id], 20, 10);
    // Two more spots clicked in quick succession, while he is still on
    // the first leg: the beat is drawn there, C, D, home — not there, D,
    // C, home, which is what slotting each new spot in next would give.
    patrol(world, [knight.id], 20, 20, true);
    patrol(world, [knight.id], 10, 20, true);
    expect(knight.orders).toEqual([
      beat(20, 20),
      beat(10, 20),
      home(10, 10),
      beat(20, 10),
    ]);
    const spots = [
      {x: 10, y: 10},
      {x: 20, y: 10},
      {x: 20, y: 20},
      {x: 10, y: 20},
    ];
    expect(visits(world, knight, spots, 20 * 90).slice(0, 6)).toEqual([
      '10,10',
      '20,10',
      '20,20',
      '10,20',
      '10,10',
      '20,10',
    ]);
  });

  it('starts a beat from the end of a plain route with Shift', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 10.5, 10.5);
    tickWorld(
      world,
      cmds({kind: CommandKind.moveUnits, unitIds: [knight.id], x: 20, y: 10}),
    );
    patrol(world, [knight.id], 20, 20, true);
    // Home is where the route ends, not where he stands now; the far end
    // leads once the route is walked.
    expect(knight.task.t).toBe(UnitTaskKind.move);
    expect(knight.orders).toEqual([beat(20, 20), home(20, 10)]);

    const spots = [
      {x: 10, y: 10},
      {x: 20, y: 10},
      {x: 20, y: 20},
    ];
    expect(visits(world, knight, spots, 20 * 90).slice(0, 5)).toEqual([
      '10,10',
      '20,10',
      '20,20',
      '20,10',
      '20,20',
    ]);
  });

  it('ends on a fresh order, and on a hold', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 10.5, 10.5);
    patrol(world, [knight.id], 20, 10);
    run(world, 20 * 2);
    tickWorld(
      world,
      cmds({kind: CommandKind.moveUnits, unitIds: [knight.id], x: 30, y: 10}),
    );
    expect(knight.task.t).toBe(UnitTaskKind.move);
    expect(knight.orders).toBeUndefined();
    run(world, 20 * 30);
    expect(Math.floor(knight.x)).toBe(30);
    expect(knight.task.t).toBe(UnitTaskKind.idle);

    patrol(world, [knight.id], 40, 10);
    run(world, 20 * 2);
    tickWorld(
      world,
      cmds({kind: CommandKind.holdGround, unitIds: [knight.id]}),
    );
    expect(knight.task.t).toBe(UnitTaskKind.hold);
    expect(knight.orders).toBeUndefined();
    run(world, 20 * 10);
    expect(knight.task.t).toBe(UnitTaskKind.hold);
  });

  it('walks a plain waypoint queued onto the beat once, then carries on', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 10.5, 10.5);
    patrol(world, [knight.id], 20, 10);
    tickWorld(
      world,
      cmds({
        kind: CommandKind.moveUnits,
        unitIds: [knight.id],
        x: 15,
        y: 15,
        queue: true,
      }),
    );
    expect(knight.orders).toEqual([home(10, 10), beat(20, 10), {x: 15, y: 15}]);
    const spots = [
      {x: 10, y: 10},
      {x: 20, y: 10},
      {x: 15, y: 15},
    ];
    // Its turn comes after a full round, it is spent, and the beat is
    // two legs again.
    expect(visits(world, knight, spots, 20 * 120).slice(0, 7)).toEqual([
      '10,10',
      '20,10',
      '10,10',
      '20,10',
      '15,15',
      '10,10',
      '20,10',
    ]);
    expect(knight.orders).toHaveLength(2);
    expect(knight.orders!.every(wp => wp.patrol)).toBe(true);
  });

  it('is a walk for a civilian — there is nothing to fight with', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const serf = addSerf(world, 10, 10);
    patrol(world, [serf.id], 20, 10);
    expect(serf.task.t).toBe(UnitTaskKind.move);
    expect(serf.orders).toBeUndefined();
  });

  it('is no beat at all when the far end has nowhere to walk', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 10.5, 10.5);
    tickWorld(
      world,
      cmds({kind: CommandKind.moveUnits, unitIds: [knight.id], x: 12, y: 10}),
    );
    // Way off the map: the spread finds no tile, so the leg is dropped —
    // and a beat with one end is dropped with it. The walk in hand stays.
    patrol(world, [knight.id], -40, -40);
    expect(knight.task.t).toBe(UnitTaskKind.move);
    expect(knight.orders).toBeUndefined();
  });

  it('breaks the beat when an end is sealed off, and keeps what was queued behind it', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 10.5, 10.5);
    patrol(world, [knight.id], 62, 62);
    tickWorld(
      world,
      cmds({
        kind: CommandKind.moveUnits,
        unitIds: [knight.id],
        x: 10,
        y: 20,
        queue: true,
      }),
    );
    // A ring of wall round the far end, closed while he is on his way
    // (the same fixture waypoints.test.ts uses): the tile inside is open
    // ground and no route reaches it.
    run(world, 20 * 2);
    const size = world.map.size;
    for (let x = 61; x <= 63; x++)
      for (let y = 61; y <= 63; y++)
        if (x !== 62 || y !== 62) world.map.blocked[y * size + x] = 1;
    // The leg in hand is re-planned by movement, fails, and the walk ends
    // idle; the beat's other end is dropped with the sealed one, and the
    // plain leg behind them is walked instead.
    let guard = 20 * 120;
    while (knight.orders?.some(wp => wp.patrol) && guard-- > 0)
      tickWorld(world, []);
    expect(knight.orders?.some(wp => wp.patrol) ?? false).toBe(false);
    guard = 20 * 120;
    while (knight.task.t !== UnitTaskKind.idle && guard-- > 0)
      tickWorld(world, []);
    expect(Math.floor(knight.x)).toBe(10);
    expect(Math.floor(knight.y)).toBe(20);
    expect(knight.orders).toBeUndefined();
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('survives a save, and is part of the digest', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 10.5, 10.5);
    patrol(world, [knight.id], 20, 10);
    run(world, 5);
    const before = hashWorld(world);
    const loaded = deserializeWorld(serializeWorld(world));
    expect(hashWorld(loaded)).toBe(before);
    expect(loaded.units.get(knight.id)!.orders).toEqual([
      home(10, 10),
      beat(20, 10),
    ]);

    // The same route, spent leg by leg instead of coming round: not the
    // same world.
    for (const wp of knight.orders!) delete wp.patrol;
    expect(hashWorld(world)).not.toBe(before);

    // And the loaded one still walks its beat.
    const seen = new Set(
      visits(
        loaded,
        loaded.units.get(knight.id)!,
        [
          {x: 10, y: 10},
          {x: 20, y: 10},
        ],
        20 * 60,
      ),
    );
    expect(seen).toEqual(new Set(['10,10', '20,10']));
  });
});
