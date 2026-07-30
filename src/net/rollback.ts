import { cloneWorld } from '../sim/clone';
import { setResimulating } from '../sim/log';
import { tickWorld, type PlayerCommand } from '../sim/tick';
import type { GameEvent, World } from '../sim/world';
import type { CommandEnvelope, TurnRecord } from '../protocol/net';

/**
 * GGPO-style rollback bookkeeping — pure logic, no sockets, no timers; the
 * worker's relay client feeds it frames and paces it, and the loopback
 * harness proves it offline.
 *
 * Two worlds: `confirmed` advances only through server-closed ticks and IS
 * the rollback snapshot (mispredictions can only be at ticks beyond it, so
 * no snapshot ring is needed). `predicted` is what the renderer sees: local
 * commands apply optimistically, remote players are predicted silent. When
 * a closed tick disagrees with what prediction applied, predicted is
 * rebuilt from confirmed and re-simulated.
 */

/** Stop predicting this far ahead of confirmation (2s) — the stall rule. */
export const MAX_PREDICTION = 40;

interface LocalEnvelope {
  envelope: CommandEnvelope;
  /** Where prediction will (re)apply it; bumped forward on rollback. */
  scheduledTick: number;
}

function canonical(records: TurnRecord[]): TurnRecord[] {
  return [...records].sort((a, z) => a.playerId - z.playerId || a.seq - z.seq);
}

function flatten(records: TurnRecord[]): PlayerCommand[] {
  const out: PlayerCommand[] = [];
  for (const r of records) {
    for (const cmd of r.commands) out.push({ playerId: r.playerId, cmd });
  }
  return out;
}

function appliedKey(records: { playerId: number; seq: number }[]): string {
  return records
    .map((r) => `${r.playerId}:${r.seq}`)
    .sort()
    .join(',');
}

export class RollbackSession {
  confirmed: World;
  predicted: World;
  readonly localPlayerId: number;
  #nextSeq = 0;
  /** Server-closed records by tick. Empty closed ticks carry no records —
   * closedness is tracked separately by #closedThrough. */
  #turnLog = new Map<number, TurnRecord[]>();
  /** Highest contiguously closed tick per the TURN frames' tick ranges. */
  #closedThrough = -1;
  /** Closed ticks received ahead of the contiguous frontier (frames can
   * arrive out of order in tests; the wire itself is ordered). */
  #closedAhead = new Set<number>();
  /** What prediction actually applied per tick, as a canonical key. */
  #appliedLog = new Map<number, string>();
  /** Local envelopes not yet seen in a closed tick. */
  #localUnconfirmed: LocalEnvelope[] = [];
  /** Diagnostics: how many rollbacks this session performed. */
  rollbacks = 0;

  /** Exactly-once event sink — fired per confirmed tick with its events. */
  onConfirmedTick?: (world: World, events: GameEvent[]) => void;
  /** Fired after a rollback re-sim completes (worker posts a full refresh). */
  onRollback?: () => void;

  constructor(world: World, localPlayerId: number) {
    this.confirmed = world;
    this.predicted = cloneWorld(world);
    this.localPlayerId = localPlayerId;
  }

  get confirmedTick(): number {
    return this.confirmed.tick;
  }

  get predictedTick(): number {
    return this.predicted.tick;
  }

  /** Ticks of prediction ahead of confirmation (the stall gauge). */
  get lead(): number {
    return this.predicted.tick - this.confirmed.tick;
  }

  /** Queue local commands; returns the envelope to put on the wire. */
  submitLocal(commands: SimCommandList): CommandEnvelope {
    const envelope: CommandEnvelope = {
      desiredTick: Math.max(this.predicted.tick + 1, this.confirmed.tick + 1),
      seq: this.#nextSeq++,
      commands,
    };
    this.#localUnconfirmed.push({ envelope, scheduledTick: envelope.desiredTick });
    return envelope;
  }

  /** Feed a server-closed TURN frame (a contiguous tick range plus its
   * records — empty closed ticks are ticks in the range with no records);
   * advances confirmation and rolls back prediction if any closed tick
   * disagrees with what it applied. */
  ingestTurns(firstTick: number, tickCount: number, records: TurnRecord[]): void {
    for (const r of records) {
      let bucket = this.#turnLog.get(r.tick);
      if (!bucket) this.#turnLog.set(r.tick, (bucket = []));
      bucket.push(r);
      // Ack: our own record came back — it is scheduled truth now.
      if (r.playerId === this.localPlayerId) {
        this.#localUnconfirmed = this.#localUnconfirmed.filter(
          (l) => l.envelope.seq !== r.seq,
        );
      }
    }
    for (let t = firstTick; t < firstTick + tickCount; t++) {
      if (t > this.#closedThrough) this.#closedAhead.add(t);
    }
    while (this.#closedAhead.has(this.#closedThrough + 1)) {
      this.#closedThrough++;
      this.#closedAhead.delete(this.#closedThrough);
    }
    let mispredicted = false;
    while (this.confirmed.tick <= this.#closedThrough) {
      const tick = this.confirmed.tick;
      const closed = canonical(this.#turnLog.get(tick) ?? []);
      tickWorld(this.confirmed, flatten(closed));
      this.onConfirmedTick?.(this.confirmed, this.confirmed.pendingEvents.splice(0));
      this.confirmed.pendingDeltas.length = 0; // predicted drives the mirror
      const predictedKey = this.#appliedLog.get(tick) ?? '';
      if (tick < this.predicted.tick && predictedKey !== appliedKey(closed)) {
        mispredicted = true;
      }
      this.#appliedLog.delete(tick);
      this.#turnLog.delete(tick);
    }
    if (this.confirmed.tick >= this.predicted.tick) {
      // Confirmation overtook prediction (stall/catch-up): no guesswork to
      // repair — restart prediction from truth.
      this.predicted = cloneWorld(this.confirmed);
      this.#appliedLog.clear();
      this.rollbacks++;
      this.onRollback?.();
    } else if (mispredicted) {
      this.#rollback();
    }
  }

  /** Advance prediction toward targetTick (bounded by MAX_PREDICTION).
   * Returns the number of ticks actually run. */
  advancePredicted(targetTick: number): number {
    let ran = 0;
    while (
      this.predicted.tick < targetTick &&
      this.predicted.tick - this.confirmed.tick < MAX_PREDICTION
    ) {
      this.#stepPredicted();
      ran++;
    }
    return ran;
  }

  get stalled(): boolean {
    return this.predicted.tick - this.confirmed.tick >= MAX_PREDICTION;
  }

  #stepPredicted(): void {
    const tick = this.predicted.tick;
    const known = this.#turnLog.get(tick);
    let commands: PlayerCommand[];
    let key: string;
    if (known) {
      // A closed-but-not-yet-confirmed tick (arrives while prediction is
      // behind): apply the truth directly.
      const sorted = canonical(known);
      commands = flatten(sorted);
      key = appliedKey(sorted);
    } else {
      const due = this.#localUnconfirmed.filter((l) => l.scheduledTick === tick);
      commands = due.flatMap((l) =>
        l.envelope.commands.map((cmd) => ({ playerId: this.localPlayerId, cmd })),
      );
      key = appliedKey(
        due.map((l) => ({ playerId: this.localPlayerId, seq: l.envelope.seq })),
      );
    }
    tickWorld(this.predicted, commands);
    this.#appliedLog.set(tick, key);
  }

  #rollback(): void {
    const target = this.predicted.tick;
    this.predicted = cloneWorld(this.confirmed);
    this.#appliedLog.clear();
    // Unacked local commands re-predict at the earliest possible future tick.
    for (const l of this.#localUnconfirmed) {
      l.scheduledTick = Math.max(l.scheduledTick, this.confirmed.tick + 1);
    }
    setResimulating(true);
    while (this.predicted.tick < target) {
      this.#stepPredicted();
      // Re-simulated ticks must not re-emit events or mirror deltas.
      this.predicted.pendingEvents.length = 0;
      this.predicted.pendingDeltas.length = 0;
    }
    setResimulating(false);
    this.rollbacks++;
    this.onRollback?.();
  }
}

type SimCommandList = CommandEnvelope['commands'];
