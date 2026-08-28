import { describe, expect, it } from 'vitest';
import { levyOrder } from './levy';
import { snapBuilding } from '../protocol/snapshot.ts';
import { tickWorld } from '../sim/tick.ts';
import { placeBuiltBuilding, placeSite, spawnUnit } from '../sim/world.ts';
import { BUILDING_DEFS } from '../sim/defs/buildings.ts';
import { addSerf, addStorehouse, bareWorld, cmds } from '../sim/testUtils.ts';
import * as BuildingTypeId from '../sim/defs/buildingTypeIdEnum.ts';
import * as UnitTypeId from '../sim/defs/unitTypeIdEnum.ts';
import * as CommandKind from '../sim/commandKindEnum.ts';

const CAP = BUILDING_DEFS[BuildingTypeId.guardTower].garrison!.capacity;

/**
 * The card's halt lever on a tower is the manning of it, and the words on it
 * have to be that — a tower manned by archers and shooting once a second
 * used to read "· paused" over a button that, pressed either way, moved
 * nobody. The sim is the authority on what the lever does, so these read the
 * real roof through the real snapshot rather than a hand-built one.
 */
describe('the tower manning order', () => {
  it('is not the halt lever for anything else, nor for a tower on the scaffold', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const smith = placeBuiltBuilding(world, BuildingTypeId.weaponsmith, 0, 36, 30);
    const site = placeSite(world, BuildingTypeId.guardTower, 0, 40, 30);
    expect(levyOrder(snapBuilding(world, smith))).toBeUndefined();
    expect(levyOrder(snapBuilding(world, site))).toBeUndefined();
  });

  it('calls villagers up and stands them down again', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const tower = placeBuiltBuilding(world, BuildingTypeId.guardTower, 0, 36, 30);
    tower.paused = true; // as one comes off the scaffold
    for (let i = 0; i < CAP; i++) addSerf(world, 33, 33 + i);
    expect(levyOrder(snapBuilding(world, tower))).toEqual({ label: 'Man the tower' });

    tickWorld(
      world,
      cmds({ kind: CommandKind.setBuildingPaused, buildingId: tower.id, paused: false }),
    );
    let guard = 0;
    while ((tower.garrison ?? 0) < CAP && guard++ < 4000) tickWorld(world, []);
    expect(tower.garrison).toBe(CAP);
    expect(tower.garrisonKind).toBe(UnitTypeId.serf);
    expect(levyOrder(snapBuilding(world, tower))).toEqual({ label: 'Stand down' });

    tickWorld(
      world,
      cmds({ kind: CommandKind.setBuildingPaused, buildingId: tower.id, paused: true }),
    );
    expect(tower.garrison).toBeUndefined();
  });

  it('gives the archers back too — the state that started this is now unreachable', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const tower = placeBuiltBuilding(world, BuildingTypeId.guardTower, 0, 36, 30);
    for (let i = 0; i < CAP; i++) spawnUnit(world, UnitTypeId.archer, 0, 33.5, 33.5 + i);
    let guard = 0;
    while ((tower.garrison ?? 0) < CAP && guard++ < 4000) tickWorld(world, []);
    expect(tower.garrisonKind).toBe(UnitTypeId.archer);
    expect(levyOrder(snapBuilding(world, tower))).toEqual({ label: 'Stand down' });

    // Stand it down: the roof empties and the archers are two soldiers
    // standing at the door again, free to march.
    tickWorld(
      world,
      cmds({ kind: CommandKind.setBuildingPaused, buildingId: tower.id, paused: true }),
    );
    const snap = snapBuilding(world, tower);
    expect(snap.garrison).toBe(0);
    expect(levyOrder(snap)).toEqual({ label: 'Man the tower' });
    expect(
      [...world.units.values()].filter((u) => !u.dead && u.kind === UnitTypeId.archer),
    ).toHaveLength(CAP);

    // ...and a halted tower does not quietly take them back.
    guard = 0;
    while (guard++ < 600) tickWorld(world, []);
    expect(tower.garrison ?? 0).toBe(0);

    // Which is the point: "manned" and "stood down" can no longer both be
    // true, so the card can never again say "2/2 archers on the roof · paused".
    tickWorld(
      world,
      cmds({ kind: CommandKind.setBuildingPaused, buildingId: tower.id, paused: false }),
    );
    guard = 0;
    while ((tower.garrison ?? 0) < CAP && guard++ < 4000) tickWorld(world, []);
    const back = snapBuilding(world, tower);
    expect(back.garrison).toBe(CAP);
    expect(back.paused).toBeUndefined();
  });
});
