import {describe, expect, it} from 'vitest';
import {tileX, tileY} from '../shared/grid.ts';
import * as CommandKind from './commandKindEnum.ts';
import {checkInvariants} from './debug/invariants.ts';
import {UNIT_DEFS} from './defs/units.ts';
import * as UnitTypeId from './defs/unitTypeIdEnum.ts';
import {BANDIT} from './entities.ts';
import {addStorehouse, bareWorld, cmds} from './testUtils.ts';
import {tickWorld} from './tick.ts';
import * as UnitTaskKind from './unitTaskKindEnum.ts';
import {spawnUnit, type World} from './world.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

/** The tile a fresh move order aimed this unit at — the end of its path. */
function goalOf(world: World, id: number): {x: number; y: number} {
  const path = world.units.get(id)!.path!;
  const goal = path[path.length - 1]!;
  return {x: tileX(goal, world.map.size), y: tileY(goal, world.map.size)};
}

/**
 * A mixed squad's move order is also a battle order: whatever the squad was
 * sent toward will be met front-first, so the destination tiles are dealt
 * out by arm — knights on the leading edge, archers behind them — rather
 * than by whatever order the ids happened to be selected in.
 */
describe('mixed squads form up by arm', () => {
  it('deals a squad sent east its tiles knight-first, archers rearmost', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const k1 = spawnUnit(world, UnitTypeId.knight, 0, 30.5, 29.5);
    const k2 = spawnUnit(world, UnitTypeId.knight, 0, 30.5, 30.5);
    const s1 = spawnUnit(world, UnitTypeId.spearman, 0, 30.5, 31.5);
    const a1 = spawnUnit(world, UnitTypeId.archer, 0, 30.5, 32.5);
    const a2 = spawnUnit(world, UnitTypeId.archer, 0, 30.5, 28.5);
    const f1 = spawnUnit(world, UnitTypeId.serf, 0, 30.5, 33.5);
    tickWorld(
      world,
      cmds({
        kind: CommandKind.moveUnits,
        // Deliberately shuffled: the formation must come from the sim, not
        // from the player happening to click the knights first.
        unitIds: [a1.id, k1.id, f1.id, s1.id, a2.id, k2.id],
        x: 40,
        y: 30,
      }),
    );

    // Front is east — the direction of the march — so the knights' goal
    // tiles sit at or ahead of the spearman's, the spearman's at or ahead
    // of the archers', and the serf files in at the very back.
    const knightRear = Math.min(goalOf(world, k1.id).x, goalOf(world, k2.id).x);
    const archerFront = Math.max(
      goalOf(world, a1.id).x,
      goalOf(world, a2.id).x,
    );
    const archerRear = Math.min(goalOf(world, a1.id).x, goalOf(world, a2.id).x);
    expect(knightRear).toBeGreaterThanOrEqual(goalOf(world, s1.id).x);
    expect(goalOf(world, s1.id).x).toBeGreaterThanOrEqual(archerFront);
    expect(archerRear).toBeGreaterThanOrEqual(goalOf(world, f1.id).x);
    // And the shield actually leads: strictly ahead of the archers.
    expect(knightRear).toBeGreaterThan(archerFront);
  });

  it('arrives with the knight between the march direction and the archer', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const archer = spawnUnit(world, UnitTypeId.archer, 0, 30.5, 29.5);
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 30.5, 30.5);
    tickWorld(
      world,
      cmds({
        kind: CommandKind.moveUnits,
        unitIds: [archer.id, knight.id], // archer selected first, still rear
        x: 40,
        y: 30,
      }),
    );
    run(world, 20 * 30);

    expect(knight.task.t).toBe(UnitTaskKind.idle);
    expect(archer.task.t).toBe(UnitTaskKind.idle);
    expect(knight.x).toBeGreaterThan(archer.x);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('an order into the squad itself rings the knights around the archers', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    // Around the click from all four sides: no march direction to face.
    const k1 = spawnUnit(world, UnitTypeId.knight, 0, 27.5, 30.5);
    const k2 = spawnUnit(world, UnitTypeId.knight, 0, 33.5, 30.5);
    const a1 = spawnUnit(world, UnitTypeId.archer, 0, 30.5, 27.5);
    const a2 = spawnUnit(world, UnitTypeId.archer, 0, 30.5, 33.5);
    tickWorld(
      world,
      cmds({
        kind: CommandKind.moveUnits,
        unitIds: [a1.id, a2.id, k1.id, k2.id],
        x: 30,
        y: 30,
      }),
    );

    // With no front the shield faces everywhere: every knight's goal stands
    // at least as far from the ordered tile as every archer's.
    const d2 = (id: number) => {
      const g = goalOf(world, id);
      return (g.x - 30) ** 2 + (g.y - 30) ** 2;
    };
    const knightInner = Math.min(d2(k1.id), d2(k2.id));
    const archerOuter = Math.max(d2(a1.id), d2(a2.id));
    expect(knightInner).toBeGreaterThanOrEqual(archerOuter);
  });

  it('marches at the slowest member’s pace, so the column holds together', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    // Knight 1.6 tiles/sec against spearman 2.4 and archer 2.0: uncapped,
    // the fast arms are tiles ahead within seconds of setting out.
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 5.5, 30.5);
    const spear = spawnUnit(world, UnitTypeId.spearman, 0, 5.5, 31.5);
    const archer = spawnUnit(world, UnitTypeId.archer, 0, 5.5, 29.5);
    tickWorld(
      world,
      cmds({
        kind: CommandKind.moveUnits,
        unitIds: [spear.id, archer.id, knight.id],
        x: 35,
        y: 30,
      }),
    );

    // The cap is written only where it binds: the knight IS the pace.
    expect(knight.marchSpeed).toBeUndefined();
    expect(spear.marchSpeed).toBe(UNIT_DEFS[UnitTypeId.knight].speed);
    expect(archer.marchSpeed).toBe(UNIT_DEFS[UnitTypeId.knight].speed);

    // Mid-march the column is a column. Uncapped, the spearman would be
    // four tiles ahead of the knight by now and the archer two.
    run(world, 150);
    expect(knight.task.t).toBe(UnitTaskKind.move); // still under way
    expect(Math.abs(spear.x - knight.x)).toBeLessThan(1.5);
    expect(Math.abs(archer.x - knight.x)).toBeLessThan(1.5);

    // Arrival hands every unit its own legs back.
    run(world, 20 * 30);
    for (const u of [knight, spear, archer]) {
      expect(u.task.t).toBe(UnitTaskKind.idle);
      expect(u.marchSpeed).toBeUndefined();
    }
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('a fight breaks the formation: engaged units run at true speeds', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 20.5, 30.5);
    const spear = spawnUnit(world, UnitTypeId.spearman, 0, 20.5, 31.5);
    spawnUnit(world, UnitTypeId.bandit, BANDIT, 30.5, 31.5);
    tickWorld(
      world,
      cmds({
        kind: CommandKind.moveUnits,
        unitIds: [knight.id, spear.id],
        x: 40,
        y: 31,
        attack: true,
      }),
    );
    expect(spear.marchSpeed).toBe(UNIT_DEFS[UnitTypeId.knight].speed);

    // Walk until the attack-move meets the bandit. The moment the spearman
    // holds a target, the squad pace is off him — the counter table prices
    // his chase at 2.4 tiles/sec, and a spearman held to knight pace never
    // catches what he exists to catch.
    for (let i = 0; i < 600 && spear.targetId === undefined; i++)
      tickWorld(world, []);
    expect(spear.targetId).toBeDefined();
    expect(spear.marchSpeed).toBeUndefined();
  });

  it('a solo order marches unmarked, at the unit’s own speed', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const archer = spawnUnit(world, UnitTypeId.archer, 0, 30.5, 30.5);
    tickWorld(
      world,
      cmds({kind: CommandKind.moveUnits, unitIds: [archer.id], x: 40, y: 30}),
    );
    expect(archer.marchSpeed).toBeUndefined();
  });

  it('a uniform squad is dealt its tiles exactly as before, selection order', () => {
    const world = bareWorld();
    addStorehouse(world, 50, 50, {});
    const u1 = spawnUnit(world, UnitTypeId.knight, 0, 30.5, 30.5);
    const u2 = spawnUnit(world, UnitTypeId.knight, 0, 30.5, 31.5);
    tickWorld(
      world,
      cmds({
        kind: CommandKind.moveUnits,
        unitIds: [u1.id, u2.id],
        x: 40,
        y: 30,
      }),
    );

    // The spiral deals nearest-first to the front of the id list; with no
    // mix of arms there is nothing to reorder.
    expect(goalOf(world, u1.id)).toEqual({x: 40, y: 30});
    expect(goalOf(world, u2.id)).toEqual({x: 39, y: 29});
  });
});
