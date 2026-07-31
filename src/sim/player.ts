import type { Owner } from './entities.ts';
import type { TechState } from './world.ts';

/**
 * Per-player faction state. One entry per seat in world.players, indexed by
 * owner id (invariant: world.players[i].id === i). Plain serializable data —
 * it rides the save file and the rollback snapshots. AI seats carry no brain
 * state here: each AI runs in its own worker and speaks ordinary commands,
 * so the sim stays input-driven.
 */
export interface PlayerState {
  id: Owner;
  kind: 'human' | 'ai';
  techs: TechState;
  /** Stone-road paving enabled (unlocked by the Masonry tech). */
  pavingUnlocked: boolean;
  /** False once this player's storehouse is destroyed (eliminated). */
  alive: boolean;
}

export function makePlayer(id: Owner, kind: 'human' | 'ai'): PlayerState {
  return {
    id,
    kind,
    techs: { researched: [], festivalTicksLeft: 0 },
    pavingUnlocked: false,
    alive: true,
  };
}
