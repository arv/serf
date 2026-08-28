import { GOODS, type GoodAmounts } from '../defs/goods.ts';
import type { World } from '../world.ts';
import { GOOD_KEYS } from '../defs/goods.ts';

/**
 * Dev-only consistency checks over the logistics bookkeeping. Violations mean
 * a reservation leak or a broken serf<->job link — the bugs that silently
 * deadlock Settlers-like economies. Run every ~20 ticks in dev builds; the
 * result also feeds the debug overlay's red banner.
 */
export interface InvariantReport {
  tick: number;
  violations: string[];
}

export function checkInvariants(world: World): InvariantReport {
  const violations: string[] = [];

  // Expected reservations derived from live jobs.
  const expectOut = new Map<number, GoodAmounts>();
  const expectIn = new Map<number, GoodAmounts>();
  for (const job of world.jobs.values()) {
    // Hauls never cross factions — the multiplayer leak tripwire.
    const from = world.buildings.get(job.from);
    const to = world.buildings.get(job.to);
    if (from && to && (from.owner !== job.owner || to.owner !== job.owner)) {
      violations.push(
        `job ${job.id}: owner ${job.owner} but from=${from.owner} to=${to.owner} (cross-owner)`,
      );
    }
    if (job.phase !== 'toDropoff') {
      const m = expectOut.get(job.from) ?? {};
      m[job.good] = (m[job.good] ?? 0) + 1;
      expectOut.set(job.from, m);
    }
    const m = expectIn.get(job.to) ?? {};
    m[job.good] = (m[job.good] ?? 0) + 1;
    expectIn.set(job.to, m);

    if (job.phase !== 'open') {
      const serf = job.serfId !== undefined ? world.units.get(job.serfId) : undefined;
      if (!serf) violations.push(`job ${job.id}: assigned serf ${job.serfId} missing`);
      else if (serf.jobId !== job.id) {
        violations.push(`job ${job.id}: serf ${serf.id} jobId=${serf.jobId} (link broken)`);
      } else if (job.phase === 'toDropoff' && !serf.dead && serf.carrying !== job.good) {
        // A carrier killed mid-haul is not a violation yet: killUnit ledgers
        // the cargo away immediately, and the job waits (at most
        // MATCHER_INTERVAL ticks, well inside the corpse's linger) for the
        // next reconcile pass to abort it. Only a LIVE serf whose hands
        // disagree with the job is broken bookkeeping.
        violations.push(`job ${job.id}: serf carrying ${serf.carrying}, expected ${job.good}`);
      }
    }
  }

  for (const b of world.buildings.values()) {
    if (b.dead) continue;
    for (const good of GOODS) {
      const stock = b.stock[good] ?? 0;
      const rOut = b.reservedOut[good] ?? 0;
      const inb = b.inbound[good] ?? 0;
      if (rOut < 0 || inb < 0 || stock < 0) {
        violations.push(`building ${b.id} ${b.type}: negative ${GOOD_KEYS[good]} bookkeeping`);
      }
      if (rOut > stock) {
        violations.push(`building ${b.id} ${b.type}: reservedOut[${GOOD_KEYS[good]}]=${rOut} > stock=${stock}`);
      }
      const expOut = expectOut.get(b.id)?.[good] ?? 0;
      if (rOut !== expOut) {
        violations.push(
          `building ${b.id} ${b.type}: reservedOut[${GOOD_KEYS[good]}]=${rOut}, jobs expect ${expOut}`,
        );
      }
      const expIn = expectIn.get(b.id)?.[good] ?? 0;
      if (inb !== expIn) {
        violations.push(
          `building ${b.id} ${b.type}: inbound[${GOOD_KEYS[good]}]=${inb}, jobs expect ${expIn}`,
        );
      }
    }
  }

  // Serf-side link + carrying consistency.
  for (const u of world.units.values()) {
    if (u.dead) continue;
    if (u.jobId !== undefined) {
      const job = world.jobs.get(u.jobId);
      if (!job) violations.push(`serf ${u.id}: jobId=${u.jobId} but job missing`);
      else if (job.serfId !== u.id) violations.push(`serf ${u.id}: job ${job.id} names serf ${job.serfId}`);
      if (u.kind === 'serf' && u.carrying !== undefined && job && job.phase !== 'toDropoff') {
        violations.push(`serf ${u.id}: carrying ${u.carrying} in phase ${job.phase}`);
      }
    } else if (u.kind === 'serf' && u.carrying !== undefined) {
      // Holding a good with no job is a legitimate state since move orders
      // stopped destroying cargo: abortJob leaves the good in his hands on
      // purpose, and rehomeCarriedGoods only gets a turn on matcher ticks,
      // so he may walk the errand and then wait, both for seconds. What is
      // still wrong is a carrier in a task nothing drives — the shape an
      // ex-worker takes when he is unbound while a gather task is still on
      // him, which no system will ever pick up again.
      if (u.task.t !== 'idle' && u.task.t !== 'move') {
        violations.push(`serf ${u.id}: carrying ${u.carrying} in task ${u.task.t} with no job`);
      }
    }

    // Combat target consistency. `targetIsBuilding` is the discriminator that
    // picks which map `targetId` is read from, so the two must be cleared
    // together or the next target resolves against the wrong one. And a unit
    // told to walk away holds no target at all: the combat system skips it
    // entirely, so a target left on it is one nothing will ever act on or
    // clear — it just keeps reporting a fight it is not in.
    if (u.targetId === undefined && u.targetIsBuilding !== undefined) {
      violations.push(`unit ${u.id}: targetIsBuilding=${u.targetIsBuilding} with no targetId`);
    }
    if (u.task.t === 'move' && u.targetId !== undefined) {
      violations.push(`unit ${u.id}: holds target ${u.targetId} under a plain move order`);
    }

    // A plain move is the one task with no owner system behind it: movement
    // is the only thing that drives it, and it skips units with no route.
    // Every other system filters for idle units, so a move that has lost its
    // path is a unit that will stand there for the rest of the match.
    if (u.task.t === 'move' && u.path === null) {
      violations.push(`unit ${u.id}: plain move with no route — nothing will move it again`);
    }
  }

  return { tick: world.tick, violations };
}

/**
 * Goods conservation: sum of all stocks + carried == initial + produced -
 * consumed. `initial` is captured once at world creation by the caller.
 */
export function countGoods(world: World): GoodAmounts {
  const total: GoodAmounts = {};
  for (const b of world.buildings.values()) {
    if (b.dead) continue;
    for (const good of GOODS) {
      const n = (b.stock[good] ?? 0) + (b.inputs[good] ?? 0);
      if (n) total[good] = (total[good] ?? 0) + n;
    }
  }
  for (const u of world.units.values()) {
    if (!u.dead && u.carrying !== undefined) {
      total[u.carrying] = (total[u.carrying] ?? 0) + 1;
    }
  }
  return total;
}

export function checkLedger(world: World, initial: GoodAmounts): string[] {
  const now = countGoods(world);
  const violations: string[] = [];
  for (const good of GOODS) {
    const expected =
      (initial[good] ?? 0) +
      (world.ledger.produced[good] ?? 0) -
      (world.ledger.consumed[good] ?? 0);
    if ((now[good] ?? 0) !== expected) {
      violations.push(`ledger: ${GOOD_KEYS[good]} count=${now[good] ?? 0}, expected ${expected}`);
    }
  }
  return violations;
}
