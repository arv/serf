import {describe, expect, it} from 'vitest';
import {tileIdx} from '../shared/grid.ts';
import {Rng} from '../shared/rng.ts';
import * as BuildingState from './buildingStateEnum.ts';
import * as CommandKind from './commandKindEnum.ts';
import {checkInvariants, checkLedger, countGoods} from './debug/invariants.ts';
import {RATION_STOCK} from './defs/balance.ts';
import * as BuildingTypeId from './defs/buildingTypeIdEnum.ts';
import * as GoodId from './defs/goodIdEnum.ts';
import type {GoodAmounts} from './defs/goods.ts';
import * as UnitTypeId from './defs/unitTypeIdEnum.ts';
import * as HaulPhase from './haulPhaseEnum.ts';
import {
  cmds,
  addBuiltHut,
  addSerf,
  addSite,
  addStorehouse,
  bareWorld,
  staffBuilding,
} from './testUtils.ts';
import {tickWorld} from './tick.ts';
import * as TileResource from './tileResourceEnum.ts';
import * as UnitTaskKind from './unitTaskKindEnum.ts';
import {
  destroyBuilding,
  killUnit,
  placeBuiltBuilding,
  type World,
} from './world.ts';

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) tickWorld(world, []);
}

function expectClean(world: World, initial?: GoodAmounts): void {
  const report = checkInvariants(world);
  expect(report.violations).toEqual([]);
  if (initial) expect(checkLedger(world, initial)).toEqual([]);
}

describe('logistics matcher', () => {
  it('creates jobs with reservations booked immediately', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, {[GoodId.wood]: 10});
    const site = addSite(world, 24, 30); // needs 6 wood + the hammer loan
    run(world, 1); // matcher fires at tick 0

    // Six wood, the borrowed hammer, and the axe pre-ordered for the post
    // the site will become.
    expect(world.jobs.size).toBe(8);
    expect(sh.reservedOut[GoodId.wood]).toBe(6);
    expect(site.inbound[GoodId.wood]).toBe(6);
    expect(site.inbound[GoodId.hammer]).toBe(1);
    expect(site.inbound[GoodId.axe]).toBe(1);
    expectClean(world);
  });

  it('never reserves more than stock', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, {[GoodId.wood]: 3});
    addSite(world, 24, 30); // needs 6
    run(world, 1);

    expect(world.jobs.size).toBe(5); // 3 wood + hammer + the post's axe
    expect(sh.reservedOut[GoodId.wood]).toBe(3);
    expectClean(world);
  });

  it('prioritizes construction over evacuation for the only serf', () => {
    const world = bareWorld();
    addStorehouse(world, 40, 40, {});
    const hut = addBuiltHut(world, 30, 30, false);
    hut.stock[GoodId.wood] = 2;
    const site = addSite(world, 34, 30);
    addSerf(world, 32, 33);
    run(world, 2);

    const assigned = [...world.jobs.values()].find(j => j.serfId !== undefined);
    expect(assigned).toBeDefined();
    expect(assigned!.priority).toBe(1);
    expect(assigned!.to).toBe(site.id);
    expectClean(world);
  });

  it('silver jumps the evacuation queue, older planks or not', () => {
    // A hire is paid from the castle's shelf, not the mine's, so silver
    // going home rides at 2 (EVAC_PRIORITY) while every other output rides
    // at 3 — and the dispatcher sorts on that before age, so the newer
    // silver job beats the older wood job for the only pair of hands.
    // Both posts staffed, so neither orders its tool (a priority-2 haul
    // of its own) and the only jobs on the board are the two evacuations.
    const world = bareWorld();
    addStorehouse(world, 40, 40, {});
    const hut = addBuiltHut(world, 30, 30);
    hut.stock[GoodId.wood] = 2;
    run(world, 6); // the wood job is on the board first
    const mine = placeBuiltBuilding(
      world,
      BuildingTypeId.silverMine,
      0,
      30,
      36,
    );
    staffBuilding(world, mine);
    mine.stock[GoodId.silver] = 1;
    run(world, 6); // now the silver job, six ticks younger
    addSerf(world, 34, 34);
    run(world, 2);

    const assigned = [...world.jobs.values()].find(j => j.serfId !== undefined);
    expect(assigned).toBeDefined();
    expect(assigned!.good).toBe(GoodId.silver);
    expect(assigned!.priority).toBe(2);
    expect(assigned!.from).toBe(mine.id);
    const wood = [...world.jobs.values()].find(j => j.good === GoodId.wood);
    expect(wood!.priority).toBe(3);
    expect(wood!.createdTick).toBeLessThan(assigned!.createdTick);
    expectClean(world);
  });

  it('shares the hands: a silver stream at 2 leaves wood one hand in three', () => {
    // The tiers are shares (HAUL_SHARE 4:2:1), not ranks: with tier 2 and
    // tier 3 both backed up, three idle hands split two to silver and one
    // to wood — the woodcutter is served less often, not never.
    const world = bareWorld();
    addStorehouse(world, 40, 40, {});
    const hut = addBuiltHut(world, 30, 30);
    hut.stock[GoodId.wood] = 5;
    const mine = placeBuiltBuilding(
      world,
      BuildingTypeId.silverMine,
      0,
      30,
      36,
    );
    staffBuilding(world, mine);
    mine.stock[GoodId.silver] = 5;
    addSerf(world, 34, 33);
    addSerf(world, 35, 33);
    addSerf(world, 36, 33);
    run(world, 2);

    const taken = [...world.jobs.values()].filter(j => j.serfId !== undefined);
    expect(taken.map(j => j.good).sort((a, z) => a - z)).toEqual([
      GoodId.wood,
      GoodId.silver,
      GoodId.silver,
    ]);
    expectClean(world);
  });

  it('two hands over shares 2:1 split one and one', () => {
    // The target counts the hand about to be given, so the second hand
    // goes to wood: a player's village with two free serfs still sees its
    // planks move.
    const world = bareWorld();
    addStorehouse(world, 40, 40, {});
    const hut = addBuiltHut(world, 30, 30);
    hut.stock[GoodId.wood] = 5;
    const mine = placeBuiltBuilding(
      world,
      BuildingTypeId.silverMine,
      0,
      30,
      36,
    );
    staffBuilding(world, mine);
    mine.stock[GoodId.silver] = 5;
    addSerf(world, 34, 33);
    addSerf(world, 35, 33);
    run(world, 2);

    const taken = [...world.jobs.values()].filter(j => j.serfId !== undefined);
    expect(taken.map(j => j.good).sort((a, z) => a - z)).toEqual([
      GoodId.wood,
      GoodId.silver,
    ]);
    expectClean(world);
  });

  it('a tier with nothing to carry gives its share away', () => {
    const world = bareWorld();
    addStorehouse(world, 40, 40, {});
    const hut = addBuiltHut(world, 30, 30);
    hut.stock[GoodId.wood] = 5;
    addSerf(world, 34, 33);
    addSerf(world, 35, 33);
    addSerf(world, 36, 33);
    run(world, 2);

    const taken = [...world.jobs.values()].filter(j => j.serfId !== undefined);
    expect(taken).toHaveLength(3);
    expect(taken.every(j => j.good === GoodId.wood)).toBe(true);
    expectClean(world);
  });

  it('construction still outranks silver for the only serf', () => {
    const world = bareWorld();
    addStorehouse(world, 40, 40, {});
    const mine = placeBuiltBuilding(
      world,
      BuildingTypeId.silverMine,
      0,
      30,
      30,
    );
    staffBuilding(world, mine);
    mine.stock[GoodId.silver] = 1;
    const site = addSite(world, 34, 30);
    addSerf(world, 32, 33);
    run(world, 2);

    const assigned = [...world.jobs.values()].find(j => j.serfId !== undefined);
    expect(assigned).toBeDefined();
    expect(assigned!.priority).toBe(1);
    expect(assigned!.to).toBe(site.id);
    expectClean(world);
  });

  it('FIFO: the older demand wins scarce supply', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, {});
    const siteA = addSite(world, 22, 30);
    run(world, 6); // A's demand ages
    const siteB = addSite(world, 38, 30);
    sh.stock[GoodId.wood] = 1; // exactly one good appears
    run(world, 5); // next matcher pass

    const job = [...world.jobs.values()].find(
      j => j.good === GoodId.wood && j.from === sh.id,
    );
    expect(job).toBeDefined();
    expect(job!.to).toBe(siteA.id);
    expect(siteB.inbound[GoodId.wood] ?? 0).toBe(0);
    expectClean(world);
  });

  it('full haul: site gets built, jobs drain, serf ends idle and empty-handed', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {[GoodId.wood]: 10});
    const site = addSite(world, 24, 30);
    addSerf(world, 29, 34);
    addSerf(world, 35, 34);
    const initial = countGoods(world);
    run(world, 3000);

    expect(site.state).toBe(BuildingState.built);
    expect(site.workerId).toBeDefined(); // wood hut spawns its worker
    expect(world.jobs.size).toBe(0);
    for (const u of world.units.values()) {
      if (u.kind === UnitTypeId.serf) expect(u.carrying).toBeUndefined();
    }
    expectClean(world, initial);
  });
});

describe('the load home', () => {
  /**
   * The trip the village kept failing to make. A serf carries the miners'
   * bread out, sets it down, and stands at the mine with silver on the
   * shelf at his feet — and the board sends him back to the castle empty
   * for an errand that outranks it, because it deals the job first and
   * looks for the nearest man second. Two crossings for a load already in
   * reach.
   */
  it('leaves the mine with its silver, not empty-handed', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 20, 30, {[GoodId.wood]: 10});
    // Unstaffed on purpose: a mine evacuates its shelf whether or not
    // anyone is down the shaft, and a fixture that mines no ore is a
    // fixture with nothing to time against.
    const mine = placeBuiltBuilding(
      world,
      BuildingTypeId.silverMine,
      0,
      34,
      30,
    );
    mine.stock[GoodId.silver] = 2;
    // The pull the other way, and the one that beats everything: a site's
    // planks are tier 1, and take four hands in seven against the silver's
    // two. With one serf free it is not a share at all — the site takes
    // him, and it used to take him from where he was standing.
    addSite(world, 24, 30);
    const serf = addSerf(world, 34, 32); // at the mine, bread just set down
    const initial = countGoods(world);

    run(world, 1);
    const job = world.jobs.get(serf.jobId!);
    expect(job?.good).toBe(GoodId.silver);
    expect(job?.from).toBe(mine.id);

    // And it gets home, rather than riding back out on the next errand.
    let guard = 0;
    while ((sh.stock[GoodId.silver] ?? 0) < 1 && guard++ < 900)
      tickWorld(world, []);
    expect(sh.stock[GoodId.silver]).toBe(1);
    expectClean(world, initial);
  });

  it('passes over a man sealed in at the wall, and takes the next', () => {
    // One serf's bad luck is not the building's. Standing at a building is
    // a matter of distance, and a man can be within arm's reach of a mine
    // and still have no way round to its door — so the scan steps past him
    // to the next man standing there rather than handing the whole mine
    // back to the ordinary board. The dispatch loop learned this the hard
    // way once already; PATH_TRIES is its note about it.
    const world = bareWorld();
    addStorehouse(world, 20, 30, {[GoodId.wood]: 10});
    const mine = placeBuiltBuilding(
      world,
      BuildingTypeId.silverMine,
      0,
      34,
      30,
    );
    mine.stock[GoodId.silver] = 2;
    addSite(world, 24, 30); // the tier-1 pull that wins him otherwise

    // Walled into a pocket one tile off the ring: near enough to count as
    // standing at the mine, with no way onto it.
    const sealed = addSerf(world, 34, 33);
    for (const [x, y] of [
      [33, 32],
      [34, 32],
      [35, 32],
      [33, 33],
      [35, 33],
      [33, 34],
      [34, 34],
      [35, 34],
    ] as const) {
      world.map.blocked[tileIdx(x, y, world.map.size)] = 1;
    }
    // Spawned second, so the scan reaches him only by stepping over the
    // first — which is the whole assertion.
    const free = addSerf(world, 36, 31);

    run(world, 1);
    expect(sealed.jobId).toBeUndefined();
    const job = world.jobs.get(free.jobId!);
    expect(job?.good).toBe(GoodId.silver);
    expect(job?.from).toBe(mine.id);
  });

  /**
   * The doorstep only counts while he is standing on it.
   *
   * The test above places an already-idle serf beside the mine, which is
   * the one way into this that skips the delivery — and the delivery is
   * where it broke. `progress` stood a man down with `until: world.tick`,
   * and wander reads that as expired on the very tick it is written (its
   * guard is `world.tick < until`) and runs LATER IN THE SAME TICK than
   * logistics does. So a third of the time the man who had just set the
   * bread down was strolled a few tiles off before the board next looked
   * at him: no longer at the mine, no longer holding the claim, and back
   * in the ordinary lottery, which hands a site's planks four hands in
   * seven. He walked home empty past the silver he had been standing on.
   *
   * Every seed, because the stroll is a coin toss (a 65% loiter) and one
   * seed proves nothing either way.
   */
  it('keeps the doorstep after a delivery, instead of strolling off it', () => {
    for (let seed = 1; seed <= 24; seed++) {
      const world = bareWorld(seed);
      const sh = addStorehouse(world, 20, 30, {
        [GoodId.food]: 10,
        [GoodId.wood]: 10,
      });
      // Unstaffed, as above: a mine evacuates its shelf whether or not
      // anyone is down the shaft, and nothing here should turn on how
      // fast a seam gives up its ore.
      const mine = placeBuiltBuilding(
        world,
        BuildingTypeId.silverMine,
        0,
        34,
        30,
      );
      const serf = addSerf(world, 21, 30);

      // He takes the miners' bread out. Nothing else stands in the world
      // yet, so this is the only errand there is.
      let guard = 0;
      const outbound = (): boolean => {
        const job =
          serf.jobId !== undefined ? world.jobs.get(serf.jobId) : undefined;
        return job?.to === mine.id && job.phase === HaulPhase.toDropoff;
      };
      while (!outbound() && guard++ < 900) tickWorld(world, []);
      expect(outbound(), `seed ${seed}: never set out with the bread`).toBe(
        true,
      );

      // While he is on the road the shelf fills behind him — the shaft
      // working, in a fixture that does not have to wait for a shaft —
      // and the village starts a building. That site is the pull that
      // used to take him home empty: tier 1, and with one hand free it
      // takes him outright.
      mine.stock[GoodId.silver] = 1;
      addSite(world, 24, 30);
      const initial = countGoods(world);

      // He sets the bread down, and leaves with the silver rather than
      // for the planks.
      guard = 0;
      while (serf.jobId !== undefined && guard++ < 900) tickWorld(world, []);
      guard = 0;
      while (serf.jobId === undefined && guard++ < 900) tickWorld(world, []);
      const next = world.jobs.get(serf.jobId!);
      expect(next?.good, `seed ${seed}`).toBe(GoodId.silver);
      expect(next?.from, `seed ${seed}`).toBe(mine.id);

      // And it gets home.
      guard = 0;
      while ((sh.stock[GoodId.silver] ?? 0) < 1 && guard++ < 900)
        tickWorld(world, []);
      expect(sh.stock[GoodId.silver], `seed ${seed}`).toBe(1);
      expectClean(world, initial);
    }
  });

  /**
   * And the other half of the same trip: nobody is sent across the map for
   * a load a man is about to be standing on.
   *
   * The board only ever looked at men who were idle THAT TICK, so while
   * the bread was still on the road the matcher raised the mine's silver
   * and dispatch handed it to the nearest idle hand — wherever he was.
   * By the time the bread landed the job was claimed, which put it off
   * the open board and out of reach of the man standing on the shelf
   * (takeStandingJobs deals open jobs only). He walked home empty and the
   * other man walked out. Two crossings, again.
   *
   * Prevented rather than undone: the claim is not taken off anybody, the
   * load is simply left on the board for the man who is nearly there.
   */
  it("leaves a mine's silver for the man already walking to it", () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 20, 30, {[GoodId.food]: 10});
    const mine = placeBuiltBuilding(
      world,
      BuildingTypeId.silverMine,
      0,
      34,
      30,
    );
    // Manned, and on no seam at all: a mine standing open calls for its
    // pickaxe, and that errand would take the loafer below off the board
    // as surely as the bread does — while a seam would have the shaft
    // filling its own shelf on a timer nothing here wants to depend on.
    // So the only ore in this test is the load put on the shelf by hand,
    // at the moment the trip turns on.
    staffBuilding(world, mine);
    // One loaf short of its pantry, so the bread is a single errand. At a
    // full RATION_STOCK's worth the mine wants two, and the second one
    // would put the loafer on the road as well — leaving nobody idle for
    // the board to make the old mistake with.
    mine.inputs[GoodId.food] = RATION_STOCK - 1;
    // The man who takes the bread out — started a walk short of the
    // storehouse, not on its doorstep, so his errand has a real FETCHING
    // leg as well as a carrying one. That is the half the first cut of
    // this missed: it counted a man only once the bread was on his
    // shoulders, and a serf is dispatched from wherever he happens to be
    // standing, so the walk to the shelf is usually the longer half. The
    // silver was dealt while he fetched, and he arrived to a reserved
    // shelf and an empty board — the very trip this is here to prevent,
    // through the one window it did not cover.
    const carrier = addSerf(world, 20, 24);
    // And a hand loafing at the other end of the village — idle, so the
    // board can see him, and far enough that he is never the quicker way
    // to the mine than the man already walking there, by either leg.
    const far = addSerf(world, 20, 8);

    const jobOf = (id: number | undefined) =>
      id !== undefined ? world.jobs.get(id) : undefined;

    // He is given the bread and sets off for the shelf to draw it.
    let guard = 0;
    while (jobOf(carrier.jobId)?.phase !== HaulPhase.toPickup && guard++ < 900)
      tickWorld(world, []);
    expect(jobOf(carrier.jobId)?.to).toBe(mine.id);
    expect(carrier.path?.length).toBeGreaterThan(0); // a fetch, not a formality

    // The shelf fills while he is still fetching.
    mine.stock[GoodId.silver] = 1;
    const initial = countGoods(world);

    // From here until the bread lands — both legs — the silver is nobody's
    // but his.
    let sawPickupLeg = false;
    guard = 0;
    while (carrier.jobId !== undefined && guard++ < 900) {
      if (jobOf(carrier.jobId)?.phase === HaulPhase.toPickup)
        sawPickupLeg = true;
      tickWorld(world, []);
      expect(jobOf(far.jobId)?.from).not.toBe(mine.id);
    }
    expect(sawPickupLeg).toBe(true);
    // And he leaves with it.
    guard = 0;
    while (carrier.jobId === undefined && guard++ < 900) tickWorld(world, []);
    expect(jobOf(carrier.jobId)?.from).toBe(mine.id);
    expect(jobOf(carrier.jobId)?.good).toBe(GoodId.silver);

    guard = 0;
    while ((sh.stock[GoodId.silver] ?? 0) < 1 && guard++ < 900)
      tickWorld(world, []);
    expect(sh.stock[GoodId.silver]).toBe(1);
    expectClean(world, initial);
  });

  /**
   * A shelf with two loads on it has two jobs on the board, and one of
   * them being spoken for does not put the other out of reach.
   *
   * It reads as though it might: the reservation is booked the moment a
   * job is created, so the mine's `reservedOut` covers both silver and
   * `availableOut` is zero. But evacuation asks for the whole surplus and
   * `match` cuts it into ONE JOB PER LOAD, so the man walking out for the
   * first took one job and left the second standing open — and the
   * standing route gates on raw `stock`, not on what is unreserved, so the
   * man on the doorstep sees a shelf with silver on it and a load he may
   * have. Reservations keep two men off ONE load; they were never meant to
   * keep a second man off a second one.
   *
   * Pins behaviour that already worked rather than gating a change: it is
   * the question the withholding above makes everybody ask, and nothing
   * else in the suite answers it.
   */
  it('takes the second silver off a shelf whose first is spoken for', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 20, 30, {[GoodId.food]: 10});
    const mine = placeBuiltBuilding(
      world,
      BuildingTypeId.silverMine,
      0,
      34,
      30,
    );
    staffBuilding(world, mine); // no pickaxe errand, no seam — as above
    mine.inputs[GoodId.food] = RATION_STOCK - 1;
    const carrier = addSerf(world, 20, 24);
    const other = addSerf(world, 20, 8);

    const jobOf = (id: number | undefined) =>
      id !== undefined ? world.jobs.get(id) : undefined;

    let guard = 0;
    while (jobOf(carrier.jobId)?.phase !== HaulPhase.toPickup && guard++ < 900)
      tickWorld(world, []);
    expect(jobOf(carrier.jobId)?.to).toBe(mine.id);

    // Two on the shelf this time. One is withheld for the man on his way;
    // the other is the loafer's, and he is welcome to it.
    mine.stock[GoodId.silver] = 2;
    const initial = countGoods(world);

    guard = 0;
    while (jobOf(other.jobId)?.from !== mine.id && guard++ < 900)
      tickWorld(world, []);
    expect(jobOf(other.jobId)?.good).toBe(GoodId.silver);

    // And the man who brought the bread still leaves with the second one,
    // off a shelf whose whole stock is reserved.
    guard = 0;
    while (carrier.jobId !== undefined && guard++ < 900) tickWorld(world, []);
    guard = 0;
    while (carrier.jobId === undefined && guard++ < 900) tickWorld(world, []);
    expect(jobOf(carrier.jobId)?.from).toBe(mine.id);
    expect(jobOf(carrier.jobId)?.good).toBe(GoodId.silver);

    // Both get home, and the pile is cleared rather than half-carried.
    guard = 0;
    while ((sh.stock[GoodId.silver] ?? 0) < 2 && guard++ < 1800)
      tickWorld(world, []);
    expect(sh.stock[GoodId.silver]).toBe(2);
    expect(mine.stock[GoodId.silver] ?? 0).toBe(0);
    expectClean(world, initial);
  });

  it('lets the site it just supplied recruit the man who supplied it', () => {
    // The narrow case, and the one the standing job could quietly break: a
    // serf lands the last plank at a site and is standing at the very
    // building that wants a builder. If claiming a standing job ran as the
    // delivery landed, he would never be idle and the site could never
    // have him — the whole reason takeStandingJobs is a pass over the
    // board instead (systems/staffing.ts recruits after logistics).
    //
    // Deliberately not a test of the BUILDER_STARVED_TICKS bound itself:
    // one serf and one site raise no sustained haul pressure, so nothing
    // here is starved. builderStarvation.test.ts is what measures the
    // bound, under six mills' worth of pressure, and it is the test the
    // inline version of this change failed.
    const world = bareWorld();
    addStorehouse(world, 20, 30, {[GoodId.wood]: 40});
    const site = addSite(world, 34, 30);
    addSerf(world, 21, 32);

    let guard = 0;
    while (site.workerId === undefined && guard++ < 4000) tickWorld(world, []);
    expect(site.workerId).toBeDefined();
  });
});

describe('cancellation table', () => {
  function setupHaul(): {world: World; initial: GoodAmounts} {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {[GoodId.wood]: 10});
    addSite(world, 22, 30);
    addSerf(world, 29, 34);
    return {world, initial: countGoods(world)};
  }

  it('serf dies before pickup: job returns to open, reservations intact', () => {
    const {world, initial} = setupHaul();
    // Run until a job is claimed but nothing picked up yet.
    let guard = 0;
    while (
      ![...world.jobs.values()].some(j => j.phase === HaulPhase.toPickup) &&
      guard++ < 200
    ) {
      tickWorld(world, []);
    }
    const job = [...world.jobs.values()].find(
      j => j.phase === HaulPhase.toPickup,
    )!;
    const serf = world.units.get(job.serfId!)!;
    killUnit(world, serf);
    run(world, 10); // reconcile pass

    const revived = world.jobs.get(job.id);
    expect(revived).toBeDefined();
    expect(revived!.phase).toBe(HaulPhase.open);
    expect(revived!.serfId).toBeUndefined();
    expectClean(world, initial);
  });

  it('serf dies mid-dropoff: job aborts, carried good drops where he fell', () => {
    const {world, initial} = setupHaul();
    let guard = 0;
    while (
      ![...world.jobs.values()].some(j => j.phase === HaulPhase.toDropoff) &&
      guard++ < 500
    ) {
      tickWorld(world, []);
    }
    const job = [...world.jobs.values()].find(
      j => j.phase === HaulPhase.toDropoff,
    )!;
    const serf = world.units.get(job.serfId!)!;
    expect(serf.carrying).toBe(GoodId.wood);
    killUnit(world, serf);
    run(world, 10);

    expect(world.jobs.get(job.id)).toBeUndefined();
    // The plank is not ledgered away — it lies in a salvage pile on the
    // road, waiting for whoever is left to pick it up.
    expect(world.ledger.consumed[GoodId.wood] ?? 0).toBe(0);
    const pile = [...world.buildings.values()].find(
      b => !b.dead && b.type === BuildingTypeId.salvage,
    );
    expect(pile?.stock[GoodId.wood]).toBe(1);
    expectClean(world, initial);
  });

  it('source destroyed before pickup: jobs abort, serfs freed', () => {
    const {world, initial} = setupHaul();
    run(world, 3);
    const sh = [...world.buildings.values()].find(
      b => b.type === BuildingTypeId.storehouse,
    )!;
    destroyBuilding(world, sh);
    run(world, 10);

    expect(world.jobs.size).toBe(0);
    for (const u of world.units.values()) {
      if (u.kind === UnitTypeId.serf) expect(u.jobId).toBeUndefined();
    }
    expectClean(world, initial);
  });

  it('destination destroyed mid-haul: jobs abort cleanly', () => {
    const {world, initial} = setupHaul();
    let guard = 0;
    while (
      ![...world.jobs.values()].some(j => j.phase === HaulPhase.toDropoff) &&
      guard++ < 500
    ) {
      tickWorld(world, []);
    }
    const site = [...world.buildings.values()].find(
      b => b.state === BuildingState.site,
    )!;
    destroyBuilding(world, site);
    run(world, 10);

    expect(world.jobs.size).toBe(0);
    expectClean(world, initial);
  });

  it('walled-off source: job stays open with backoff, serf stays free', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, {[GoodId.wood]: 5});
    // Wall the storehouse ring completely.
    for (let x = sh.x - 1; x <= sh.x + sh.w; x++) {
      for (let y = sh.y - 1; y <= sh.y + sh.h; y++) {
        world.map.blocked[tileIdx(x, y, world.map.size)] = 1;
      }
    }
    addSite(world, 22, 30);
    const serf = addSerf(world, 20, 34);
    run(world, 30);

    for (const job of world.jobs.values()) {
      expect(job.phase).toBe(HaulPhase.open);
      expect(job.blockedUntil).toBeDefined();
    }
    expect(serf.jobId).toBeUndefined();
    expectClean(world);
  });
});

describe('fuzz: 10k ticks of random destruction never corrupts the economy', () => {
  it('survives with invariants and ledger intact', () => {
    const world = bareWorld(99);
    const rng = new Rng(4242);
    addStorehouse(world, 30, 30, {[GoodId.wood]: 60, [GoodId.stone]: 20});
    // Real wood for the huts to gather.
    for (let i = 0; i < 40; i++) {
      const idx = tileIdx(20 + rng.int(8), 20 + rng.int(8), world.map.size);
      if (world.map.buildingAt[idx]! >= 0) continue;
      world.map.resource[idx] = TileResource.Wood;
      world.map.resourceAmt[idx] = 6;
      world.map.blocked[idx] = 1;
    }
    addBuiltHut(world, 24, 30);
    addBuiltHut(world, 30, 24);
    addSite(world, 38, 30);
    for (let i = 0; i < 6; i++) addSerf(world, 28 + i, 35);
    const initial = countGoods(world);

    for (let t = 0; t < 10_000; t++) {
      tickWorld(world, []);

      if (t % 50 === 17) {
        // Random mayhem, weighted toward serf deaths.
        const roll = rng.next();
        if (roll < 0.5) {
          const serfs = [...world.units.values()].filter(
            u => u.kind === UnitTypeId.serf && !u.dead,
          );
          if (serfs.length > 2) killUnit(world, serfs[rng.int(serfs.length)]!);
        } else if (roll < 0.65) {
          const targets = [...world.buildings.values()].filter(
            b => !b.dead && b.type !== BuildingTypeId.storehouse,
          );
          if (targets.length > 1)
            destroyBuilding(world, targets[rng.int(targets.length)]!);
        } else if (roll < 0.85) {
          const x = 18 + rng.int(24);
          const y = 18 + rng.int(24);
          tickWorld(
            world,
            cmds({
              kind: CommandKind.placeBuilding,
              building: BuildingTypeId.woodcutter,
              x,
              y,
            }),
          );
        } else {
          const serfs = [...world.units.values()].filter(
            u => u.kind === UnitTypeId.serf,
          );
          if (serfs.length < 8) addSerf(world, 30 + rng.int(4), 35);
        }
      }

      if (t % 500 === 499) {
        const report = checkInvariants(world);
        expect(report.violations, `tick ${world.tick}`).toEqual([]);
        // Ledger must hold at all times too.
        expect(
          checkLedger(world, initial),
          `ledger tick ${world.tick}`,
        ).toEqual([]);
      }
    }

    // The economy should still be alive: no zombie jobs pointing at the dead.
    for (const job of world.jobs.values()) {
      expect(world.buildings.get(job.to)?.dead).not.toBe(true);
    }
  }, 30_000);
});

describe('move orders outrank employment', () => {
  it('pulls a hauling serf off its job, releasing the reservations', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {[GoodId.wood]: 5});
    addSite(world, 36, 30);
    const serf = addSerf(world, 32, 32);
    run(world, 40);
    expect(serf.jobId).toBeDefined(); // the matcher hired him

    tickWorld(
      world,
      cmds({kind: CommandKind.moveUnits, unitIds: [serf.id], x: 20, y: 20}),
    );
    expect(serf.jobId).toBeUndefined();
    expect(serf.task.t).toBe(UnitTaskKind.move);
    expect(checkInvariants(world).violations).toEqual([]);

    // And the freed demand can be served again rather than staying reserved.
    run(world, 200);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it("never destroys the good in a reassigned serf's hands", () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {[GoodId.wood]: 5});
    const smith = placeBuiltBuilding(
      world,
      BuildingTypeId.weaponsmith,
      0,
      36,
      30,
    );
    smith.recipeIndex = 0; // pinned on spears (default is auto): wants wood
    const serf = addSerf(world, 32, 32);

    // Run until he is actually holding something, then yank him away.
    let guard = 0;
    while (serf.carrying === undefined && guard++ < 600) tickWorld(world, []);
    expect(serf.carrying).toBe(GoodId.wood);

    // The abort must not write the good off — compare the ledger across the
    // interrupt itself, since production legitimately consumes wood later.
    const consumed = world.ledger.consumed[GoodId.wood] ?? 0;
    tickWorld(
      world,
      cmds({kind: CommandKind.moveUnits, unitIds: [serf.id], x: 20, y: 20}),
    );
    expect(serf.carrying).toBe(GoodId.wood); // still in his hands
    expect(world.ledger.consumed[GoodId.wood] ?? 0).toBe(consumed);
    expect(serf.task.t).toBe(UnitTaskKind.move);
    // Walking an errand while laden is the intended state, not a violation:
    // the invariant used to call it orphaned cargo on every dev sweep.
    expect(checkInvariants(world).violations).toEqual([]);

    // He walks the errand, then hands off what he was still carrying.
    guard = 0;
    while (serf.carrying !== undefined && guard++ < 900) tickWorld(world, []);
    expect(serf.carrying).toBeUndefined();
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('never hands a fresh pickup to a serf who is already carrying', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {[GoodId.wood]: 5});
    const smith = placeBuiltBuilding(
      world,
      BuildingTypeId.weaponsmith,
      0,
      36,
      30,
    );
    smith.recipeIndex = 0; // pinned on spears (default is auto): wants wood
    const serf = addSerf(world, 32, 32);
    const initial = countGoods(world);

    let guard = 0;
    while (serf.carrying === undefined && guard++ < 600) tickWorld(world, []);
    tickWorld(
      world,
      cmds({kind: CommandKind.moveUnits, unitIds: [serf.id], x: 20, y: 20}),
    );
    expect(serf.carrying).toBe(GoodId.wood);

    // dispatch runs every tick and used to claim him the moment he arrived,
    // while rehomeCarriedGoods only gets a turn every MATCHER_INTERVAL. The
    // pickup then overwrote what was already in his hands: a good gone from
    // the world with no ledger entry to account for it.
    guard = 0;
    while (serf.carrying !== undefined && guard++ < 900) {
      tickWorld(world, []);
      const job =
        serf.jobId !== undefined ? world.jobs.get(serf.jobId) : undefined;
      if (job) expect(job.phase).toBe(HaulPhase.toDropoff);
    }
    expect(serf.carrying).toBeUndefined();
    expect(checkLedger(world, initial)).toEqual([]);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('lets a resident worker quit his post, so the building re-recruits', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const hut = addBuiltHut(world, 36, 30);
    const worker = staffBuilding(world, hut);
    expect(hut.workerId).toBe(worker.id);

    tickWorld(
      world,
      cmds({kind: CommandKind.moveUnits, unitIds: [worker.id], x: 24, y: 24}),
    );
    expect(worker.homeId).toBeUndefined();
    expect(worker.kind).toBe(UnitTypeId.serf);
    expect(hut.workerId).toBeUndefined();
    expect(worker.task.t).toBe(UnitTaskKind.move);
    expect(checkInvariants(world).violations).toEqual([]);

    // Staffing notices the empty post and sends somebody (him, once idle).
    run(world, 400);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('an order that cannot be walked leaves the worker at his post', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, {});
    const hut = addBuiltHut(world, 36, 30);
    const worker = staffBuilding(world, hut);

    // A sealed pocket: the tile itself is walkable, so it is offered as a
    // destination, but nothing can reach it.
    for (let y = 49; y <= 51; y++) {
      for (let x = 49; x <= 51; x++) {
        if (x !== 50 || y !== 50)
          world.map.blocked[tileIdx(x, y, world.map.size)] = 1;
      }
    }
    tickWorld(
      world,
      cmds({kind: CommandKind.moveUnits, unitIds: [worker.id], x: 50, y: 50}),
    );

    // He used to be fired before the path was even attempted, which left an
    // ex-worker holding a gather task no system drives: production had lost
    // him with the post, and wander, dispatch and staffing all want a unit
    // that is genuinely idle. The population silently lost a man.
    expect(worker.kind).toBe(UnitTypeId.worker);
    expect(worker.homeId).toBe(hut.id);
    expect(hut.workerId).toBe(worker.id);
    expect(worker.task.t).not.toBe(UnitTaskKind.move);
    run(world, 200);
    expect(worker.homeId).toBe(hut.id);
    expect(checkInvariants(world).violations).toEqual([]);
  });
});
