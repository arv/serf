import {describe, expect, it} from 'vitest';
import {tileIdx} from '../shared/grid.ts';
import * as CommandKind from '../sim/commandKindEnum.ts';
import * as BuildingTypeId from '../sim/defs/buildingTypeIdEnum.ts';
import * as GoodId from '../sim/defs/goodIdEnum.ts';
import * as TechId from '../sim/defs/techIdEnum.ts';
import {TECH_DEFS} from '../sim/defs/techs.ts';
import {UNIT_DEFS} from '../sim/defs/units.ts';
import * as UnitTypeId from '../sim/defs/unitTypeIdEnum.ts';
import {BANDIT} from '../sim/entities.ts';
import * as HaulPhase from '../sim/haulPhaseEnum.ts';
import {findResourceNear} from '../sim/map.ts';
import {populationOf} from '../sim/population.ts';
import {
  addBuiltHut,
  addResourceTile,
  addStorehouse,
  bareWorld,
  cmds,
} from '../sim/testUtils.ts';
import {tickWorld} from '../sim/tick.ts';
import * as TileResource from '../sim/tileResourceEnum.ts';
import {
  destroyBuilding,
  placeBuiltBuilding,
  spawnUnit,
  type World,
} from '../sim/world.ts';
import {BUFF, type UnitSnapshot} from './sabLayout.ts';
import {
  snapBuilding,
  snapBuildings,
  snapPlayers,
  unitSnapshots,
} from './snapshot.ts';

/**
 * The reach readout: what a gatherer's card says is left in the ground
 * around it. It has to mean exactly what the gather loop will hand its
 * worker — a number that counts a tree the worker may not touch is worse
 * than no number, because the hut then stands idle in front of it.
 */
/**
 * A study's bill on the wire. The panel counts an unstarted study in loads
 * carried in, so what it is told about the bill decides what it draws —
 * and the one state that must not read as "delivered" is the one where
 * nothing is known.
 */
describe('the study bill in a snapshot', () => {
  it('omits the bill when the Abbey holding it is gone', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {
      [GoodId.wheat]: 20,
      [GoodId.silver]: 20,
    });
    const abbey = placeBuiltBuilding(world, BuildingTypeId.abbey, 0, 24, 30);
    tickWorld(
      world,
      cmds({kind: CommandKind.research, tech: TechId.cobbledBoots}),
    );
    expect(snapPlayers(world)[0]!.techs.active?.needs).toEqual(
      TECH_DEFS[TechId.cobbledBoots].cost,
    );

    // The roof comes down mid-tick: researchSystem runs early and has not
    // dropped the order yet, so the study is still active and unstarted
    // with no Abbey to read a bill from.
    destroyBuilding(world, abbey);
    const active = snapPlayers(world)[0]!.techs.active;
    expect(active?.started).toBe(false);
    expect(active?.needs).toBeUndefined();
  });
});

describe('snapBuilding: resourceLeft', () => {
  it('sums the workable tiles inside the search square and nothing outside it', () => {
    const world = bareWorld();
    // A 2x2 hut at (30,30) searches from its center tile (31,31), 8 out.
    const hut = addBuiltHut(world, 30, 30, false);
    addResourceTile(world, 39, 31, TileResource.Wood, 6); // the far edge: in
    addResourceTile(world, 40, 31, TileResource.Wood, 6); // one past it: out
    addResourceTile(world, 33, 33, TileResource.Rock, 6); // in reach, wrong good
    addResourceTile(world, 33, 30, TileResource.Wood, 4);

    expect(snapBuilding(world, hut).resourceLeft).toBe(10);
  });

  it('falls to zero exactly when the gather search runs dry', () => {
    const world = bareWorld();
    const hut = addBuiltHut(world, 30, 30, false);
    addResourceTile(world, 33, 33, TileResource.Wood, 1);
    expect(snapBuilding(world, hut).resourceLeft).toBe(1);

    // Worked out: the same state a felled tile is left in mid-trip, before
    // depleteResourceTile clears the code.
    world.map.resourceAmt[33 + 33 * world.map.size] = 0;
    expect(snapBuilding(world, hut).resourceLeft).toBe(0);
    expect(findResourceNear(world.map, 31, 31, TileResource.Wood, 8)).toBe(-1);
  });

  it('counts only what the worker can walk to, and says how much is shut out', () => {
    // The readout the docstring above promises, made true. A quarry whose
    // last rock sat ringed by its own grove reported "in reach: 10" for
    // the eight minutes it stood dead, because the count walked the square
    // and never asked whether anything could be walked to. Ten loads and
    // no trips are different facts and the card has to carry both: nothing
    // reachable and nothing standing is a hut to sell, nothing reachable
    // with loads shut out is a grove to fell.
    const world = bareWorld();
    const hut = addBuiltHut(world, 30, 30, false);
    const size = world.map.size;
    addResourceTile(world, 35, 31, TileResource.Wood, 6); // open ground: countable
    addResourceTile(world, 27, 31, TileResource.Wood, 4); // sealed, below
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const i = tileIdx(27 + dx, 31 + dy, size);
        world.map.resource[i] = TileResource.Rock;
        world.map.resourceAmt[i] = 6;
        world.map.blocked[i] = 1;
      }
    }
    expect(snapBuilding(world, hut).resourceLeft).toBe(6);
    expect(snapBuilding(world, hut).resourceBlocked).toBe(4);

    // With the open grove gone the hut has no trips left in it at all, and
    // still must not read as worked out: the four loads are standing right
    // there, and felling one tree of the ring gives them back.
    world.map.resource[tileIdx(35, 31, size)] = TileResource.None;
    world.map.resourceAmt[tileIdx(35, 31, size)] = 0;
    world.map.blocked[tileIdx(35, 31, size)] = 0;
    expect(snapBuilding(world, hut).resourceLeft).toBe(0);
    expect(snapBuilding(world, hut).resourceBlocked).toBe(4);
  });

  it('says nothing is shut out when nothing is', () => {
    // Absent rather than zero: the roster ships on its serialized body
    // changing, so a field that is always there is always in the diff.
    const world = bareWorld();
    const hut = addBuiltHut(world, 30, 30, false);
    addResourceTile(world, 35, 31, TileResource.Wood, 6);
    expect(snapBuilding(world, hut).resourceBlocked).toBeUndefined();
  });

  it('is absent for buildings that work no land', () => {
    const world = bareWorld();
    const store = addStorehouse(world, 20, 20, {});
    expect(snapBuilding(world, store).resourceLeft).toBeUndefined();
  });
});

/**
 * The hauler-starvation readout: when the oldest unclaimed pickup from
 * this building was booked. It has to mean "a load is here and nobody has
 * come" — a job with a serf already walking is being answered, and
 * counting it would alarm the card over ordinary churn. A stable tick
 * rather than an age, so a standing wait does not change the serialized
 * roster every frame (the churn postStructural's suppression exists to
 * stop).
 */
describe('snapBuilding: outWaitingSince', () => {
  it('reports the oldest unclaimed pickup, and only from this building', () => {
    const world = bareWorld();
    const hut = addBuiltHut(world, 30, 30, false);
    const store = addStorehouse(world, 20, 20, {});
    world.tick = 500;
    world.jobs.set(1, {
      id: 1,
      good: GoodId.wood,
      from: hut.id,
      to: store.id,
      owner: 0,
      priority: 3,
      createdTick: 260,
      phase: HaulPhase.open,
    });
    world.jobs.set(2, {
      id: 2,
      good: GoodId.wood,
      from: hut.id,
      to: store.id,
      owner: 0,
      priority: 3,
      createdTick: 100, // older, but claimed: a serf is on his way
      phase: HaulPhase.toPickup,
      serfId: 99,
    });
    expect(snapBuilding(world, hut).outWaitingSince).toBe(260);
    // Jobs TO a building are its suppliers' story, not its own.
    expect(snapBuilding(world, store).outWaitingSince).toBeUndefined();
  });

  it('holds still while the wait stands, so the roster body does too', () => {
    const world = bareWorld();
    const hut = addBuiltHut(world, 30, 30, false);
    const store = addStorehouse(world, 20, 20, {});
    world.tick = 500;
    world.jobs.set(1, {
      id: 1,
      good: GoodId.wood,
      from: hut.id,
      to: store.id,
      owner: 0,
      priority: 3,
      createdTick: 260,
      phase: HaulPhase.open,
    });
    const before = JSON.stringify(snapBuilding(world, hut));
    world.tick = 5000; // the wait ages; nothing about the jobs moved
    expect(JSON.stringify(snapBuilding(world, hut))).toBe(before);
  });

  it('is absent when every booked pickup has a hand walking', () => {
    const world = bareWorld();
    const hut = addBuiltHut(world, 30, 30, false);
    const store = addStorehouse(world, 20, 20, {});
    world.tick = 500;
    world.jobs.set(1, {
      id: 1,
      good: GoodId.wood,
      from: hut.id,
      to: store.id,
      owner: 0,
      priority: 3,
      createdTick: 100,
      phase: HaulPhase.toDropoff,
      serfId: 99,
    });
    expect(snapBuilding(world, hut).outWaitingSince).toBeUndefined();
  });
});

/**
 * The health byte. It is a fraction of the unit's OWN full health, which is
 * not his kind's: armour research musters a knight at 120 against a base of
 * 80, and dividing by the kind saturated the byte at full until he was down
 * to what an unarmoured man starts with — a third of him gone with nothing
 * to show for it, on the bar over his head and on the card that names him.
 */
describe('unitSnapshots: health', () => {
  const snapOf = (world: World, id: number): UnitSnapshot => {
    for (const snap of unitSnapshots(world)) if (snap.id === id) return snap;
    throw new Error(`unit ${id} is not in the snapshot`);
  };

  it('measures a wound against the unit’s own maximum, not its kind’s', () => {
    const world = bareWorld();
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 30.5, 30.5);
    // Mail Armor and Gilded Arms, as the barracks hands him out.
    knight.hp = knight.maxHp = 120;
    expect(knight.maxHp).toBeGreaterThan(UNIT_DEFS[UnitTypeId.knight].hp);
    expect(snapOf(world, knight.id).hpPct).toBe(255);
    expect(snapOf(world, knight.id).maxHp).toBe(120);

    knight.hp = 110; // one blow
    expect(snapOf(world, knight.id).hpPct).toBe(Math.round((110 / 120) * 255));
    expect(snapOf(world, knight.id).hpPct).toBeLessThan(255);
    // Against the kind's 80 this same man read past full, and clamped to it.
    expect(
      Math.round((110 / UNIT_DEFS[UnitTypeId.knight].hp) * 255),
    ).toBeGreaterThan(255);
  });

  it('reads full for a unit carrying only its kind’s number', () => {
    const world = bareWorld();
    const serf = spawnUnit(world, UnitTypeId.serf, 0, 30.5, 30.5);
    expect(snapOf(world, serf.id).hpPct).toBe(255);
    expect(snapOf(world, serf.id).maxHp).toBe(UNIT_DEFS[UnitTypeId.serf].hp);
    serf.hp -= 1;
    expect(snapOf(world, serf.id).hpPct).toBeLessThan(255);
  });
});

/**
 * The HUD's head count has to be the sim's head count. The hire gate reads
 * populationOf; if the readout says fewer, the player sees 18/20 and a
 * castle that will not take their silver.
 */
describe('snapPlayers: pop', () => {
  it('counts a manned tower and a recruit under drill, like the hire gate', () => {
    const world = bareWorld();
    addStorehouse(world, 10, 10, {});
    for (let i = 0; i < 3; i++)
      spawnUnit(world, UnitTypeId.serf, 0, 20 + i, 20);
    // Two archers up the tower — consumed as units, held by the building.
    const tower = placeBuiltBuilding(
      world,
      BuildingTypeId.guardTower,
      0,
      30,
      30,
    );
    tower.garrison = 2;
    tower.garrisonKind = UnitTypeId.archer;
    tower.garrisonHp = [10, 10];
    // One recruit the barracks has started on, one order still waiting.
    const barracks = placeBuiltBuilding(
      world,
      BuildingTypeId.barracks,
      0,
      40,
      40,
    );
    barracks.trainQueue = [
      {unit: UnitTypeId.knight, ticksLeft: 100, started: true},
      {unit: UnitTypeId.knight, ticksLeft: 0, started: false},
    ];
    const [me] = snapPlayers(world);
    expect(me!.pop).toBe(3 + 2 + 1);
    expect(me!.pop).toBe(populationOf(world, 0));
  });
});

/**
 * The roster is the HUD's only account of the world's buildings — and of
 * the players, the stock, the techs and the selected building's card, all
 * of which ride the same structural frame. So a building this build cannot
 * describe must cost the roster that building and nothing else. Whole-frame
 * failure was the shape of a real freeze: a save carrying a building type
 * a later build had added threw out of the roster, took the frame with it,
 * and left every panel in the HUD showing its last value forever while the
 * units carried on walking about on the other channel.
 */
describe('snapBuildings: a building the definitions cannot describe', () => {
  it('leaves that one off the roster and still describes the rest', () => {
    const world = bareWorld();
    const home = addStorehouse(world, 10, 10, {});
    const hut = addBuiltHut(world, 30, 30, false);
    // A type no BUILDING_DEFS entry answers to — what a save written by a
    // build with one more building in it hands this one.
    const stranger = addBuiltHut(world, 40, 40, false);
    (stranger as {type: number}).type = 9999;

    const roster = snapBuildings(world);

    const byId = (a: number, z: number): number => a - z;
    expect(roster.map(b => b.id).sort(byId)).toEqual(
      [home.id, hut.id].sort(byId),
    );
    expect(roster.some(b => b.id === stranger.id)).toBe(false);
  });

  it('still counts the men an undescribed building holds', () => {
    const world = bareWorld();
    addStorehouse(world, 10, 10, {});
    // The shape a newer build's trainer arrives in: a type this one has no
    // entry for, holding a garrison and a recruit already under way.
    const stranger = addBuiltHut(world, 40, 40, false);
    (stranger as {type: number}).type = 9999;
    stranger.garrison = 2;
    stranger.trainQueue = [
      {unit: UnitTypeId.archer, ticksLeft: 10, started: true},
      {unit: UnitTypeId.archer, ticksLeft: 10, started: false},
    ];

    // Two up the roof and one on the drill floor: three heads, and the
    // sim's own populationOf counts every one of them. A readout that
    // dropped them with the building would sit under the gate the castle
    // is refusing hires against, which is the disagreement snapPlayers
    // exists to have already fixed.
    expect(snapPlayers(world)[0]!.pop).toBe(3);
  });
});

/**
 * The festival mark rides the unit, not the seat: a rival's research is
 * redacted on the wire, and the mark's whole job is telling a player that
 * the men marching on them have been drinking.
 */
describe('unitSnapshots: the festival mark', () => {
  const snapOf = (world: World, id: number): UnitSnapshot => {
    for (const snap of unitSnapshots(world)) if (snap.id === id) return snap;
    throw new Error(`unit ${id} is not in the snapshot`);
  };

  it('marks a living soldier whose owner holds a festival, and nobody else', () => {
    const world = bareWorld(1, 2);
    world.players[0]!.techs.festivalTicksLeft = 100;
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 30.5, 30.5);
    const archer = spawnUnit(world, UnitTypeId.archer, 0, 32.5, 30.5);
    // A serf of the same seat works faster too, but wears no mark: the
    // question the mark answers is a military one.
    const serf = spawnUnit(world, UnitTypeId.serf, 0, 34.5, 30.5);
    // A rival's soldier with no festival, and a bandit, who has no seat.
    const rival = spawnUnit(world, UnitTypeId.spearman, 1, 40.5, 30.5);
    const bandit = spawnUnit(world, UnitTypeId.bandit, BANDIT, 50.5, 50.5);
    expect(snapOf(world, knight.id).buffs).toBe(BUFF.festival);
    expect(snapOf(world, archer.id).buffs).toBe(BUFF.festival);
    expect(snapOf(world, serf.id).buffs).toBe(0);
    expect(snapOf(world, rival.id).buffs).toBe(0);
    expect(snapOf(world, bandit.id).buffs).toBe(0);
  });

  it('lifts the mark when the festival lapses', () => {
    const world = bareWorld();
    world.players[0]!.techs.festivalTicksLeft = 100;
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 30.5, 30.5);
    expect(snapOf(world, knight.id).buffs).toBe(BUFF.festival);
    world.players[0]!.techs.festivalTicksLeft = 0;
    expect(snapOf(world, knight.id).buffs).toBe(0);
  });
});
