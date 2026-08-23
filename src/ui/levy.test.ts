import { describe, expect, it } from 'vitest';
import { levyOrder } from './levy';
import { snapBuilding } from '../protocol/snapshot.ts';
import { tickWorld } from '../sim/tick.ts';
import { placeBuiltBuilding, placeSite, spawnUnit } from '../sim/world.ts';
import { BUILDING_DEFS } from '../sim/defs/buildings.ts';
import { addSerf, addStorehouse, bareWorld, cmds } from '../sim/testUtils.ts';

const CAP = BUILDING_DEFS.guardTower.garrison!.capacity;

/**
 * The card's halt lever on a tower is the levy, and the words on it have to
 * be the levy's — a tower manned by archers and shooting once a second used
 * to read "· paused" over a button that, pressed either way, moved nobody.
 * The sim is the authority on when the order still decides something, so
 * these read the real garrison through the real snapshot rather than a
 * hand-built one.
 */
describe('the tower levy order', () => {
  it('is not the halt lever for anything else, nor for a tower on the scaffold', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const smith = placeBuiltBuilding(world, 'weaponsmith', 0, 36, 30);
    const site = placeSite(world, 'guardTower', 0, 40, 30);
    expect(levyOrder(snapBuilding(world, smith))).toBeUndefined();
    expect(levyOrder(snapBuilding(world, site))).toBeUndefined();
  });

  it('calls villagers up and stands them down again while the roof is theirs', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const tower = placeBuiltBuilding(world, 'guardTower', 0, 36, 30);
    tower.paused = true; // as one comes off the scaffold
    for (let i = 0; i < CAP; i++) addSerf(world, 33, 33 + i);

    // Stood down and empty: the lever is live, and it reads as the call-up.
    expect(levyOrder(snapBuilding(world, tower))).toEqual({ label: 'Call up levy', live: true });

    tickWorld(world, cmds({ kind: 'setBuildingPaused', buildingId: tower.id, paused: false }));
    let guard = 0;
    while ((tower.garrison ?? 0) < CAP && guard++ < 4000) tickWorld(world, []);
    expect(tower.garrison).toBe(CAP);
    expect(tower.garrisonKind).toBe('serf');
    // Villagers on the roof are exactly who the lever sends home, so it
    // stays live — and now reads as the stand-down.
    expect(levyOrder(snapBuilding(world, tower))).toEqual({ label: 'Stand down', live: true });

    tickWorld(world, cmds({ kind: 'setBuildingPaused', buildingId: tower.id, paused: true }));
    expect(tower.garrison).toBeUndefined();
  });

  it('goes dead once soldiers hold the roof — and the sim agrees it moves nobody', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const tower = placeBuiltBuilding(world, 'guardTower', 0, 36, 30);
    tower.paused = true; // came off the scaffold stood down and was left there
    for (let i = 0; i < CAP; i++) spawnUnit(world, 'archer', 0, 33.5, 33.5 + i);

    // Archers man a stood-down tower on their own: that is the state the
    // card showed as "2/2 archers on the roof · paused".
    let guard = 0;
    while ((tower.garrison ?? 0) < CAP && guard++ < 4000) tickWorld(world, []);
    expect(tower.garrison).toBe(CAP);
    expect(tower.garrisonKind).toBe('archer');

    const order = levyOrder(snapBuilding(world, tower));
    expect(order).toEqual({ label: 'Call up levy', live: false });

    // Dead means dead: pressing it either way leaves the roof exactly as it
    // is, which is why the card shows it disabled rather than inviting a
    // press that does nothing.
    addSerf(world, 34, 34); // a hand the levy could have taken, if it could
    tickWorld(world, cmds({ kind: 'setBuildingPaused', buildingId: tower.id, paused: false }));
    guard = 0;
    while (guard++ < 600) tickWorld(world, []);
    expect(tower.garrison).toBe(CAP);
    expect(tower.garrisonKind).toBe('archer');
    expect(levyOrder(snapBuilding(world, tower))).toEqual({ label: 'Stand down', live: false });

    tickWorld(world, cmds({ kind: 'setBuildingPaused', buildingId: tower.id, paused: true }));
    expect(tower.garrison).toBe(CAP);
    expect(tower.garrisonKind).toBe('archer');
  });

  it('says nothing about a partly held roof either — no villager joins a soldier', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const tower = placeBuiltBuilding(world, 'guardTower', 0, 36, 30);
    tower.garrison = 1;
    tower.garrisonKind = 'archer';
    expect(levyOrder(snapBuilding(world, tower))?.live).toBe(false);
  });
});
