import type { CommandEnvelope, TurnRecord } from '../protocol/net';

/**
 * In-memory stand-in for the relay server's tick authority: assigns
 * submissions to ticks (never earlier than the next unclosed one), closes
 * ticks on demand, and hands back the canonical records. Tests drive it
 * step by step; the real server does the same on a wall clock.
 */
export class LoopbackRelay {
  #closedTick = -1; // ticks <= this are closed; the world starts at tick 0
  #pending = new Map<number, TurnRecord[]>();
  /** Full closed history (the rejoin/replay source, mirroring the server). */
  readonly history: TurnRecord[][] = [];

  get closedTick(): number {
    return this.#closedTick;
  }

  submit(playerId: number, envelope: CommandEnvelope): void {
    const tick = Math.max(envelope.desiredTick, this.#closedTick + 1);
    let bucket = this.#pending.get(tick);
    if (!bucket) this.#pending.set(tick, (bucket = []));
    bucket.push({ tick, playerId, seq: envelope.seq, commands: envelope.commands });
  }

  /** Close the next tick; returns its canonical records (possibly empty). */
  closeNextTick(): { tick: number; records: TurnRecord[] } {
    const tick = ++this.#closedTick;
    const records = (this.#pending.get(tick) ?? []).sort(
      (a, z) => a.playerId - z.playerId || a.seq - z.seq,
    );
    this.#pending.delete(tick);
    this.history.push(records);
    return { tick, records };
  }
}
