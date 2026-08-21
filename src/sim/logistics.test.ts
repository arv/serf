import { describe, expect, it } from 'vitest';
import { Rng } from '../shared/rng.ts';
import { tileIdx } from '../shared/grid.ts';
import { tickWorld } from './tick.ts';
import { destroyBuilding, killUnit, placeBuiltBuilding, type World } from './world.ts';
import { checkInvariants, checkLedger, countGoods } from './debug/invariants.ts';
import {
  cmds,
  addBuiltHut,
  addSerf,
  addSite,
  addStorehouse,
  bareWorld,
  staffBuilding,
} from './testUtils.ts';
import { TileResource } from './map.ts';
import type { GoodAmounts } from './defs/goods.ts';

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
    const sh = addStorehouse(world, 30, 30, { wood: 10 });
    const site = addSite(world, 24, 30); // needs 6 wood + the hammer loan
    run(world, 1); // matcher fires at tick 0

    // Six wood, the borrowed hammer, and the axe pre-ordered for the post
    // the site will become.
    expect(world.jobs.size).toBe(8);
    expect(sh.reservedOut.wood).toBe(6);
    expect(site.inbound.wood).toBe(6);
    expect(site.inbound.hammer).toBe(1);
    expect(site.inbound.axe).toBe(1);
    expectClean(world);
  });

  it('never reserves more than stock', () => {
    const world = bareWorld();
    const sh = addStorehouse(world, 30, 30, { wood: 3 });
    addSite(world, 24, 30); // needs 6
    run(world, 1);

    expect(world.jobs.size).toBe(5); // 3 wood + hammer + the post's axe
    expect(sh.reservedOut.wood).toBe(3);
    expectClean(world);
  });

  it('prioritizes construction over evacuation for the only serf', () => {
    const world = bareWorld();
    addStorehouse(world, 40, 40, {});
    const hut = addBuiltHut(world, 30, 30, false);
    hut.stock.wood = 2;
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
    sh.stock.wood = 1; // exactly one good appears
    run(world, 5); // next matcher pass

    const job = [...world.jobs.values()].find((j) => j.good === 'wood' && j.from === sh.id);
    expect(job).toBeDefined();
    expect(job!.to).toBe(siteA.id);
    expect(siteB.inbound.wood ?? 0).toBe(0);
    expectClean(world);
  });

  it('full haul: site gets built, jobs drain, serf ends idle and empty-handed', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { wood: 10 });
    const site = addSite(world, 24, 30);
    addSerf(world, 29, 34);
    addSerf(world, 35, 34);
    const initial = countGoods(world);
    run(world, 3000);

    expect(site.state).toBe('built');
    expect(site.workerId).toBeDefined(); // wood hut spawns its worker
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
    addStorehouse(world, 30, 30, { wood: 10 });
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
    expect(serf.carrying).toBe('wood');
    killUnit(world, serf);
    run(world, 10);

    expect(world.jobs.get(job.id)).toBeUndefined();
    expect(world.ledger.consumed.wood ?? 0).toBeGreaterThan(0);
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
    const sh = addStorehouse(world, 30, 30, { wood: 5 });
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
    addStorehouse(world, 30, 30, { wood: 60, stone: 20 });
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
          tickWorld(world, cmds({ kind: 'placeBuilding', building: 'woodcutter', x, y }));
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

describe('move orders outrank employment', () => {
  it('pulls a hauling serf off its job, releasing the reservations', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { wood: 5 });
    addSite(world, 36, 30);
    const serf = addSerf(world, 32, 32);
    run(world, 40);
    expect(serf.jobId).toBeDefined(); // the matcher hired him

    tickWorld(world, cmds({ kind: 'moveUnits', unitIds: [serf.id], x: 20, y: 20 }));
    expect(serf.jobId).toBeUndefined();
    expect(serf.task.t).toBe('move');
    expect(checkInvariants(world).violations).toEqual([]);

    // And the freed demand can be served again rather than staying reserved.
    run(world, 200);
    expect(checkInvariants(world).violations).toEqual([]);
  });

  it('never destroys the good in a reassigned serf\'s hands', () => {
    const world = bareWorld();
    addStorehouse(world, 30, 30, { wood: 5 });
    const smith = placeBuiltBuilding(world, 'weaponsmith', 0, 36, 30);
    smith.recipeIndex = 0; // pinned on spears (default is auto): wants wood
    const serf = addSerf(world, 32, 32);

    // Run until he is actually holding something, then yank him away.
    let guard = 0;
    while (serf.carrying === undefined && guard++ < 600) tickWorld(world, []);
    expect(serf.carrying).toBe('wood');

    // The abort must not write the good off — compare the ledger across the
    // interrupt itself, since production legitimately consumes wood later.
    const consumed = world.ledger.consumed.wood ?? 0;
    tickWorld(world, cmds({ kind: 'moveUnits', unitIds: [serf.id], x: 20, y: 20 }));
    expect(serf.carrying).toBe('wood'); // still in his hands
    expect(world.ledger.consumed.wood ?? 0).toBe(consumed);
    expect(serf.task.t).toBe('move');
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
    addStorehouse(world, 30, 30, { wood: 5 });
    const smith = placeBuiltBuilding(world, 'weaponsmith', 0, 36, 30);
    smith.recipeIndex = 0; // pinned on spears (default is auto): wants wood
    const serf = addSerf(world, 32, 32);
    const initial = countGoods(world);

    let guard = 0;
    while (serf.carrying === undefined && guard++ < 600) tickWorld(world, []);
    tickWorld(world, cmds({ kind: 'moveUnits', unitIds: [serf.id], x: 20, y: 20 }));
    expect(serf.carrying).toBe('wood');

    // dispatch runs every tick and used to claim him the moment he arrived,
    // while rehomeCarriedGoods only gets a turn every MATCHER_INTERVAL. The
    // pickup then overwrote what was already in his hands: a good gone from
    // the world with no ledger entry to account for it.
    guard = 0;
    while (serf.carrying !== undefined && guard++ < 900) {
      tickWorld(world, []);
      const job = serf.jobId !== undefined ? world.jobs.get(serf.jobId) : undefined;
      if (job) expect(job.phase).toBe('toDropoff');
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

    tickWorld(world, cmds({ kind: 'moveUnits', unitIds: [worker.id], x: 24, y: 24 }));
    expect(worker.homeId).toBeUndefined();
    expect(worker.kind).toBe('serf');
    expect(hut.workerId).toBeUndefined();
    expect(worker.task.t).toBe('move');
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
        if (x !== 50 || y !== 50) world.map.blocked[tileIdx(x, y, world.map.size)] = 1;
      }
    }
    tickWorld(world, cmds({ kind: 'moveUnits', unitIds: [worker.id], x: 50, y: 50 }));

    // He used to be fired before the path was even attempted, which left an
    // ex-worker holding a gather task no system drives: production had lost
    // him with the post, and wander, dispatch and staffing all want a unit
    // that is genuinely idle. The population silently lost a man.
    expect(worker.kind).toBe('worker');
    expect(worker.homeId).toBe(hut.id);
    expect(hut.workerId).toBe(worker.id);
    expect(worker.task.t).not.toBe('move');
    run(world, 200);
    expect(worker.homeId).toBe(hut.id);
    expect(checkInvariants(world).violations).toEqual([]);
  });
});
