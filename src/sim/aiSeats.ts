/**
 * The AI seats of one world, run next to it.
 *
 * This used to be a Web Worker per brain, each holding a full replica World
 * and running its own tickWorld to stay in step. That existed because
 * lockstep had no single owner of the world: a brain had to be a peer like
 * any other client. With the world owned in one place — the sim worker in
 * single player, the server in multiplayer — a brain is just a function
 * called next to it, and the replicas go away.
 *
 * Brains think from the state everyone else sees at this tick, and their
 * commands go in with the players' for the same tick. That ordering is the
 * one the worker version had, and it matters: deciding after the tick would
 * give the AI a frame of hindsight nobody else gets.
 */
import {strategyOf, type AiStrategy} from './defs/aiStrategies.ts';
import type {Owner} from './entities.ts';
import * as PlayerKind from './playerKindEnum.ts';
import {AiBrain} from './systems/ai.ts';
import type {PlayerCommand} from './tick.ts';
import type {World} from './world.ts';

export class AiSeats {
  #brains: AiBrain[];

  constructor(world: World) {
    // The playbook AND the tier come off the seat: both were dealt at
    // creation and both ride the save, so a reloaded match faces the same
    // opponents playing the same way.
    this.#brains = world.players
      .filter(p => p.kind === PlayerKind.ai)
      .map(
        p =>
          new AiBrain(
            p.id,
            strategyOf(p.strategy),
            world.map.size,
            p.difficulty,
          ),
      );
  }

  get count(): number {
    return this.#brains.length;
  }

  /** The seats with a brain, for anyone pacing per-seat work (the lab's
   * consultation cadence). */
  seatIds(): Owner[] {
    return this.#brains.map(b => b.playerId);
  }

  /** Lay advice over one seat's playbook — the lab's steering seam. Values
   * arrive already validated (src/ai/advice.ts); an unknown seat is a
   * no-op, since advice can outlive the brain it was meant for. */
  applyAdvice(playerId: Owner, override: Partial<AiStrategy>): void {
    this.#brains.find(b => b.playerId === playerId)?.setOverride(override);
  }

  /** One seat's brain — how the seat summary (src/ai/summary.ts) reads
   * what the seat has scouted (vision + intel) instead of the raw world. */
  brainFor(playerId: Owner): AiBrain | undefined {
    return this.#brains.find(b => b.playerId === playerId);
  }

  /** This tick's AI orders, ready to apply alongside the players'. */
  decide(world: World): PlayerCommand[] {
    const out: PlayerCommand[] = [];
    for (const brain of this.#brains) {
      if (!brain.shouldDecide(world.tick)) continue;
      for (const cmd of brain.decide(world))
        out.push({playerId: brain.playerId, cmd});
    }
    return out;
  }
}
