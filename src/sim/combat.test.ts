import { describe, expect, it } from 'vitest';
import { BANDIT, centerOf } from './entities.ts';
import { tickWorld } from './tick.ts';
import { placeBuiltBuilding, spawnUnit, spawnUnitNearby, type World } from './world.ts';
import { Terrain } from './map.ts';
import { COUNTER_TABLE, UNIT_DEFS } from './defs/units.ts';
import { checkInvariants } from './debug/invariants.ts';
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
    expect(sh.hp).toBeLessThan(500); // they reached it and did damage
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
    // Flood everything south of the camp — where guards would normally form up.
    for (let y = 33; y < 40; y++) {
      for (let x = 26; x < 40; x++) {
        const i = y * 64 + x;
        world.map.terrain[i] = Terrain.Water;
        world.map.blocked[i] = 1;
      }
    }
    const camp = placeBuiltBuilding(world, 'banditCamp', BANDIT, 30, 30);
    const raider = spawnUnitNearby(world, 'bandit', BANDIT, camp.x + 1.5, camp.y + camp.h + 1.5);
    const tile = Math.floor(raider.y) * 64 + Math.floor(raider.x);
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
