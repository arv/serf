import { describe, expect, it } from 'vitest';
import { Rng } from '../shared/rng';
import { tileIdx } from '../shared/grid';
import { tickWorld } from './tick';
import { destroyBuilding, killUnit, type World } from './world';
import { checkInvariants, checkLedger, countGoods } from './debug/invariants';
import { cmds, addBuiltHut, addSerf, addSite, addStorehouse, bareWorld } from './testUtils';
import { TileResource } from './map';
import type { GoodAmounts } from './defs/goods';

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
    const sh = addStorehouse(world, 30, 30, { bamboo: 10 });
    const site = addSite(world, 24, 30); // needs 6 bamboo
    run(world, 1); // matcher fires at tick 0

    expect(world.jobs.size).toBe(6);
    expect(sh.reservedOut.bamboo).toBe(6);
    expect(site.inbound.bamboo).toBe(6);
    expectClean(world);
  });

  it('never reserves more than stock', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, { bamboo: 3 });
    addSite(world, 24, 30); // needs 6
    run(world, 1);

    expect(world.jobs.size).toBe(3);
    expect(sh.reservedOut.bamboo).toBe(3);
    expectClean(world);
  });

  it('prioritizes construction over evacuation for the only serf', () => {
    const world = bareWorld();
    addStorehouse(world, 40, 40, {});
    const hut = addBuiltHut(world, 30, 30, false);
    hut.stock.bamboo = 2;
    const site = addSite(world, 34, 30);
    addSerf(world, 32, 33);
    run(world, 2);

    const assigned = [...world.jobs.values()].find((j) => j.serfId !== undefined);
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
    sh.stock.bamboo = 1; // exactly one good appears
    run(world, 5); // next matcher pass

    const job = [...world.jobs.values()].find((j) => j.good === 'bamboo' && j.from === sh.id);
    expect(job).toBeDefined();
    expect(job!.to).toBe(siteA.id);
    expect(siteB.inbound.bamboo ?? 0).toBe(0);
    expectClean(world);
  });

  it('full haul: site gets built, jobs drain, serf ends idle and empty-handed', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { bamboo: 10 });
    const site = addSite(world, 24, 30);
    addSerf(world, 29, 34);
    addSerf(world, 35, 34);
    const initial = countGoods(world);
    run(world, 3000);

    expect(site.state).toBe('built');
    expect(site.workerId).toBeDefined(); // bamboo hut spawns its worker
    expect(world.jobs.size).toBe(0);
    for (const u of world.units.values()) {
      if (u.kind === 'serf') expect(u.carrying).toBeUndefined();
    }
    expectClean(world, initial);
  });
});

describe('cancellation table', () => {
  function setupHaul(): { world: World; initial: GoodAmounts } {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { bamboo: 10 });
    addSite(world, 22, 30);
    addSerf(world, 29, 34);
    return { world, initial: countGoods(world) };
  }

  it('serf dies before pickup: job returns to open, reservations intact', () => {
    const { world, initial } = setupHaul();
    // Run until a job is claimed but nothing picked up yet.
    let guard = 0;
    while (![...world.jobs.values()].some((j) => j.phase === 'toPickup') && guard++ < 200) {
      tickWorld(world, []);
    }
    const job = [...world.jobs.values()].find((j) => j.phase === 'toPickup')!;
    const serf = world.units.get(job.serfId!)!;
    killUnit(world, serf);
    run(world, 10); // reconcile pass

    const revived = world.jobs.get(job.id);
    expect(revived).toBeDefined();
    expect(revived!.phase).toBe('open');
    expect(revived!.serfId).toBeUndefined();
    expectClean(world, initial);
  });

  it('serf dies mid-dropoff: job aborts, carried good ledgered as lost', () => {
    const { world, initial } = setupHaul();
    let guard = 0;
    while (![...world.jobs.values()].some((j) => j.phase === 'toDropoff') && guard++ < 500) {
      tickWorld(world, []);
    }
    const job = [...world.jobs.values()].find((j) => j.phase === 'toDropoff')!;
    const serf = world.units.get(job.serfId!)!;
    expect(serf.carrying).toBe('bamboo');
    killUnit(world, serf);
    run(world, 10);

    expect(world.jobs.get(job.id)).toBeUndefined();
    expect(world.ledger.consumed.bamboo ?? 0).toBeGreaterThan(0);
    expectClean(world, initial);
  });

  it('source destroyed before pickup: jobs abort, serfs freed', () => {
    const { world, initial } = setupHaul();
    run(world, 3);
    const sh = [...world.buildings.values()].find((b) => b.type === 'storehouse')!;
    destroyBuilding(world, sh);
    run(world, 10);

    expect(world.jobs.size).toBe(0);
    for (const u of world.units.values()) {
      if (u.kind === 'serf') expect(u.jobId).toBeUndefined();
    }
    expectClean(world, initial);
  });

  it('destination destroyed mid-haul: jobs abort cleanly', () => {
    const { world, initial } = setupHaul();
    let guard = 0;
    while (![...world.jobs.values()].some((j) => j.phase === 'toDropoff') && guard++ < 500) {
      tickWorld(world, []);
    }
    const site = [...world.buildings.values()].find((b) => b.state === 'site')!;
    destroyBuilding(world, site);
    run(world, 10);

    expect(world.jobs.size).toBe(0);
    expectClean(world, initial);
  });

  it('walled-off source: job stays open with backoff, serf stays free', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, { bamboo: 5 });
    // Wall the storehouse ring completely.
    for (let x = sh.x - 1; x <= sh.x + sh.w; x++) {
      for (let y = sh.y - 1; y <= sh.y + sh.h; y++) {
        world.map.blocked[tileIdx(x, y)] = 1;
      }
    }
    addSite(world, 22, 30);
    const serf = addSerf(world, 20, 34);
    run(world, 30);

    for (const job of world.jobs.values()) {
      expect(job.phase).toBe('open');
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
    addStorehouse(world, 30, 30, { bamboo: 60, stone: 20 });
    // Real bamboo for the huts to gather.
    for (let i = 0; i < 40; i++) {
      const idx = tileIdx(20 + rng.int(8), 20 + rng.int(8));
      if (world.map.buildingAt[idx]! >= 0) continue;
      world.map.resource[idx] = TileResource.Bamboo;
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
          const serfs = [...world.units.values()].filter((u) => u.kind === 'serf' && !u.dead);
          if (serfs.length > 2) killUnit(world, serfs[rng.int(serfs.length)]!);
        } else if (roll < 0.65) {
          const targets = [...world.buildings.values()].filter(
            (b) => !b.dead && b.type !== 'storehouse',
          );
          if (targets.length > 1) destroyBuilding(world, targets[rng.int(targets.length)]!);
        } else if (roll < 0.85) {
          const x = 18 + rng.int(24);
          const y = 18 + rng.int(24);
          tickWorld(world, cmds({ kind: 'placeBuilding', building: 'bambooHut', x, y }));
        } else {
          const serfs = [...world.units.values()].filter((u) => u.kind === 'serf');
          if (serfs.length < 8) addSerf(world, 30 + rng.int(4), 35);
        }
      }

      if (t % 500 === 499) {
        const report = checkInvariants(world);
        expect(report.violations, `tick ${world.tick}`).toEqual([]);
        // Ledger must hold at all times too.
        expect(checkLedger(world, initial), `ledger tick ${world.tick}`).toEqual([]);
      }
    }

    // The economy should still be alive: no zombie jobs pointing at the dead.
    for (const job of world.jobs.values()) {
      expect(world.buildings.get(job.to)?.dead).not.toBe(true);
    }
  }, 30_000);
});
