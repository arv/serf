import {describe, expect, it} from 'vitest';
import * as AdminAction from './adminActionEnum.ts';
import * as CommandKind from './commandKindEnum.ts';
import {checkInvariants} from './debug/invariants.ts';
import {
  ABBEY_ALE_CAP,
  BARRACKS_ALE_CAP,
  FESTIVAL_DURATION,
  FESTIVAL_SPEEDUP,
  MATCHER_INTERVAL,
} from './defs/balance.ts';
import {buildingDef} from './defs/buildings.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as GoodId from './defs/goodIdEnum.ts';
import {goodEntries} from './defs/goods.ts';
import * as ModifierKey from './defs/modifierKeyEnum.ts';
import * as TechId from './defs/techIdEnum.ts';
import {TECH_DEFS} from './defs/techs.ts';
import {UNIT_DEFS} from './defs/units.ts';
import * as UnitTypeId from './defs/unitTypeIdEnum.ts';
import {BANDIT} from './entities.ts';
import * as HaulPhase from './haulPhaseEnum.ts';
import {getModifier, isBuildingUnlocked} from './techHelpers.ts';
import {
  cmds,
  addSerf,
  addStorehouse,
  bareWorld,
  staffBuilding,
} from './testUtils.ts';
import {applyCommand, tickWorld} from './tick.ts';
import type {Unit} from './units.ts';
import {
  destroyBuilding,
  placeBuiltBuilding,
  spawnUnit,
  type World,
} from './world.ts';

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

  it('the study begins on the tick the last load lands', () => {
    // researchSystem runs BEFORE logisticsSystem in a tick (tick.ts), so a
    // bill settled at the Abbey's door during the haul pass is a bill the
    // research pass has already looked at. Left to the next tick, the beat
    // between them is observable: a snapshot with `started` false and
    // nothing left to carry, which is a study the panel draws as still
    // being delivered when the last barrel is already inside.
    const world = bareWorld();
    setupSchool(world);
    tickWorld(
      world,
      cmds({kind: CommandKind.research, tech: TechId.cobbledBoots}),
    );
    const abbey = abbeyOf(world);
    let guard = 20 * 120;
    while (abbey.researchNeeds && guard-- > 0) tickWorld(world, []);
    expect(abbey.researchNeeds).toBeUndefined();
    expect(world.players[0]!.techs.active?.started).toBe(true);
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

  it('the masons take the stone before the scholars do', () => {
    // An Abbey can owe two bills in the same good at once: an ordered
    // repair (tier 1) and a study billed in stone (tier 2). The board
    // ranks them and main's repair pull goes further still, dragging the
    // loads already walking up to the repair's tier — all of which is
    // undone at the door if the study takes whatever arrives. One stone in
    // the whole world, so which bill gets it is not a matter of timing.
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, {
      [GoodId.stone]: 1,
      [GoodId.silver]: 20,
    });
    const abbey = placeBuiltBuilding(world, BuildingTypeId.abbey, 0, 24, 30);
    abbey.hp = buildingDef(BuildingTypeId.abbey).hp * 0.2;
    for (let i = 0; i < 4; i++) addSerf(world, 28, 32 + i);
    tickWorld(
      world,
      cmds(
        {
          kind: CommandKind.setBuildingRepair,
          buildingId: abbey.id,
          repair: true,
        },
        {kind: CommandKind.research, tech: TechId.ironworking},
      ),
    );
    // Both want stone, and there is one to be had.
    expect(abbey.repairNeeds?.[GoodId.stone]).toBeGreaterThan(0);
    expect(abbey.researchNeeds?.[GoodId.stone]).toBeGreaterThan(0);
    const repairWanted = abbey.repairNeeds![GoodId.stone]!;
    const studyWanted = abbey.researchNeeds![GoodId.stone]!;

    // Until the stone is through a door, not merely off the shelf: the
    // storehouse empties at the pickup and there is a walk after that.
    const owed = (): number =>
      (abbey.repairNeeds?.[GoodId.stone] ?? 0) +
      (abbey.researchNeeds?.[GoodId.stone] ?? 0);
    const before = owed();
    let guard = 20 * 120;
    while (owed() === before && guard-- > 0) tickWorld(world, []);
    expect(sh.stock[GoodId.stone] ?? 0).toBe(0);

    expect(abbey.repairNeeds?.[GoodId.stone]).toBe(repairWanted - 1);
    expect(abbey.researchNeeds?.[GoodId.stone]).toBe(studyWanted);
    expect(checkInvariants(world).violations).toEqual([]);
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

  it('a study nobody can supply can be called off, and the slot opens', () => {
    // The trap ordering-on-credit opens, and the way out of it. Gilded
    // Arms is billed in GOLD, which a village without Deep Mining has no
    // way to dig: the bill sits on the Abbey forever, and a seat studies
    // one thing at a time, so the whole tree waits behind it.
    const world = bareWorld();
    setupSchool(world);
    const p = world.players[0]!;
    p.techs.researched.push(TechId.soldiery, TechId.mailArmor);
    tickWorld(
      world,
      cmds({kind: CommandKind.research, tech: TechId.gildedArms}),
    );
    const abbey = abbeyOf(world);
    expect(p.techs.active?.tech).toBe(TechId.gildedArms);
    // The silver half is carried; the gold half never can be.
    run(world, 20 * 30);
    expect(p.techs.active?.started).toBe(false);
    expect(abbey.researchNeeds?.[GoodId.gold]).toBeGreaterThan(0);

    tickWorld(
      world,
      cmds({kind: CommandKind.cancelResearch, tech: TechId.gildedArms}),
    );
    expect(p.techs.active).toBeUndefined();
    // The bill goes with the order — an Abbey left asking for gold would
    // keep the matcher booking hauls for a study nobody is doing.
    expect(abbey.researchNeeds).toBeUndefined();
    // Its clock is the matcher's to forget, and nothing else at this Abbey
    // wants gold: the next pass lets it lapse.
    run(world, MATCHER_INTERVAL);
    expect(abbey.demandSince[GoodId.gold]).toBeUndefined();

    // And the tree is open again.
    tickWorld(
      world,
      cmds({kind: CommandKind.research, tech: TechId.cobbledBoots}),
    );
    expect(p.techs.active?.tech).toBe(TechId.cobbledBoots);
    runHaul(world);
    run(world, TECH_DEFS[TechId.cobbledBoots].durationTicks + 2);
    expect(p.techs.researched).toContain(TechId.cobbledBoots);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('a cancelled study spends what is in and sends the rest home', () => {
    // The two halves of an abandoned bill. What went through the Abbey's
    // door was consumed at the threshold and cannot come back — the Abbey
    // has no shelf to take it off. What is still on a serf's back is not
    // lost with it: the bill's absence is what the reconciler reads to
    // find that load another home, so the village's books balance either
    // way (checkInvariants counts carried goods).
    const world = bareWorld();
    setupSchool(world);
    tickWorld(
      world,
      cmds({kind: CommandKind.research, tech: TechId.cobbledBoots}),
    );
    const abbey = abbeyOf(world);
    const total = goodEntries(TECH_DEFS[TechId.cobbledBoots].cost).reduce(
      (n, [, want]) => n + want,
      0,
    );
    // Wait for the first load to land, and no longer: the bill must still
    // be open, with hands on the road behind it.
    let guard = 20 * 120;
    const left = () =>
      goodEntries(abbey.researchNeeds ?? {}).reduce((n, [, w]) => n + w, 0);
    while (abbey.researchNeeds && left() === total && guard-- > 0)
      tickWorld(world, []);
    expect(abbey.researchNeeds).toBeDefined();
    expect(left()).toBeLessThan(total);

    tickWorld(
      world,
      cmds({kind: CommandKind.cancelResearch, tech: TechId.cobbledBoots}),
    );
    expect(world.players[0]!.techs.active).toBeUndefined();
    // The serfs settle: whoever was walking to the Abbey takes his load
    // somewhere else rather than standing in the road with it.
    run(world, 20 * 20);
    expect([...world.units.values()].some(u => u.carrying !== undefined)).toBe(
      false,
    );
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('a cancelled study calls back the loads still walking, that tick', () => {
    // Copilot review, PR #273. The haul reconciler would find these jobs
    // on its own — but it runs one pass in MATCHER_INTERVAL ticks, and in
    // the ticks between, an open study haul can still be dispatched and a
    // walking one can still reach the door. With the bill gone, deliverGood
    // has no study branch left to take and the load lands on the Abbey's
    // shelf, which is not a shelf anything ever leaves from. So the order
    // calls its own hauls back, the way cancelRepair does.
    const world = bareWorld();
    setupSchool(world);
    tickWorld(
      world,
      cmds({kind: CommandKind.research, tech: TechId.cobbledBoots}),
    );
    const abbey = abbeyOf(world);
    // Wait for a load to be off the shelf and on a back, walking in.
    const walking = (): boolean =>
      [...world.jobs.values()].some(
        j => j.research && j.phase === HaulPhase.toDropoff,
      );
    let guard = 20 * 120;
    while (!walking() && guard-- > 0) tickWorld(world, []);
    expect(walking()).toBe(true);

    // Through applyCommand rather than a tick, so nothing else runs
    // between the order and the reading below: a tick would carry a
    // logistics pass with it, and on one tick in MATCHER_INTERVAL that
    // pass reconciles — which is the very thing this order must not have
    // to wait for.
    applyCommand(world, 0, {
      kind: CommandKind.cancelResearch,
      tech: TechId.cobbledBoots,
    });
    // Not one study job left on the board, and the good is still in hand.
    expect([...world.jobs.values()].some(j => j.research)).toBe(false);
    expect(
      [...world.units.values()].some(u => !u.dead && u.carrying !== undefined),
    ).toBe(true);

    // Less than a reconcile pass later, nothing has been left at the Abbey.
    run(world, MATCHER_INTERVAL - 1);
    const onAbbeyShelf = goodEntries(abbey.stock).reduce(
      (n, [, k]) => n + k,
      0,
    );
    expect(onAbbeyShelf).toBe(0);

    // And the load finds a home rather than being carried forever.
    run(world, 20 * 20);
    expect(
      [...world.units.values()].some(u => !u.dead && u.carrying !== undefined),
    ).toBe(false);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it("a cancelled study leaves the masons' clock where it was", () => {
    // Copilot review, PR #273. The FIFO age is per (building, good) while
    // the demands are not, and the Abbey is where two of them collide: an
    // ordered repair in stone and a study billed in stone keep one key
    // between them. Dropping it with the study would reset the repair's
    // age to the cancellation tick and send it to the back of tier 1. The
    // matcher's pass is what decides now (settleAges in
    // systems/logistics.ts), and it finds the repair still holding it.
    const world = bareWorld();
    addStorehouse(world, 30, 30, {[GoodId.silver]: 20});
    const abbey = placeBuiltBuilding(world, BuildingTypeId.abbey, 0, 24, 30);
    abbey.hp = buildingDef(BuildingTypeId.abbey).hp * 0.2;
    for (let i = 0; i < 4; i++) addSerf(world, 28, 32 + i);
    // No stone anywhere, so both bills stay open and the clock keeps
    // running for the whole test.
    tickWorld(
      world,
      cmds(
        {
          kind: CommandKind.setBuildingRepair,
          buildingId: abbey.id,
          repair: true,
        },
        {kind: CommandKind.research, tech: TechId.ironworking},
      ),
    );
    expect(abbey.repairNeeds?.[GoodId.stone]).toBeGreaterThan(0);
    expect(abbey.researchNeeds?.[GoodId.stone]).toBeGreaterThan(0);
    run(world, MATCHER_INTERVAL + 1);
    const since = abbey.demandSince[GoodId.stone];
    expect(since).toBeDefined();

    tickWorld(
      world,
      cmds({kind: CommandKind.cancelResearch, tech: TechId.ironworking}),
    );
    expect(world.players[0]!.techs.active).toBeUndefined();
    expect(abbey.researchNeeds).toBeUndefined();
    // The masons still want their stone, and still want it from when they
    // first asked.
    expect(abbey.repairNeeds?.[GoodId.stone]).toBeGreaterThan(0);
    expect(abbey.demandSince[GoodId.stone]).toBe(since);
    // ...and still do once the matcher has been round and found the study
    // gone: the repair was holding the clock beside it, so it goes on.
    run(world, MATCHER_INTERVAL);
    expect(abbey.demandSince[GoodId.stone]).toBe(since);
  });

  it("a cancelled study leaves the festival's clock alone too", () => {
    // Copilot review, PR #273, round two of the same finding: a repair is
    // not the only other demand that can be standing in a good's queue.
    // With Festivals in, the Abbey has a standing want for ale of its own
    // (systems/logistics.ts), and an Ale Rations bill is written in the
    // same barrel — so calling that study off must leave the buff's clock
    // where it was — and the matcher's next pass, which walks both
    // demands, finds the festival still asking and lets the clock go on.
    const world = bareWorld();
    // No ale anywhere: the Abbey's standing want and the study's bill both
    // stay open for the whole test.
    addStorehouse(world, 30, 30, {[GoodId.silver]: 20});
    const abbey = placeBuiltBuilding(world, BuildingTypeId.abbey, 0, 24, 30);
    for (let i = 0; i < 4; i++) addSerf(world, 28, 32 + i);
    world.players[0]!.techs.researched.push(
      TechId.irrigation,
      TechId.brewing,
      TechId.festivals,
    );
    tickWorld(
      world,
      cmds({kind: CommandKind.research, tech: TechId.aleRations}),
    );
    expect(abbey.researchNeeds?.[GoodId.ale]).toBeGreaterThan(0);
    run(world, MATCHER_INTERVAL + 1);
    const since = abbey.demandSince[GoodId.ale];
    expect(since).toBeDefined();

    tickWorld(
      world,
      cmds({kind: CommandKind.cancelResearch, tech: TechId.aleRations}),
    );
    expect(world.players[0]!.techs.active).toBeUndefined();
    expect(abbey.researchNeeds).toBeUndefined();
    // The festival still wants its barrel, and still asked for it first.
    expect(abbey.demandSince[GoodId.ale]).toBe(since);
    run(world, MATCHER_INTERVAL);
    expect(abbey.demandSince[GoodId.ale]).toBe(since);
  });

  it('a festival that opens behind a cancelled study starts its own age', () => {
    // The gap the matcher cannot see into by itself. It walks the Abbey
    // one tick in MATCHER_INTERVAL, and between two passes the festival's
    // cask can run dry and a study billed in ale be called off — which,
    // from the next pass, reads like one ale demand that never stopped.
    // It was not one: the festival had its barrels and was asking for
    // nothing while the study stood in the queue, so the age it gets is
    // its own, not the study's.
    const world = bareWorld();
    // Silver for the study's other line, and no ale anywhere: its ale line
    // stays open, and its clock runs for as long as the study stands.
    addStorehouse(world, 30, 30, {[GoodId.silver]: 20});
    const abbey = placeBuiltBuilding(world, BuildingTypeId.abbey, 0, 24, 30);
    for (let i = 0; i < 4; i++) addSerf(world, 28, 32 + i);
    const techs = world.players[0]!.techs;
    techs.researched.push(TechId.irrigation, TechId.brewing, TechId.festivals);
    // A full cask and a festival already running, so the buff neither
    // wants a barrel nor drinks one until the test empties it.
    abbey.inputs[GoodId.ale] = ABBEY_ALE_CAP;
    world.ledger.produced[GoodId.ale] =
      (world.ledger.produced[GoodId.ale] ?? 0) + ABBEY_ALE_CAP;
    techs.festivalTicksLeft = 20 * 600;
    tickWorld(
      world,
      cmds({kind: CommandKind.research, tech: TechId.aleRations}),
    );
    run(world, MATCHER_INTERVAL * 3);
    const since = abbey.demandSince[GoodId.ale]!;
    expect(since).toBeDefined();

    // Between two passes: the cask runs dry, then the study is called off.
    // That order is the one an answer given at the moment of cancelling
    // gets wrong — asked then, the festival is already short, and it would
    // have kept the study's clock as its own.
    abbey.inputs[GoodId.ale] = 0;
    world.ledger.consumed[GoodId.ale] =
      (world.ledger.consumed[GoodId.ale] ?? 0) + ABBEY_ALE_CAP;
    applyCommand(world, 0, {
      kind: CommandKind.cancelResearch,
      tech: TechId.aleRations,
    });
    const gap = world.tick;
    run(world, MATCHER_INTERVAL);
    expect(abbey.demandSince[GoodId.ale]).toBeGreaterThanOrEqual(gap);
    expect(abbey.demandSince[GoodId.ale]).toBeGreaterThan(since);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('a study re-ordered between passes does not inherit the one it replaced', () => {
    // The same gap with a bill of the same kind in it: a study called off
    // and another written in the same stone before the matcher comes
    // round looks, from the next pass, like one study that never stopped.
    // What tells them apart is the mark the first takes off the clock as
    // it goes (releaseDemandHold, world.ts) — without it the new study
    // would stand at the head of its tier on the strength of the old one.
    const world = bareWorld();
    // No stone anywhere, so the stone line stays open throughout.
    addStorehouse(world, 30, 30, {[GoodId.silver]: 20});
    const abbey = placeBuiltBuilding(world, BuildingTypeId.abbey, 0, 24, 30);
    for (let i = 0; i < 4; i++) addSerf(world, 28, 32 + i);
    tickWorld(
      world,
      cmds({kind: CommandKind.research, tech: TechId.ironworking}),
    );
    expect(abbey.researchNeeds?.[GoodId.stone]).toBeGreaterThan(0);
    run(world, MATCHER_INTERVAL * 3);
    const since = abbey.demandSince[GoodId.stone]!;
    expect(since).toBeDefined();

    applyCommand(world, 0, {
      kind: CommandKind.cancelResearch,
      tech: TechId.ironworking,
    });
    applyCommand(world, 0, {
      kind: CommandKind.research,
      tech: TechId.ironworking,
    });
    expect(abbey.researchNeeds?.[GoodId.stone]).toBeGreaterThan(0);
    const gap = world.tick;
    run(world, MATCHER_INTERVAL);
    expect(abbey.demandSince[GoodId.stone]).toBeGreaterThanOrEqual(gap);
    expect(abbey.demandSince[GoodId.stone]).toBeGreaterThan(since);
  });

  it('the debug lever finishes a study without stranding its loads', () => {
    // Copilot review, PR #273, round three. finishResearch is the one path
    // that settles a bill with loads still walking: it tears the bill up
    // rather than paying it, so those hauls need the same call back a
    // cancelled study gives them, or they arrive at a door with no bill
    // behind it and land on the Abbey's shelf.
    const world = bareWorld();
    setupSchool(world);
    const abbey = abbeyOf(world);
    tickWorld(
      world,
      cmds({kind: CommandKind.research, tech: TechId.cobbledBoots}),
    );
    let guard = 20 * 120;
    while (
      ![...world.jobs.values()].some(
        j => j.research && j.phase === HaulPhase.toDropoff,
      ) &&
      guard-- > 0
    )
      tickWorld(world, []);

    tickWorld(
      world,
      cmds({kind: CommandKind.admin, action: AdminAction.finishResearch}),
    );
    expect([...world.jobs.values()].some(j => j.research)).toBe(false);
    run(world, MATCHER_INTERVAL - 1);
    const onAbbeyShelf = goodEntries(abbey.stock).reduce(
      (n, [, k]) => n + k,
      0,
    );
    expect(onAbbeyShelf).toBe(0);
    run(world, 20 * 20);
    expect(world.players[0]!.techs.researched).toContain(TechId.cobbledBoots);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it("a settled repair leaves the scholars' clock where it was", () => {
    // Copilot review, PR #273, round five — the reverse of the case two
    // tests up. An Abbey can owe a repair in stone and a study billed in
    // stone at once, and whichever bill finishes first must leave the
    // other's age alone. The study side already asked before dropping a
    // clock; the repair side still dropped them all, so a repair settling
    // first erased an age the scholars had been keeping since before it.
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, {[GoodId.silver]: 20});
    const abbey = placeBuiltBuilding(world, BuildingTypeId.abbey, 0, 24, 30);
    abbey.hp = buildingDef(BuildingTypeId.abbey).hp * 0.2;
    for (let i = 0; i < 4; i++) addSerf(world, 28, 32 + i);
    tickWorld(
      world,
      cmds(
        {
          kind: CommandKind.setBuildingRepair,
          buildingId: abbey.id,
          repair: true,
        },
        {kind: CommandKind.research, tech: TechId.ironworking},
      ),
    );
    expect(abbey.repairNeeds?.[GoodId.stone]).toBeGreaterThan(0);
    expect(abbey.researchNeeds?.[GoodId.stone]).toBeGreaterThan(0);

    // Exactly the masons' bill and not a stone more: the repair can finish
    // and the study is left wanting, which is the arrangement under test.
    for (const [good, n] of goodEntries(abbey.repairNeeds!)) {
      sh.stock[good] = (sh.stock[good] ?? 0) + n;
      world.ledger.produced[good] = (world.ledger.produced[good] ?? 0) + n;
    }
    let guard = 20 * 120;
    while (abbey.demandSince[GoodId.stone] === undefined && guard-- > 0)
      tickWorld(world, []);
    const since = abbey.demandSince[GoodId.stone];
    expect(since).toBeDefined();

    guard = 20 * 120;
    while (abbey.repairNeeds && guard-- > 0) tickWorld(world, []);
    expect(abbey.repairNeeds).toBeUndefined();
    // A pass after the repair is gone, so the reading below is the
    // matcher's verdict and not merely the moment before it.
    run(world, MATCHER_INTERVAL);

    // The scholars are still short their stone, and still asked for it
    // when they asked for it.
    expect(abbey.researchNeeds?.[GoodId.stone]).toBeGreaterThan(0);
    expect(abbey.demandSince[GoodId.stone]).toBe(since);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('calls the hauls back even when the Abbey is already gone', () => {
    // Copilot review, PR #273, round six. A destroyed building is swept
    // from the map at the end of its tick (tick.ts) while techs.active
    // still names it until researchSystem runs — so a cancel arriving in
    // that window finds no building. The hauls must still be called back:
    // the reconciler stands a carrier down for a vanished destination
    // WITHOUT keeping his cargo, so the load would be destroyed rather
    // than carried home.
    const world = bareWorld();
    setupSchool(world);
    tickWorld(
      world,
      cmds({kind: CommandKind.research, tech: TechId.cobbledBoots}),
    );
    const abbey = abbeyOf(world);
    let guard = 20 * 120;
    while (
      ![...world.jobs.values()].some(
        j => j.research && j.phase === HaulPhase.toDropoff,
      ) &&
      guard-- > 0
    )
      tickWorld(world, []);

    // The roof falls and is reaped, exactly as a tick would leave it.
    destroyBuilding(world, abbey);
    world.buildings.delete(abbey.id);
    applyCommand(world, 0, {
      kind: CommandKind.cancelResearch,
      tech: TechId.cobbledBoots,
    });
    expect([...world.jobs.values()].some(j => j.research)).toBe(false);
    // Still in his hands, not written off.
    expect(
      [...world.units.values()].some(u => !u.dead && u.carrying !== undefined),
    ).toBe(true);
    run(world, 20 * 20);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('a halted Abbey keeps the festival clock it was standing on', () => {
    // Copilot review, PR #273, round six. Halting a roof stops the matcher
    // offering it anything — the standing-demand branch is skipped outright
    // and the clock left alone — so pausing must not turn a settling or
    // cancelled study into the thing that forgets it. The lever suppresses
    // matching, not the queue place.
    const world = bareWorld();
    addStorehouse(world, 30, 30, {[GoodId.silver]: 20});
    const abbey = placeBuiltBuilding(world, BuildingTypeId.abbey, 0, 24, 30);
    for (let i = 0; i < 4; i++) addSerf(world, 28, 32 + i);
    world.players[0]!.techs.researched.push(
      TechId.irrigation,
      TechId.brewing,
      TechId.festivals,
    );
    tickWorld(
      world,
      cmds({kind: CommandKind.research, tech: TechId.aleRations}),
    );
    run(world, MATCHER_INTERVAL + 1);
    const since = abbey.demandSince[GoodId.ale];
    expect(since).toBeDefined();

    tickWorld(
      world,
      cmds({
        kind: CommandKind.setBuildingPaused,
        buildingId: abbey.id,
        paused: true,
      }),
    );
    tickWorld(
      world,
      cmds({kind: CommandKind.cancelResearch, tech: TechId.aleRations}),
    );
    expect(abbey.demandSince[GoodId.ale]).toBe(since);
    // And the pass after: the lever keeps the festival's mark as it stood
    // (PAUSABLE in systems/logistics.ts), so the study's going leaves the
    // festival holding the clock rather than nobody.
    run(world, MATCHER_INTERVAL);
    expect(abbey.demandSince[GoodId.ale]).toBe(since);
  });

  it('a rehomed load is marked for the bill it is walking into', () => {
    // Copilot review, PR #273, round six. A roof can be mending and
    // studying in the same good, and rehomeCarriedGoods routes a stray
    // load to the masons first (deliveryTargetFor) — but it used to mark
    // the job as the STUDY's whenever a study bill existed, so calling the
    // study off called this repair load back with it.
    const world = bareWorld();
    // An empty shelf, so no haul can be booked from it and the stray load
    // below is the only thing on the board: with silver to fetch, the
    // matcher takes the one pair of hands before the orphaned-cargo pass
    // ever sees them.
    addStorehouse(world, 30, 30, {});
    const abbey = placeBuiltBuilding(world, BuildingTypeId.abbey, 0, 24, 30);
    abbey.hp = buildingDef(BuildingTypeId.abbey).hp * 0.2;
    const serf = addSerf(world, 26, 31);
    tickWorld(
      world,
      cmds(
        {
          kind: CommandKind.setBuildingRepair,
          buildingId: abbey.id,
          repair: true,
        },
        {kind: CommandKind.research, tech: TechId.ironworking},
      ),
    );
    expect(abbey.repairNeeds?.[GoodId.stone]).toBeGreaterThan(0);
    expect(abbey.researchNeeds?.[GoodId.stone]).toBeGreaterThan(0);

    // A stone in his hands and no job to explain it: the orphaned-cargo
    // path is what books the delivery.
    serf.carrying = GoodId.stone;
    world.ledger.produced[GoodId.stone] =
      (world.ledger.produced[GoodId.stone] ?? 0) + 1;
    let guard = 20 * 60;
    while (serf.jobId === undefined && guard-- > 0) tickWorld(world, []);
    const job = world.jobs.get(serf.jobId!)!;
    expect(job.to).toBe(abbey.id);
    expect(job.repair).toBe(true);
    expect(job.research).toBeUndefined();
  });

  it('the debug lever calls the hauls back even with the Abbey gone', () => {
    // Copilot review, PR #273, round seven: the same reaped-roof window as
    // the cancel, on the lever's path. `active` names an Abbey that is
    // already off the map until researchSystem runs, and hauls left for
    // the reconciler in that window are stood down WITHOUT their cargo.
    const world = bareWorld();
    setupSchool(world);
    tickWorld(
      world,
      cmds({kind: CommandKind.research, tech: TechId.cobbledBoots}),
    );
    const abbey = abbeyOf(world);
    let guard = 20 * 120;
    while (
      ![...world.jobs.values()].some(
        j => j.research && j.phase === HaulPhase.toDropoff,
      ) &&
      guard-- > 0
    )
      tickWorld(world, []);

    destroyBuilding(world, abbey);
    world.buildings.delete(abbey.id);
    applyCommand(world, 0, {
      kind: CommandKind.admin,
      action: AdminAction.finishResearch,
    });
    expect([...world.jobs.values()].some(j => j.research)).toBe(false);
    expect(
      [...world.units.values()].some(u => !u.dead && u.carrying !== undefined),
    ).toBe(true);
    run(world, 20 * 20);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('a stale cancel misses rather than striking the next study', () => {
    // cancelForge's rule, applied to the tree: an order given as one study
    // finishes must not call off whatever the seat took up after it.
    const world = bareWorld();
    setupSchool(world);
    tickWorld(
      world,
      cmds({kind: CommandKind.research, tech: TechId.cobbledBoots}),
    );
    tickWorld(
      world,
      cmds({kind: CommandKind.cancelResearch, tech: TechId.irrigation}),
    );
    expect(world.players[0]!.techs.active?.tech).toBe(TechId.cobbledBoots);
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
    // The same barrel reaches the field: one festival, two keys.
    expect(getModifier(world, 0, ModifierKey.fightSpeed)).toBeCloseTo(
      FESTIVAL_SPEEDUP,
    );

    run(world, FESTIVAL_DURATION + 2);
    expect(getModifier(world, 0, ModifierKey.workSpeed)).toBe(1);
    expect(getModifier(world, 0, ModifierKey.fightSpeed)).toBe(1);
  });

  /** Tick until each of the units has struck once — its cooldown going
   * above zero is how the blow is seen — and answer the clock each was set
   * to. Read the tick it happens, since a faster man is back at zero
   * sooner than a slower one. */
  function firstCooldowns(world: World, units: Unit[]): number[] {
    const seen: number[] = units.map(() => 0);
    for (let t = 0; t < 40 && seen.some(c => c === 0); t++) {
      tickWorld(world, []);
      units.forEach((u, i) => {
        if (seen[i] === 0 && u.cooldownLeft > 0) seen[i] = u.cooldownLeft;
      });
    }
    return seen;
  }

  it('festival: a soldier strikes faster, and the bandit he fights does not', () => {
    const world = bareWorld();
    world.players[0]!.techs.festivalTicksLeft = FESTIVAL_DURATION;
    const knight = spawnUnit(world, UnitTypeId.knight, 0, 30.5, 30.5);
    const marauder = spawnUnit(world, UnitTypeId.marauder, BANDIT, 31.5, 30.5);
    const [k, m] = firstCooldowns(world, [knight, marauder]);
    const printed = UNIT_DEFS[UnitTypeId.knight].combat!.cooldownTicks;
    expect(k).toBe(Math.round(printed / FESTIVAL_SPEEDUP));
    expect(k).toBeLessThan(printed);
    // The bandits have no player entry, and no player entry has no ale.
    expect(m).toBe(UNIT_DEFS[UnitTypeId.marauder].combat!.cooldownTicks);
  });

  it('festival: the seat that loses the mirror sober wins it drunk', () => {
    /** Four knights a side, mirrored; at most one seat is drinking. */
    const duel = (festival: 0 | 1 | null): [number, number] => {
      const world = bareWorld(1, 2);
      if (festival !== null)
        world.players[festival]!.techs.festivalTicksLeft = 20 * 120;
      for (let i = 0; i < 4; i++) {
        spawnUnit(
          world,
          UnitTypeId.knight,
          0,
          28.5 - (i % 2),
          28.5 + Math.floor(i / 2),
        );
        spawnUnit(
          world,
          UnitTypeId.knight,
          1,
          32.5 + (i % 2),
          28.5 + Math.floor(i / 2),
        );
      }
      run(world, 20 * 60);
      const alive = [...world.units.values()].filter(u => !u.dead);
      return [
        alive.filter(u => u.owner === 0).length,
        alive.filter(u => u.owner === 1).length,
      ];
    };
    // Sober, a mirror is a trade: one seat is wiped and the other paid
    // for it. Which seat is the sim's own tie-break, not the claim.
    const sober = duel(null);
    expect(Math.min(...sober)).toBe(0);
    expect(Math.max(...sober)).toBeLessThan(4);
    const loser = sober[0] === 0 ? 0 : 1;
    // Hand the losing seat the festival and the same eight men resolve
    // the other way: a quarter more blows per minute is a quarter more
    // power, and the square law turns that into the field.
    const drunk = duel(loser);
    expect(drunk[loser]).toBeGreaterThan(0);
    expect(drunk[1 - loser]).toBe(0);
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
