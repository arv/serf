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
import { AiBrain } from './systems/ai.ts';
import type { PlayerCommand } from './tick.ts';
import type { World } from './world.ts';

export class AiSeats {
  #brains: AiBrain[];

  constructor(world: World) {
    this.#brains = world.players.filter((p) => p.kind === 'ai').map((p) => new AiBrain(p.id));
  }

  get count(): number {
    return this.#brains.length;
  }

  /** This tick's AI orders, ready to apply alongside the players'. */
  decide(world: World): PlayerCommand[] {
    const out: PlayerCommand[] = [];
    for (const brain of this.#brains) {
      if (!brain.shouldDecide(world.tick)) continue;
      for (const cmd of brain.decide(world)) out.push({ playerId: brain.playerId, cmd });
    }
    return out;
  }
}
