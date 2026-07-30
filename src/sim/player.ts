import type { Owner } from './entities';
import type { TechState } from './world';

/**
 * Per-player faction state. One entry per seat in world.players, indexed by
 * owner id (invariant: world.players[i].id === i). Plain serializable data —
 * it rides the save file and the rollback snapshots.
 */

/** The AI opponent's entire memory (see systems/ai.ts). Lives on the player
 * so save/load and rollback capture it for free. Uses its own RNG substream,
 * never the tick's shared Rng — inserting or reordering AI decisions must
 * not shift the production/wander/bandits streams. */
export interface AiState {
  rngState: number;
  lastAttackTick: number;
  lastRallyTick: number;
  attacking: boolean;
}

export interface PlayerState {
  id: Owner;
  kind: 'human' | 'ai';
  techs: TechState;
  /** Stone-road paving enabled (unlocked by the Masonry tech). */
  pavingUnlocked: boolean;
  /** False once this player's storehouse is destroyed (eliminated). */
  alive: boolean;
  ai?: AiState;
}

export function makePlayer(id: Owner, kind: 'human' | 'ai', seed: number): PlayerState {
  return {
    id,
    kind,
    techs: { researched: [], festivalTicksLeft: 0 },
    pavingUnlocked: false,
    alive: true,
    ai:
      kind === 'ai'
        ? {
            // Substream seed: mix the world seed with the slot id.
            rngState: (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) + id * 0x27d4eb2f) | 0,
            lastAttackTick: 0,
            lastRallyTick: 0,
            attacking: false,
          }
        : undefined,
  };
}
