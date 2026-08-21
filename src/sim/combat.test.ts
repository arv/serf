import { describe, expect, it } from 'vitest';
import { BANDIT, centerOf } from './entities.ts';
import { tickWorld } from './tick.ts';
import {
  destroyBuilding,
  placeBuiltBuilding,
  placeSite,
  spawnUnit,
  spawnUnitNearby,
  type World,
} from './world.ts';
import { Terrain } from './map.ts';
import { COUNTER_TABLE, UNIT_DEFS } from './defs/units.ts';
import { BUILDING_DEFS } from './defs/buildings.ts';
import { checkInvariants } from './debug/invariants.ts';
import { populationOf } from './population.ts';
import { cmds, addSerf, addStorehouse, bareWorld } from './testUtils.ts';
import { ACTION, type UnitSnapshot } from '../protocol/sabLayout.ts';
import { unitSnapshots } from '../protocol/snapshot.ts';
import type { Building } from './entities.ts';
import type { Unit } from './units.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

describe('the counter triangle', () => {
  it('is a strict rock-paper-scissors table', () => {
    expect(COUNTER_TABLE.heavy.light).toBeGreaterThan(1);
    expect(COUNTER_TABLE.light.ranged).toBeGreaterThan(1);
    expect(COUNTER_TABLE.ranged.heavy).toBeGreaterThan(1);
    expect(COUNTER_TABLE.light.heavy).toBeLessThan(1);
    expect(COUNTER_TABLE.ranged.light).toBeLessThan(1);
    expect(COUNTER_TABLE.heavy.ranged).toBeLessThan(1);
  });

  it('knight (heavy) beats spearman (light) in a straight duel', () => {
    const world = bareWorld();
    const knight = spawnUnit(world, 'knight', 0, 30.5, 30.5);
    spawnUnit(world, 'spearman', BANDIT, 31.5, 30.5);
    run(world, 20 * 30);
    expect(knight.dead).toBe(false);
    expect([...world.units.values()].filter((u) => u.owner === BANDIT)).toEqual([]);
  });

  it('spearman (light) catches and kills the archer (ranged)', () => {
    const world = bareWorld();
    const spearman = spawnUnit(world, 'spearman', 0, 30.5, 30.5);
    spawnUnit(world, 'archer', BANDIT, 33.5, 30.5);
    run(world, 20 * 30);
    expect(spearman.dead).toBe(false);
    expect([...world.units.values()].filter((u) => u.owner === BANDIT)).toEqual([]);
  });

  it('archer (ranged) kites down the marauder (heavy)', () => {
    const world = bareWorld();
    const archer = spawnUnit(world, 'archer', 0, 30.5, 30.5);
    spawnUnit(world, 'marauder', BANDIT, 34.5, 30.5);
    run(world, 20 * 40);
    expect(archer.dead).toBe(false);
    expect([...world.units.values()].filter((u) => u.owner === BANDIT)).toEqual([]);
  });
});

describe('barracks training', () => {
  it('trains a knight from hauled food + sword', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { food: 10, sword: 2 });
    const barracks = placeBuiltBuilding(world, 'barracks', 0, 36, 30);
    addSerf(world, 34, 34);
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: barracks.id, unit: 'knight' }));

    // Knight isn't tech-gated (only its sword chain is), so the queue fills.
    expect(barracks.trainQueue?.length).toBe(1);
    run(world, 20 * 60);
    const knight = [...world.units.values()].find((u) => u.kind === 'knight');
    expect(knight).toBeDefined();
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('gates gated units until their tech lands', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { food: 10, bow: 2 });
    const barracks = placeBuiltBuilding(world, 'barracks', 0, 36, 30);
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: barracks.id, unit: 'archer' }));
    expect(barracks.trainQueue ?? []).toEqual([]);

    world.players[0]!.techs.researched.push('soldiery', 'archery');
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: barracks.id, unit: 'archer' }));
    expect(barracks.trainQueue?.length).toBe(1);
  });

  it('a stuck head does not block trainable units behind it (skip-ahead)', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { food: 10, spear: 2 }); // spear, but no sword
    world.players[0]!.techs.researched.push('soldiery');
    const barracks = placeBuiltBuilding(world, 'barracks', 0, 36, 30);
    addSerf(world, 34, 34);
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: barracks.id, unit: 'knight' }));
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: barracks.id, unit: 'spearman' }));
    run(world, 20 * 90);

    // The knight still waits for its sword; the spearman trained anyway.
    expect([...world.units.values()].some((u) => u.kind === 'spearman')).toBe(true);
    expect(barracks.trainQueue?.some((q) => q.unit === 'knight' && !q.started)).toBe(true);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('cancels an unstarted order outright — nothing was spent yet', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { food: 10, sword: 2 });
    const barracks = placeBuiltBuilding(world, 'barracks', 0, 36, 30);
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: barracks.id, unit: 'knight' }));
    expect(barracks.trainQueue?.length).toBe(1);

    // The unit guard: a click aimed at a slot that no longer holds what the
    // player saw must not cancel whatever sits there now.
    tickWorld(world, cmds({ kind: 'cancelTraining', buildingId: barracks.id, index: 0, unit: 'archer' }));
    expect(barracks.trainQueue?.length).toBe(1);

    tickWorld(world, cmds({ kind: 'cancelTraining', buildingId: barracks.id, index: 0, unit: 'knight' }));
    expect(barracks.trainQueue ?? []).toEqual([]);
    run(world, 20 * 10);
    expect([...world.units.values()].some((u) => u.kind === 'knight')).toBe(false);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('cancelling a started order returns the ingredients and the recruit', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { food: 10, sword: 1 });
    const barracks = placeBuiltBuilding(world, 'barracks', 0, 36, 30);
    addSerf(world, 34, 34);
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: barracks.id, unit: 'knight' }));

    // Run until the serf has hauled the ingredients in and enlisted.
    let guard = 20 * 120;
    while (!barracks.trainQueue?.[0]?.started && guard-- > 0) tickWorld(world, []);
    expect(barracks.trainQueue?.[0]?.started).toBe(true);
    expect([...world.units.values()].filter((u) => u.kind === 'serf' && !u.dead)).toEqual([]);

    tickWorld(world, cmds({ kind: 'cancelTraining', buildingId: barracks.id, index: 0, unit: 'knight' }));
    expect(barracks.trainQueue ?? []).toEqual([]);
    // The meal and the sword are back in the input buffer for the next order…
    expect(barracks.inputs.food).toBe(3);
    expect(barracks.inputs.sword).toBe(1);
    // …and the person walked back out a serf instead of becoming a knight.
    expect([...world.units.values()].filter((u) => u.kind === 'serf' && !u.dead)).toHaveLength(1);
    run(world, 20 * 30);
    expect([...world.units.values()].some((u) => u.kind === 'knight')).toBe(false);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('applies militaryHp modifiers at spawn', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { food: 10, spear: 2 });
    world.players[0]!.techs.researched.push('soldiery', 'mailArmor');
    const barracks = placeBuiltBuilding(world, 'barracks', 0, 36, 30);
    addSerf(world, 34, 34);
    tickWorld(world, cmds({ kind: 'trainUnit', buildingId: barracks.id, unit: 'spearman' }));
    run(world, 20 * 60);
    const spearman = [...world.units.values()].find((u) => u.kind === 'spearman');
    expect(spearman).toBeDefined();
    expect(spearman!.hp).toBe(Math.round(UNIT_DEFS.spearman.hp * 1.25));
  });
});

describe('raids and victory', () => {
  it('spawns escalating waves that attack the storehouse', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, {});
    placeBuiltBuilding(world, 'banditCamp', BANDIT, 44, 30);
    world.raidState = { nextRaidTick: 10, wave: 0 };
    run(world, 20 * 60);

    expect(world.raidState.wave).toBeGreaterThan(0);
    expect(world.pendingEvents.some((e) => e.kind === 'raidIncoming')).toBe(true);
    expect(sh.hp).toBeLessThan(BUILDING_DEFS.storehouse.hp); // they reached it and did damage
  });

  it('losing the storehouse loses the game', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, {});
    placeBuiltBuilding(world, 'banditCamp', BANDIT, 44, 30);
    sh.hp = 1;
    world.raidState = { nextRaidTick: 10, wave: 3 };
    run(world, 20 * 90);
    expect(world.outcome).toEqual({ state: 'over', winner: null });
  });

  it('musters raiders on dry land when the camp sits against water', () => {
    const world = bareWorld();
    const size = world.map.size;
    // Flood everything south of the camp — where guards would normally form up.
    for (let y = 33; y < 40; y++) {
      for (let x = 26; x < 40; x++) {
        const i = y * size + x;
        world.map.terrain[i] = Terrain.Water;
        world.map.blocked[i] = 1;
      }
    }
    const camp = placeBuiltBuilding(world, 'banditCamp', BANDIT, 30, 30);
    const raider = spawnUnitNearby(world, 'bandit', BANDIT, camp.x + 1.5, camp.y + camp.h + 1.5);
    const tile = Math.floor(raider.y) * size + Math.floor(raider.x);
    expect(world.map.blocked[tile]).toBe(0);
  });

  it('idle soldiers auto-besiege an enemy building in acquire range', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const camp = placeBuiltBuilding(world, 'banditCamp', BANDIT, 38, 30);
    camp.hp = 60;
    // No orders given: standing near the camp is enough to start the siege.
    spawnUnit(world, 'knight', 0, 36.5, 30.5);
    run(world, 20 * 60);
    expect(world.outcome).toEqual({ state: 'over', winner: 0 });
  });

  it('idle soldiers ignore enemy buildings beyond acquire range', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const camp = placeBuiltBuilding(world, 'banditCamp', BANDIT, 50, 30);
    const knight = spawnUnit(world, 'knight', 0, 32.5, 30.5);
    run(world, 20 * 10);
    expect(camp.dead).toBe(false);
    expect(knight.x).toBeLessThan(35); // held position, no cross-map crusade
  });

  it('attack-ordered knight raze the camp and win the game', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const camp = placeBuiltBuilding(world, 'banditCamp', BANDIT, 40, 30);
    camp.hp = 60;
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) ids.push(spawnUnit(world, 'knight', 0, 36.5, 29.5 + i).id);
    // Right-click on the camp = attack order.
    tickWorld(world, cmds({ kind: 'moveUnits', unitIds: ids, x: 41, y: 31 }));
    run(world, 20 * 60);

    expect(world.outcome).toEqual({ state: 'over', winner: 0 });
    // Attackers stand down instead of turning on the village.
    for (const id of ids) {
      const u = world.units.get(id);
      if (u) expect(u.targetIsBuilding ?? false).toBe(false);
    }
  });
});

describe('the three move orders', () => {
  it('an attack-move engages enemies met on the way, then walks on to its goal', () => {
    const world = bareWorld();
    const knight = spawnUnit(world, 'knight', 0, 30.5, 30.5);
    const bandit = spawnUnit(world, 'bandit', BANDIT, 36.5, 32.5);
    tickWorld(world, cmds({ kind: 'moveUnits', unitIds: [knight.id], x: 42, y: 30, attack: true }));
    expect(knight.task.t).toBe('attackMove');

    // Where the knight stood when the bandit fell: en route, not at the goal.
    let deathX = -1;
    for (let i = 0; i < 20 * 60; i++) {
      tickWorld(world, []);
      if (bandit.dead && deathX < 0) deathX = knight.x;
    }
    expect(bandit.dead).toBe(true);
    expect(knight.dead).toBe(false);
    expect(deathX).toBeLessThan(40);
    // The order then resumes: the knight stands on the goal tile, order done.
    expect(Math.floor(knight.x)).toBe(42);
    expect(Math.floor(knight.y)).toBe(30);
    expect(knight.task.t).toBe('idle');
  });

  it('an attack-move besieges an enemy building on the way, not after a round trip', () => {
    const world = bareWorld();
    const knight = spawnUnit(world, 'knight', 0, 30.5, 30.5);
    const camp = placeBuiltBuilding(world, 'banditCamp', BANDIT, 36, 33);
    camp.hp = 60;
    tickWorld(world, cmds({ kind: 'moveUnits', unitIds: [knight.id], x: 44, y: 30, attack: true }));

    // Acquiring the camp must also drop the marching path: with the path
    // kept, the knight walked to the goal with the target stuck on and only
    // then doubled back to raze it.
    let maxXBeforeRazed = 0;
    for (let i = 0; i < 20 * 60; i++) {
      tickWorld(world, []);
      if (!camp.dead) maxXBeforeRazed = Math.max(maxXBeforeRazed, knight.x);
    }
    expect(camp.dead).toBe(true);
    expect(maxXBeforeRazed).toBeLessThan(42);
    expect(Math.floor(knight.x)).toBe(44);
    expect(Math.floor(knight.y)).toBe(30);
    expect(knight.task.t).toBe('idle');
  });

  it('a plain move walks past enemies without raising a hand', () => {
    const world = bareWorld();
    const knight = spawnUnit(world, 'knight', 0, 30.5, 30.5);
    const bandit = spawnUnit(world, 'bandit', BANDIT, 36.5, 32.5);
    tickWorld(world, cmds({ kind: 'moveUnits', unitIds: [knight.id], x: 42, y: 30 }));
    expect(knight.task.t).toBe('move');

    // The bandit charges and gnaws at the knight the whole way; the knight
    // never strikes back until the walk is over. (Arrival flips the task to
    // idle mid-tick, so the first legal strike can land that same tick —
    // only ticks that END still on 'move' prove restraint.)
    let struckWhileMoving = false;
    let guard = 20 * 30;
    while (knight.task.t === 'move' && guard-- > 0) {
      tickWorld(world, []);
      if (knight.task.t === 'move' && bandit.hp < UNIT_DEFS.bandit.hp) struckWhileMoving = true;
    }
    expect(struckWhileMoving).toBe(false);
    expect(knight.dead).toBe(false);
    expect(Math.floor(knight.x)).toBe(42);
    expect(Math.floor(knight.y)).toBe(30);
  });

  it('a half order holds fire while fleeing, then answers past the midpoint', () => {
    const world = bareWorld();
    const knight = spawnUnit(world, 'knight', 0, 30.5, 30.5);
    const bandit = spawnUnit(world, 'bandit', BANDIT, 31.5, 31.5);
    tickWorld(world, cmds({ kind: 'moveUnits', unitIds: [knight.id], x: 44, y: 30, attack: 'half' }));
    expect(knight.task.t).toBe('attackMove');
    const quiet = (): boolean =>
      knight.task.t === 'attackMove' && knight.task.engageIdx !== undefined;
    expect(quiet()).toBe(true);

    // The bandit gives chase and gnaws at the knight the whole front leg;
    // the knight never answers while the order is quiet — the point of the
    // half order is that fleeing does not reengage.
    let struckWhileQuiet = false;
    let guard = 20 * 30;
    while (quiet() && guard-- > 0) {
      tickWorld(world, []);
      if (quiet() && bandit.hp < UNIT_DEFS.bandit.hp) struckWhileQuiet = true;
    }
    expect(struckWhileQuiet).toBe(false);

    // Past the midpoint the order is a live attack-move: the pursuer that
    // followed it into the back leg gets fought there, not back at the start,
    // and the order still ends standing on the goal tile.
    let deathX = -1;
    for (let i = 0; i < 20 * 60 && !bandit.dead; i++) tickWorld(world, []);
    deathX = knight.x;
    run(world, 20 * 30);
    expect(bandit.dead).toBe(true);
    expect(knight.dead).toBe(false);
    expect(deathX).toBeGreaterThan(35);
    expect(Math.floor(knight.x)).toBe(44);
    expect(Math.floor(knight.y)).toBe(30);
    expect(knight.task.t).toBe('idle');
  });

  it('a half order walks clear of the camp beside its start instead of besieging it', () => {
    const world = bareWorld();
    // The camp sits in acquire range of the start tile: a full attack-move
    // from here besieges at once. The half order is past its midpoint before
    // it goes live, and by then the camp is out of reach behind it.
    const camp = placeBuiltBuilding(world, 'banditCamp', BANDIT, 27, 32);
    const knight = spawnUnit(world, 'knight', 0, 30.5, 30.5);
    tickWorld(world, cmds({ kind: 'moveUnits', unitIds: [knight.id], x: 46, y: 30, attack: 'half' }));
    run(world, 20 * 30);
    expect(camp.dead).toBe(false);
    expect(camp.hp).toBe(600);
    expect(Math.floor(knight.x)).toBe(46);
    expect(Math.floor(knight.y)).toBe(30);
    expect(knight.task.t).toBe('idle');
  });

  it('civilians in an attack-move selection just walk — there is nothing to fight with', () => {
    const world = bareWorld();
    const serf = addSerf(world, 30, 31);
    tickWorld(world, cmds({ kind: 'moveUnits', unitIds: [serf.id], x: 34, y: 31, attack: true }));
    expect(serf.task.t).toBe('move');
    tickWorld(world, cmds({ kind: 'moveUnits', unitIds: [serf.id], x: 30, y: 31, attack: 'half' }));
    expect(serf.task.t).toBe('move');
  });
});

describe('damage events', () => {
  it('a player unit taking hits emits damage events', () => {
    const world = bareWorld();
    const knight = spawnUnit(world, 'knight', 0, 30.5, 30.5);
    spawnUnit(world, 'spearman', BANDIT, 31.5, 30.5);
    run(world, 40);
    const hits = world.pendingEvents.filter((e) => e.kind === 'damage');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((e) => e.player === 0 && e.building === false)).toBe(true);
    expect(knight.hp).toBeLessThan(UNIT_DEFS.knight.hp);
  });

  it('a player building under siege emits damage events at its center', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, {});
    const bandit = spawnUnit(world, 'bandit', BANDIT, 29.5, 30.5);
    bandit.task = { t: 'raid', buildingId: sh.id };
    run(world, 20 * 10);
    const hits = world.pendingEvents.filter((e) => e.kind === 'damage').filter((e) => e.building);
    expect(hits.length).toBeGreaterThan(0);
    const c = centerOf(sh);
    expect(hits.every((e) => e.player === 0 && e.x === c.x && e.y === c.y)).toBe(true);
  });

  it('bandit victims are silent — no events for razing their camp', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const camp = placeBuiltBuilding(world, 'banditCamp', BANDIT, 38, 30);
    camp.hp = 60;
    spawnUnit(world, 'knight', 0, 36.5, 30.5);
    run(world, 20 * 60);
    expect(camp.dead).toBe(true);
    expect(world.pendingEvents.filter((e) => e.kind === 'damage')).toEqual([]);
  });
});

/**
 * What the renderer is told is a separate question from who the unit has
 * marked. Holding a target id is a plan; swinging at it is an act, and only
 * the second one may reach the animation — otherwise units hack at thin air
 * halfway across the map from the enemy they are "fighting".
 */
describe('the fight the renderer is shown', () => {
  const snapOf = (world: World, id: number): UnitSnapshot => {
    for (const snap of unitSnapshots(world)) if (snap.id === id) return snap;
    throw new Error(`unit ${id} is not in the snapshot`);
  };

  /** Distance from a unit to a building's footprint — the combat reach test. */
  const reachTo = (u: Unit, b: Building): number =>
    Math.hypot(u.x - Math.max(b.x, Math.min(u.x, b.x + b.w)), u.y - Math.max(b.y, Math.min(u.y, b.y + b.h)));

  it('a unit ordered onto a far building only swings once it is at the wall', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const camp = placeBuiltBuilding(world, 'banditCamp', BANDIT, 44, 30);
    camp.hp = 60;
    const knight = spawnUnit(world, 'knight', 0, 30.5, 30.5);
    // Right-click on the camp: the target is set on the spot and held for the
    // whole march, which is exactly why it cannot be what drives the swing.
    tickWorld(world, cmds({ kind: 'moveUnits', unitIds: [knight.id], x: 45, y: 31 }));
    expect(knight.targetId).toBe(camp.id);
    expect(snapOf(world, knight.id).action).not.toBe(ACTION.fight);

    let farthestSwing = 0;
    let everSwung = false;
    for (let i = 0; i < 20 * 60 && !camp.dead; i++) {
      tickWorld(world, []);
      if (snapOf(world, knight.id).action === ACTION.fight) {
        everSwung = true;
        farthestSwing = Math.max(farthestSwing, reachTo(knight, camp));
      }
    }
    expect(camp.dead).toBe(true);
    expect(everSwung).toBe(true);
    expect(farthestSwing).toBeLessThanOrEqual(1.4); // melee reach, not the whole valley
  });

  it('a chased unit walking away under a plain move never looks like it fights back', () => {
    const world = bareWorld();
    const knight = spawnUnit(world, 'knight', 0, 30.5, 30.5);
    spawnUnit(world, 'bandit', BANDIT, 31.5, 30.5);
    tickWorld(world, cmds({ kind: 'moveUnits', unitIds: [knight.id], x: 42, y: 30 }));

    // The bandit gnaws at him the whole way. Being struck used to hand the
    // fleeing knight his attacker as a target — one no system would act on,
    // so he walked off swinging at a pursuer he had left behind.
    let guard = 20 * 30;
    while (knight.task.t === 'move' && guard-- > 0) {
      tickWorld(world, []);
      if (knight.task.t !== 'move') break; // arrival re-engages, legitimately
      expect(knight.targetId).toBeUndefined();
      expect(snapOf(world, knight.id).action).not.toBe(ACTION.fight);
    }
    expect(knight.hp).toBeLessThan(UNIT_DEFS.knight.hp); // he really was hit
  });

  it('an attacker faces what it is hitting', () => {
    const world = bareWorld();
    const knight = spawnUnit(world, 'knight', 0, 30.5, 30.5);
    spawnUnit(world, 'bandit', BANDIT, 31.5, 30.5); // due east, already in reach
    run(world, 3);
    const snap = snapOf(world, knight.id);
    expect(snap.action).toBe(ACTION.fight);
    // atan2(+1, 0) is a quarter turn clockwise from north: 256 / 4.
    expect(snap.facing).toBe(64);
  });

  it('a target that dies stops the swing the same tick the corpse appears', () => {
    const world = bareWorld();
    const knight = spawnUnit(world, 'knight', 0, 30.5, 30.5);
    const bandit = spawnUnit(world, 'bandit', BANDIT, 31.5, 30.5);
    for (let i = 0; i < 20 * 30 && !bandit.dead; i++) tickWorld(world, []);
    expect(bandit.dead).toBe(true);
    // The corpse lingers for its death animation; the killer must not stand
    // over it still swinging.
    expect(knight.targetId).toBeUndefined();
    expect(snapOf(world, knight.id).action).not.toBe(ACTION.fight);
  });
});

describe('the guard tower', () => {
  /** A built tower with `n` archers already on the roof — the state
   * staffing.ts arrives at, reached directly so the fire tests are not
   * also testing the walk. */
  function manned(world: World, n: number, x = 30, y = 30): Building {
    const tower = placeBuiltBuilding(world, 'guardTower', 0, x, y);
    tower.garrison = n;
    return tower;
  }

  it('calls an idle archer in off the field and swallows him', () => {
    const world = bareWorld();
    const tower = placeBuiltBuilding(world, 'guardTower', 0, 30, 30);
    const archer = spawnUnit(world, 'archer', 0, 36.5, 31.5);
    run(world, 20 * 20);
    expect(tower.garrison).toBe(1);
    // Consumed, not bound: nothing is left standing outside to be shot at.
    expect(archer.dead).toBe(true);
    expect(archer.deathTick).toBeUndefined();
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('takes two and then stops asking', () => {
    const world = bareWorld();
    const tower = placeBuiltBuilding(world, 'guardTower', 0, 30, 30);
    for (let i = 0; i < 4; i++) spawnUnit(world, 'archer', 0, 36.5 + i, 31.5);
    run(world, 20 * 40);
    expect(tower.garrison).toBe(2);
    expect([...world.units.values()].filter((u) => !u.dead && u.kind === 'archer')).toHaveLength(2);
  });

  it('comes up stood down, so finishing one costs the village nobody', () => {
    // The guard against the old trap: a tower is never *done* wanting men,
    // so one that started running would put two villagers on the wall the
    // day the masons left and hold them through every quiet hour after.
    const world = bareWorld();
    const site = placeSite(world, 'guardTower', 0, 30, 30);
    site.siteNeeds = {};
    site.buildProgress = BUILDING_DEFS.guardTower.buildTicks;
    const serf = addSerf(world, 36, 31);
    run(world, 20 * 20);
    expect(site.state).toBe('built');
    expect(site.paused).toBe(true);
    expect(site.garrison ?? 0).toBe(0);
    expect(serf.dead).toBe(false);
  });

  it('shoots half again as hard as an archer, once per man', () => {
    const world = bareWorld();
    const tower = manned(world, 2);
    const raider = spawnUnit(world, 'bandit', BANDIT, 34.5, 31.5);
    const before = raider.hp;
    // One volley: the cooldown starts at zero, so the first tick fires.
    tickWorld(world, []);
    const combat = UNIT_DEFS.archer.combat!;
    const rule = BUILDING_DEFS.guardTower.garrison!;
    // No counter multiplier: a bandit is light and these are archers, which
    // in the field would be docked to 0.67 — see the next test.
    const expected = combat.damage * rule.damageMult * 2;
    expect(before - raider.hp).toBeCloseTo(expected, 5);
    expect(tower.attackCooldown).toBe(combat.cooldownTicks);
  });

  it('is never docked by the counter table, only paid by it', () => {
    // The bandit (light) is the matchup the table would dock a field archer
    // for, and the marauder (heavy) the one it pays him for. A tower keeps
    // the bonus and refuses the penalty: closing on a bowman is how light
    // beats him, and nobody closes on a man behind a wall.
    const volley = (kind: 'bandit' | 'marauder'): number => {
      const world = bareWorld();
      manned(world, 2);
      const raider = spawnUnit(world, kind, BANDIT, 34.5, 31.5);
      const before = raider.hp;
      tickWorld(world, []);
      return before - raider.hp;
    };
    const combat = UNIT_DEFS.archer.combat!;
    const rule = BUILDING_DEFS.guardTower.garrison!;
    const base = combat.damage * rule.damageMult * 2;
    expect(COUNTER_TABLE.ranged.light).toBeLessThan(1); // the penalty declined
    expect(volley('bandit')).toBeCloseTo(base, 5);
    expect(COUNTER_TABLE.ranged.heavy).toBeGreaterThan(1); // the bonus kept
    expect(volley('marauder')).toBeCloseTo(base * COUNTER_TABLE.ranged.heavy, 5);
  });

  it('reaches further than the archer who mans it, but not forever', () => {
    const combat = UNIT_DEFS.archer.combat!;
    const rule = BUILDING_DEFS.guardTower.garrison!;
    // A man standing where a field archer could not be shot at, but the
    // tower can reach: measured from the footprint, which is where the
    // wall the arrow leaves actually is.
    const inside = (dist: number): boolean => {
      const world = bareWorld();
      const tower = manned(world, 2, 30, 30);
      // Due east of the 2x2 footprint's edge, on its middle row.
      const raider = spawnUnit(world, 'bandit', BANDIT, 32 + dist, 31);
      const before = raider.hp;
      tickWorld(world, []);
      expect(tower.garrison).toBe(2);
      return raider.hp < before;
    };
    expect(inside(combat.range + rule.rangeBonus - 0.5)).toBe(true);
    expect(inside(combat.range + rule.rangeBonus + 1.5)).toBe(false);
  });

  it('takes a villager while it is running, and shoots with stones for it', () => {
    const world = bareWorld();
    const tower = placeBuiltBuilding(world, 'guardTower', 0, 30, 30);
    const serf = addSerf(world, 36, 31);
    run(world, 20 * 20);
    expect(tower.garrison).toBe(1);
    expect(tower.garrisonKind).toBe('serf');
    expect(serf.dead).toBe(true); // consumed, like the archer

    const raider = spawnUnit(world, 'bandit', BANDIT, 34.5, 31.5);
    const before = raider.hp;
    tower.attackCooldown = 0;
    tickWorld(world, []);
    const levy = BUILDING_DEFS.guardTower.garrison!.levy;
    // The rock, not the bow: no damageMult, and light against light so no
    // counter either way.
    expect(before - raider.hp).toBeCloseTo(levy.damage, 5);
    expect(tower.attackCooldown).toBe(levy.cooldownTicks);
  });

  it('reaches less far with stones than with bows', () => {
    const rule = BUILDING_DEFS.guardTower.garrison!;
    const combat = UNIT_DEFS.archer.combat!;
    const hits = (levied: boolean, dist: number): boolean => {
      const world = bareWorld();
      const tower = placeBuiltBuilding(world, 'guardTower', 0, 30, 30);
      tower.garrison = 2;
      tower.garrisonKind = levied ? 'serf' : 'archer';
      const raider = spawnUnit(world, 'bandit', BANDIT, 32 + dist, 31);
      const before = raider.hp;
      tickWorld(world, []);
      return raider.hp < before;
    };
    expect(hits(true, rule.levy.range - 0.5)).toBe(true);
    const archerReach = combat.range + rule.rangeBonus - 0.5;
    expect(archerReach).toBeGreaterThan(rule.levy.range);
    expect(hits(true, archerReach)).toBe(false); // stones fall short
    expect(hits(false, archerReach)).toBe(true); // arrows do not
  });

  it('sends the whole levy home when an archer arrives to relieve it', () => {
    const world = bareWorld();
    const tower = placeBuiltBuilding(world, 'guardTower', 0, 30, 30);
    tower.garrison = 2;
    tower.garrisonKind = 'serf';
    spawnUnit(world, 'archer', 0, 36.5, 31.5);
    run(world, 20 * 20);
    // A tower holds one kind or the other, never a mix.
    expect(tower.garrisonKind).toBe('archer');
    expect(tower.garrison).toBe(1);
    const serfs = [...world.units.values()].filter((u) => !u.dead && u.kind === 'serf');
    expect(serfs).toHaveLength(2); // both villagers back on their feet
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('stops calling villagers up once it is halted', () => {
    const world = bareWorld();
    const tower = placeBuiltBuilding(world, 'guardTower', 0, 30, 30);
    tower.paused = true;
    const serf = addSerf(world, 36, 31);
    run(world, 20 * 20);
    expect(tower.garrison ?? 0).toBe(0);
    expect(serf.dead).toBe(false);
  });

  it('sends the villagers back to work when it is halted, and calls none up again', () => {
    const world = bareWorld();
    const tower = placeBuiltBuilding(world, 'guardTower', 0, 30, 30);
    tower.garrison = 2;
    tower.garrisonKind = 'serf';
    const before = populationOf(world, 0);
    tickWorld(world, cmds({ kind: 'setBuildingPaused', buildingId: tower.id, paused: true }));
    expect(tower.garrison ?? 0).toBe(0);
    expect(tower.garrisonKind).toBeUndefined();
    expect([...world.units.values()].filter((u) => !u.dead && u.kind === 'serf')).toHaveLength(2);
    // Coming down the stairs is not a death: the head count is unchanged.
    expect(populationOf(world, 0)).toBe(before);
    // And the order holds — the sweep does not walk them straight back up.
    run(world, 20 * 20);
    expect(tower.garrison ?? 0).toBe(0);
  });

  it('keeps its archers when it is halted — the lever is the levy', () => {
    const world = bareWorld();
    const tower = placeBuiltBuilding(world, 'guardTower', 0, 30, 30);
    tower.garrison = 2;
    tower.garrisonKind = 'archer';
    tickWorld(world, cmds({ kind: 'setBuildingPaused', buildingId: tower.id, paused: true }));
    expect(tower.garrison).toBe(2);
    expect(tower.garrisonKind).toBe('archer');
  });

  it('calls an archer over to relieve a full levy, unasked', () => {
    // The upgrade path, end to end and with nobody steering it: a tower at
    // capacity in villagers still asks for soldiers, and the first idle one
    // is walked over and swapped in.
    const world = bareWorld();
    const tower = placeBuiltBuilding(world, 'guardTower', 0, 30, 30);
    tower.garrison = BUILDING_DEFS.guardTower.garrison!.capacity;
    tower.garrisonKind = 'serf';
    const archer = spawnUnit(world, 'archer', 0, 36.5, 31.5);
    run(world, 20 * 20);
    expect(archer.dead).toBe(true); // consumed into the tower
    expect(tower.garrisonKind).toBe('archer');
    expect(tower.garrison).toBe(1);
    // The villagers are back on their feet, not lost.
    expect([...world.units.values()].filter((u) => !u.dead && u.kind === 'serf')).toHaveLength(2);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('takes an archer even while halted — a soldier costs the village nothing', () => {
    const world = bareWorld();
    const tower = placeBuiltBuilding(world, 'guardTower', 0, 30, 30);
    tower.paused = true;
    const archer = spawnUnit(world, 'archer', 0, 36.5, 31.5);
    run(world, 20 * 20);
    expect(tower.garrison).toBe(1);
    expect(tower.garrisonKind).toBe('archer');
    expect(archer.dead).toBe(true);
  });

  it('does not call villagers up to a tower the archers already hold', () => {
    const world = bareWorld();
    const tower = placeBuiltBuilding(world, 'guardTower', 0, 30, 30);
    tower.garrison = 1;
    tower.garrisonKind = 'archer';
    const serf = addSerf(world, 36, 31);
    run(world, 20 * 20);
    expect(tower.garrison).toBe(1);
    expect(tower.garrisonKind).toBe('archer');
    expect(serf.dead).toBe(false);
  });

  it('holds its fire while nobody is manning it', () => {
    const world = bareWorld();
    manned(world, 0);
    const raider = spawnUnit(world, 'bandit', BANDIT, 34.5, 31.5);
    const before = raider.hp;
    run(world, 20 * 5);
    expect(raider.hp).toBe(before);
  });

  it('kills what walks into reach, and does not shoot its own', () => {
    const world = bareWorld();
    manned(world, 2);
    const friend = spawnUnit(world, 'serf', 0, 33.5, 31.5);
    const raider = spawnUnit(world, 'bandit', BANDIT, 34.5, 31.5);
    run(world, 20 * 20);
    expect(raider.dead).toBe(true);
    expect(friend.dead).toBe(false);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('counts its garrison as people, so manning a tower frees no bed', () => {
    const world = bareWorld();
    addStorehouse(world, 40, 40, {});
    const tower = placeBuiltBuilding(world, 'guardTower', 0, 30, 30);
    spawnUnit(world, 'archer', 0, 36.5, 31.5);
    const before = populationOf(world, 0);
    run(world, 20 * 20);
    expect(tower.garrison).toBe(1);
    expect(populationOf(world, 0)).toBe(before);
  });

  it('takes its garrison down with it', () => {
    const world = bareWorld();
    const tower = manned(world, 2);
    const before = populationOf(world, 0);
    destroyBuilding(world, tower);
    expect(tower.garrison ?? 0).toBe(0);
    expect(populationOf(world, 0)).toBe(before - 2);
  });

  it('hands the men back when it is sold', () => {
    const world = bareWorld();
    addStorehouse(world, 40, 40, {});
    const tower = manned(world, 2);
    const before = populationOf(world, 0);
    tickWorld(world, cmds({ kind: 'sellBuilding', buildingId: tower.id }));
    const archers = [...world.units.values()].filter((u) => !u.dead && u.kind === 'archer');
    expect(archers).toHaveLength(2);
    expect(populationOf(world, 0)).toBe(before);
  });

});
