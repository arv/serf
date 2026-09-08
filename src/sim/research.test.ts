import {describe, expect, it} from 'vitest';
import * as CommandKind from './commandKindEnum.ts';
import {checkInvariants} from './debug/invariants.ts';
import {
  BARRACKS_ALE_CAP,
  FESTIVAL_DURATION,
  MATCHER_INTERVAL,
} from './defs/balance.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as GoodId from './defs/goodIdEnum.ts';
import {goodEntries} from './defs/goods.ts';
import * as ModifierKey from './defs/modifierKeyEnum.ts';
import * as TechId from './defs/techIdEnum.ts';
import {TECH_DEFS} from './defs/techs.ts';
import * as UnitTypeId from './defs/unitTypeIdEnum.ts';
import {getModifier, isBuildingUnlocked} from './techHelpers.ts';
import {
  cmds,
  addSerf,
  addStorehouse,
  bareWorld,
  staffBuilding,
} from './testUtils.ts';
import {tickWorld} from './tick.ts';
import {destroyBuilding, placeBuiltBuilding, type World} from './world.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

function setupSchool(world: World): void {
  addStorehouse(world, 30, 30, {
    [GoodId.wheat]: 50,
    [GoodId.silver]: 50,
    [GoodId.stone]: 20,
    [GoodId.wood]: 20,
    [GoodId.ale]: 10,
    [GoodId.iron]: 10,
  });
  placeBuiltBuilding(world, BuildingTypeId.abbey, 0, 24, 30);
  // Four pairs of hands by the door: a study's goods are carried to the
  // Abbey now, so a fixture with no serfs is a fixture where no research
  // ever starts.
  for (let i = 0; i < 4; i++) addSerf(world, 28, 32 + i);
}

/** The Abbey a study was ordered at (fixtures stand exactly one). */
function abbeyOf(world: World) {
  return [...world.buildings.values()].find(
    b => b.type === BuildingTypeId.abbey,
  )!;
}

/**
 * Tick until the serfs have carried the whole bill in and the study's own
 * clock has started, and answer how long that took. Fails loudly rather
 * than silently running a test against a study that never began.
 */
function runHaul(world: World, limit = 20 * 120): number {
  let t = 0;
  while (!world.players[0]!.techs.active?.started) {
    expect(t).toBeLessThan(limit);
    tickWorld(world, []);
    t++;
  }
  return t;
}

describe('research', () => {
  it('requires a abbey', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {[GoodId.wheat]: 50, [GoodId.silver]: 50});
    tickWorld(
      world,
      cmds({kind: CommandKind.research, tech: TechId.irrigation}),
    );
    expect(world.players[0]!.techs.active).toBeUndefined();
  });

  it('bills the Abbey, is carried there, then takes time and applies', () => {
    const world = bareWorld();
    setupSchool(world);
    const silverBefore = 50;
    const cost = TECH_DEFS[TechId.cobbledBoots].cost;
    tickWorld(
      world,
      cmds({kind: CommandKind.research, tech: TechId.cobbledBoots}),
    );

    // Ordered, but nothing is spent and nothing is learned yet: the bill
    // is on the Abbey and the shelf is untouched until a serf lifts a load.
    const active = world.players[0]!.techs.active!;
    expect(active.tech).toBe(TechId.cobbledBoots);
    expect(active.started).toBe(false);
    expect(abbeyOf(world).researchNeeds).toEqual({...cost});
    const sh = [...world.buildings.values()].find(
      b => b.type === BuildingTypeId.storehouse,
    )!;
    expect(sh.stock[GoodId.silver]).toBe(silverBefore);

    // The clock does not run while the goods are on the road.
    run(world, 40);
    expect(world.players[0]!.techs.active?.ticksLeft).toBe(
      TECH_DEFS[TechId.cobbledBoots].durationTicks,
    );

    runHaul(world);
    // Every load is spent at the Abbey's door: the shelf is down the whole
    // bill, and the Abbey is holding none of it.
    expect(sh.stock[GoodId.silver]).toBe(
      silverBefore - (cost[GoodId.silver] ?? 0),
    );
    expect(abbeyOf(world).researchNeeds).toBeUndefined();
    expect(abbeyOf(world).stock[GoodId.silver] ?? 0).toBe(0);
    expect(getModifier(world, 0, ModifierKey.serfSpeed)).toBe(1);
    expect(checkInvariants(world).violations).toEqual([]);

    run(world, TECH_DEFS[TechId.cobbledBoots].durationTicks + 2);
    expect(world.players[0]!.techs.researched).toContain(TechId.cobbledBoots);
    expect(world.players[0]!.techs.active).toBeUndefined();
    expect(getModifier(world, 0, ModifierKey.serfSpeed)).toBeCloseTo(1.15);
  });

  it('a study with nobody to carry it never starts', () => {
    // The other half of the claim above: the goods are the gate, not a
    // formality. No serfs, no loads, no clock — and still nothing spent.
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, {
      [GoodId.wheat]: 50,
      [GoodId.silver]: 50,
    });
    placeBuiltBuilding(world, BuildingTypeId.abbey, 0, 24, 30);
    tickWorld(
      world,
      cmds({kind: CommandKind.research, tech: TechId.cobbledBoots}),
    );
    run(world, TECH_DEFS[TechId.cobbledBoots].durationTicks * 2);
    expect(world.players[0]!.techs.active?.started).toBe(false);
    expect(world.players[0]!.techs.researched).not.toContain(
      TechId.cobbledBoots,
    );
    expect(sh.stock[GoodId.silver]).toBe(50);
  });

  it('is ordered on credit, and the study waits for the goods', () => {
    // The build ribbon's rule, applied to the tree: a site is pegged out
    // with an empty storehouse and the planks catch up, and a study is
    // ordered the same way. Nothing on the shelf, an order taken all the
    // same — and it starts the moment the goods exist and are carried in.
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, {});
    placeBuiltBuilding(world, BuildingTypeId.abbey, 0, 24, 30);
    for (let i = 0; i < 4; i++) addSerf(world, 28, 32 + i);
    tickWorld(
      world,
      cmds({kind: CommandKind.research, tech: TechId.cobbledBoots}),
    );
    expect(world.players[0]!.techs.active?.tech).toBe(TechId.cobbledBoots);
    expect(world.players[0]!.techs.active?.started).toBe(false);

    // The silver and wheat turn up later, from wherever.
    const cost = TECH_DEFS[TechId.cobbledBoots].cost;
    for (const [good, n] of goodEntries(cost)) {
      sh.stock[good] = n;
      world.ledger.produced[good] = (world.ledger.produced[good] ?? 0) + n;
    }
    runHaul(world);
    run(world, TECH_DEFS[TechId.cobbledBoots].durationTicks + 2);
    expect(world.players[0]!.techs.researched).toContain(TechId.cobbledBoots);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('a settled line of the bill gives up its place in the haul queue', () => {
    // The FIFO age lives per (building, good), and an Abbey wants ale for
    // two different reasons: a study billed in ale, and — once Festivals
    // is in — the buff. So when the ale half of a bill is settled while
    // the silver half is still walking, the study's clock must not be left
    // behind for the next barrel to inherit: it would sort at the head of
    // tier 2 on the strength of when the STUDY was ordered, in front of
    // every mine's bread and every forge's iron asked for since.
    //
    // Festivals itself is the study here, precisely so the buff's own
    // demand is NOT running: it is the one branch that would rewrite this
    // clock either way, and a test it can satisfy proves nothing.
    const world = bareWorld();
    setupSchool(world);
    world.players[0]!.techs.researched.push(TechId.irrigation, TechId.brewing);
    const abbey = abbeyOf(world);
    const sh = [...world.buildings.values()].find(
      b => b.type === BuildingTypeId.storehouse,
    )!;
    // No silver on the shelf, so the silver half can never be settled and
    // the bill stays open with its ale line paid.
    sh.stock[GoodId.silver] = 0;
    tickWorld(
      world,
      cmds({kind: CommandKind.research, tech: TechId.festivals}),
    );
    expect(abbey.researchNeeds?.[GoodId.ale]).toBe(
      TECH_DEFS[TechId.festivals].cost[GoodId.ale],
    );

    let guard = 20 * 120;
    while ((abbey.researchNeeds?.[GoodId.ale] ?? 0) > 0 && guard-- > 0)
      tickWorld(world, []);
    expect(abbey.researchNeeds?.[GoodId.ale]).toBe(0);
    expect(abbey.researchNeeds?.[GoodId.silver]).toBeGreaterThan(0);
    expect(world.players[0]!.techs.active?.started).toBe(false);

    // A matcher pass with the ale line settled: its clock goes, and the
    // silver still owed keeps its own.
    run(world, MATCHER_INTERVAL + 1);
    expect(abbey.demandSince[GoodId.ale]).toBeUndefined();
    expect(abbey.demandSince[GoodId.silver]).toBeDefined();
  });

  it('drops the order if the Abbey falls before the books open', () => {
    const world = bareWorld();
    setupSchool(world);
    tickWorld(
      world,
      cmds({kind: CommandKind.research, tech: TechId.cobbledBoots}),
    );
    destroyBuilding(world, abbeyOf(world));
    run(world, 2);
    // The slot is free again — with no Abbey standing the order cannot be
    // re-given, but nothing is left pinned to a roof that is gone.
    expect(world.players[0]!.techs.active).toBeUndefined();
    run(world, 20);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('enforces prereqs and one-at-a-time', () => {
    const world = bareWorld();
    setupSchool(world);
    // deepMining requires ironworking — rejected. (Ironworking itself is a
    // craft root now: the tool economy cannot wait on boots.)
    tickWorld(
      world,
      cmds({kind: CommandKind.research, tech: TechId.deepMining}),
    );
    expect(world.players[0]!.techs.active).toBeUndefined();

    tickWorld(
      world,
      cmds({kind: CommandKind.research, tech: TechId.cobbledBoots}),
    );
    expect(world.players[0]!.techs.active?.tech).toBe(TechId.cobbledBoots);
    // A second research while active — rejected.
    tickWorld(
      world,
      cmds({kind: CommandKind.research, tech: TechId.irrigation}),
    );
    expect(world.players[0]!.techs.active?.tech).toBe(TechId.cobbledBoots);
  });

  it('lets a village research Archery without ever buying Soldiery', () => {
    // The two-root claim, tested where prereqs are actually enforced.
    // `canResearch` is the only place that reads TechDef.prereqs, and only
    // the research COMMAND reaches it — a test that pushes an id into
    // `techs.researched` bypasses the check entirely, which is why the
    // Archery Range's own gate test in combat.test.ts cannot stand for this
    // one however few techs it grants.
    //
    // Soldiery is never bought here. If Archery goes back behind it, the
    // command is refused and `active` stays undefined.
    const world = bareWorld();
    setupSchool(world);
    expect(world.players[0]!.techs.researched).not.toContain(TechId.soldiery);
    tickWorld(world, cmds({kind: CommandKind.research, tech: TechId.archery}));
    expect(world.players[0]!.techs.active?.tech).toBe(TechId.archery);

    runHaul(world);
    run(world, TECH_DEFS[TechId.archery].durationTicks + 2);
    expect(world.players[0]!.techs.researched).toContain(TechId.archery);
    expect(world.players[0]!.techs.researched).not.toContain(TechId.soldiery);
    // And the roof the bow trains under comes with it, so the whole line is
    // reachable from this root alone.
    expect(isBuildingUnlocked(world, 0, BuildingTypeId.archeryRange)).toBe(
      true,
    );
  });

  it('gates buildings until researched', () => {
    const world = bareWorld();
    setupSchool(world);
    // The Smith itself is ungated (the village's only tool source), so the
    // iron mine carries this test now.
    expect(isBuildingUnlocked(world, 0, BuildingTypeId.weaponsmith)).toBe(true);
    expect(isBuildingUnlocked(world, 0, BuildingTypeId.ironMine)).toBe(false);

    tickWorld(
      world,
      cmds({
        kind: CommandKind.placeBuilding,
        building: BuildingTypeId.ironMine,
        x: 40,
        y: 40,
      }),
    );
    expect(
      [...world.buildings.values()].some(
        b => b.type === BuildingTypeId.ironMine,
      ),
    ).toBe(false);

    world.players[0]!.techs.researched.push(TechId.ironworking);
    expect(isBuildingUnlocked(world, 0, BuildingTypeId.ironMine)).toBe(true);
  });

  it('masonry unlocks paving', () => {
    const world = bareWorld();
    setupSchool(world);
    expect(world.players[0]!.pavingUnlocked).toBe(false);
    world.players[0]!.techs.researched.push(TechId.cobbledBoots);
    tickWorld(world, cmds({kind: CommandKind.research, tech: TechId.masonry}));
    runHaul(world);
    run(world, TECH_DEFS[TechId.masonry].durationTicks + 2);
    expect(world.players[0]!.pavingUnlocked).toBe(true);
  });

  it('festival: abbey burns ale for a work-speed buff', () => {
    const world = bareWorld();
    setupSchool(world);
    world.players[0]!.techs.researched.push(
      TechId.irrigation,
      TechId.brewing,
      TechId.festivals,
    );
    const tera = abbeyOf(world);
    tera.inputs[GoodId.ale] = 1;
    // Exactly one barrel in the world, so this is one festival and not a
    // standing party: the fixture's serfs would otherwise keep the Abbey
    // topped up from the shelf and the buff would never lapse.
    const sh = [...world.buildings.values()].find(
      b => b.type === BuildingTypeId.storehouse,
    )!;
    sh.stock[GoodId.ale] = 0;

    tickWorld(world, []);
    expect(world.players[0]!.techs.festivalTicksLeft).toBeGreaterThan(0);
    expect(tera.inputs[GoodId.ale] ?? 0).toBe(0);
    expect(getModifier(world, 0, ModifierKey.workSpeed)).toBeCloseTo(1.25);

    run(world, FESTIVAL_DURATION + 2);
    expect(getModifier(world, 0, ModifierKey.workSpeed)).toBe(1);
  });

  it('modifiers speed up production batches', () => {
    const world = bareWorld();
    const farm = placeBuiltBuilding(world, BuildingTypeId.wheatFarm, 0, 30, 30);
    staffBuilding(world, farm);
    farm.inputs[GoodId.water] = 2;
    world.players[0]!.techs.researched.push(TechId.irrigation);
    run(world, 2); // batch starts with the modifier applied
    expect(farm.prodTicksLeft).toBeLessThan(200); // 200 base / 1.3 ≈ 154
  });

  it('millstones speeds the mill and the bakery', () => {
    const world = bareWorld();
    const mill = placeBuiltBuilding(world, BuildingTypeId.mill, 0, 30, 30);
    mill.inputs[GoodId.wheat] = 1;
    const bakery = placeBuiltBuilding(world, BuildingTypeId.bakery, 0, 40, 30);
    staffBuilding(world, bakery);
    bakery.inputs[GoodId.flour] = 1;
    bakery.inputs[GoodId.water] = 1;
    world.players[0]!.techs.researched.push(
      TechId.irrigation,
      TechId.millstones,
    );
    expect(getModifier(world, 0, ModifierKey.foodSpeed)).toBeCloseTo(1.3);
    run(world, 2);
    expect(mill.prodTicksLeft).toBeLessThan(160); // 160 base / 1.3 ≈ 123
    expect(bakery.prodTicksLeft).toBeLessThan(240); // 240 base / 1.3 ≈ 185
  });

  it('bellows speeds the weaponsmith', () => {
    const world = bareWorld();
    const smith = placeBuiltBuilding(
      world,
      BuildingTypeId.weaponsmith,
      0,
      30,
      30,
    );
    smith.recipeIndex = 0; // pinned on spears (default is auto)
    staffBuilding(world, smith);
    smith.inputs[GoodId.iron] = 1;
    smith.inputs[GoodId.wood] = 2;
    world.players[0]!.techs.researched.push(
      TechId.cobbledBoots,
      TechId.ironworking,
      TechId.bellows,
    );
    run(world, 2);
    expect(smith.prodTicksLeft).toBeLessThan(200); // spear: 200 base / 1.3 ≈ 154
  });

  it('ale rations: the barracks cask is kept topped up', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {[GoodId.ale]: 10});
    world.players[0]!.techs.researched.push(
      TechId.irrigation,
      TechId.brewing,
      TechId.festivals,
      TechId.aleRations,
    );
    const barracks = placeBuiltBuilding(
      world,
      BuildingTypeId.barracks,
      0,
      36,
      30,
    );
    addSerf(world, 34, 34);
    run(world, 20 * 60);
    expect(barracks.inputs[GoodId.ale]).toBe(BARRACKS_ALE_CAP);
  });

  it('ale rations: the recruit drinks from the cask and trains faster', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {[GoodId.food]: 10, [GoodId.spear]: 1});
    world.players[0]!.techs.researched.push(
      TechId.irrigation,
      TechId.brewing,
      TechId.festivals,
      TechId.aleRations,
      TechId.soldiery,
    );
    const barracks = placeBuiltBuilding(
      world,
      BuildingTypeId.barracks,
      0,
      36,
      30,
    );
    barracks.inputs[GoodId.ale] = 1;
    addSerf(world, 34, 34);
    tickWorld(
      world,
      cmds({
        kind: CommandKind.trainUnit,
        buildingId: barracks.id,
        unit: UnitTypeId.spearman,
      }),
    );

    let guard = 20 * 120;
    while (!barracks.trainQueue?.[0]?.started && guard-- > 0)
      tickWorld(world, []);
    const head = barracks.trainQueue?.[0];
    expect(head?.started).toBe(true);
    // The 200-tick course was set to 200 / 1.25 = 160 at enlistment (the
    // range absorbs the decrements of the tick that flipped `started`).
    expect(head!.ticksLeft).toBeGreaterThan(150);
    expect(head!.ticksLeft).toBeLessThanOrEqual(160);
    expect(barracks.inputs[GoodId.ale] ?? 0).toBe(0); // the drink was drunk
  });
});
