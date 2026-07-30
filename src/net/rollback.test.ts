import { describe, expect, it } from 'vitest';
import { Rng } from '../shared/rng';
import { createWorld } from '../sim/world';
import { hashWorld } from '../sim/hash';
import { RollbackSession } from './rollback';
import { LoopbackRelay } from './loopback';
import type { SimCommand } from '../sim/commands';
import type { TurnRecord } from '../protocol/net';

/**
 * THE gold test for the netcode: two rollback sessions play the same match
 * through a jittery, laggy relay — different prediction histories, constant
 * mispredictions — and their confirmed worlds must stay bit-identical.
 * Everything is deterministic (seeded jitter), so a failure is a real bug.
 */

const CONFIG = {
  seed: 33,
  players: [{ kind: 'human' as const }, { kind: 'human' as const }],
  banditsEnabled: false,
};

function makeSession(playerId: number): RollbackSession {
  return new RollbackSession(createWorld(CONFIG), playerId);
}

interface Delivery<T> {
  at: number;
  payload: T;
}

describe('rollback under a jittery relay', () => {
  it('confirmed worlds stay identical; prediction converges', () => {
    const a = makeSession(0);
    const b = makeSession(1);
    const sessions = [a, b];
    const relay = new LoopbackRelay();
    const jitter = new Rng(7);

    // Client -> server and server -> client latency queues, in steps.
    const upstream: Delivery<{ playerId: number; env: ReturnType<RollbackSession['submitLocal']> }>[] = [];
    const downstream: Delivery<{ tick: number; records: TurnRecord[] }>[][] = [[], []];

    const STEPS = 2400;
    const COMMAND_UNTIL = 2000; // stop issuing late so everything acks
    for (let step = 0; step < STEPS; step++) {
      // Scripted play: both clients issue real commands from their own
      // (possibly mispredicted) view of the world.
      for (const s of sessions) {
        const id = s.localPlayerId;
        const period = id === 0 ? 40 : 55;
        if (step < COMMAND_UNTIL && step % period === (id === 0 ? 5 : 17)) {
          const commands: SimCommand[] = [];
          const serfs = [...s.predicted.units.values()]
            .filter((u) => !u.dead && u.owner === id && u.kind === 'serf')
            .slice(0, 4);
          if (serfs.length > 0) {
            commands.push({
              kind: 'moveUnits',
              unitIds: serfs.map((u) => u.id),
              x: 16 + ((step * 7) % 30),
              y: 16 + ((step * 11) % 30),
            });
          }
          if (step % (period * 3) === (id === 0 ? 5 : 17)) {
            commands.push({ kind: 'hireSerf' });
          }
          const env = s.submitLocal(commands);
          upstream.push({ at: step + 1 + jitter.int(6), payload: { playerId: id, env } });
        }
      }

      // Deliver due submissions, then close exactly one tick per step.
      for (let i = upstream.length - 1; i >= 0; i--) {
        if (upstream[i]!.at <= step) {
          const { playerId, env } = upstream.splice(i, 1)[0]!.payload;
          relay.submit(playerId, env);
        }
      }
      const closedNow = relay.closeNextTick();
      for (const ci of [0, 1]) {
        downstream[ci]!.push({ at: step + 1 + jitter.int(8), payload: closedNow });
      }

      // Deliver due TURN frames (in order) and pace prediction slightly
      // ahead of the server clock.
      for (const ci of [0, 1]) {
        const due = downstream[ci]!.filter((d) => d.at <= step);
        downstream[ci] = downstream[ci]!.filter((d) => d.at > step);
        for (const d of due) sessions[ci]!.ingestTurns(d.payload.tick, 1, d.payload.records);
        sessions[ci]!.advancePredicted(relay.closedTick + 3);
      }
    }

    // Drain: deliver everything still in flight; confirmation catches up.
    for (const d of upstream) relay.submit(d.payload.playerId, d.payload.env);
    for (const ci of [0, 1]) {
      for (const d of downstream[ci]!) sessions[ci]!.ingestTurns(d.payload.tick, 1, d.payload.records);
    }
    while (relay.closedTick < STEPS + 20) {
      const { tick, records } = relay.closeNextTick();
      for (const s of sessions) s.ingestTurns(tick, 1, records);
    }

    // The one assertion that matters: shared truth, bit for bit.
    expect(a.confirmedTick).toBe(b.confirmedTick);
    expect(hashWorld(a.confirmed)).toBe(hashWorld(b.confirmed));

    // The test must have exercised the machinery, not dodged it.
    expect(a.confirmedTick).toBeGreaterThan(STEPS); // confirmation really ran
    expect(relay.history.some((r) => r.length > 0)).toBe(true); // commands flowed
    expect(a.rollbacks + b.rollbacks).toBeGreaterThan(10);

    // Prediction converges onto truth once nothing is in flight.
    for (const s of sessions) s.advancePredicted(s.confirmedTick + 1);
    expect(hashWorld(a.predicted)).toBe(hashWorld(b.predicted));
  }, 60_000);

  it('confirmed matches an offline replay of the same closed history', () => {
    const a = makeSession(0);
    const relay = new LoopbackRelay();
    const jitter = new Rng(9);

    for (let step = 0; step < 600; step++) {
      if (step % 50 === 10) {
        const serfs = [...a.predicted.units.values()]
          .filter((u) => !u.dead && u.owner === 0 && u.kind === 'serf')
          .slice(0, 2);
        if (serfs.length > 0) {
          const env = a.submitLocal([
            { kind: 'moveUnits', unitIds: serfs.map((u) => u.id), x: 20, y: 20 + (step % 8) },
          ]);
          relay.submit(0, env);
        }
      }
      const { tick, records } = relay.closeNextTick();
      a.ingestTurns(tick, 1, records);
      a.advancePredicted(relay.closedTick + 2);
    }

    // Replay the relay's history cold — the authoritative reconstruction
    // (this is exactly what late-join and desync recovery do).
    const replay = createWorld(CONFIG);
    const replaySession = new RollbackSession(replay, 0);
    relay.history.forEach((records, tick) => replaySession.ingestTurns(tick, 1, records));
    expect(replaySession.confirmedTick).toBe(600); // the replay really ran
    expect(hashWorld(replaySession.confirmed)).toBe(hashWorld(a.confirmed));
  });
});
