import type { AiStrategyId } from './defs/aiStrategies.ts';
import type { Owner } from './entities.ts';
import type { TechState } from './world.ts';

/**
 * Per-player faction state. One entry per seat in world.players, indexed by
 * owner id (invariant: world.players[i].id === i). Plain serializable data —
 * it rides the save file and the rollback snapshots. AI seats carry no brain
 * state here: a brain runs beside the world and speaks ordinary commands,
 * so the sim stays input-driven.
 */
export interface PlayerState {
  id: Owner;
  kind: 'human' | 'ai';
  /**
   * Which AI playbook this seat was dealt (ai seats only). The world is
   * where it lives because the deal must outlive the process that made it:
   * a reloaded save and a resumed match have to face the same opponents,
   * and the brains are rebuilt from scratch in both. Absent on saves from
   * before the deal existed.
   */
  strategy?: AiStrategyId;
  techs: TechState;
  /** Stone-road paving enabled (unlocked by the Masonry tech). */
  pavingUnlocked: boolean;
  /** False once this player's storehouse is destroyed (eliminated). */
  alive: boolean;
}

export function makePlayer(id: Owner, kind: 'human' | 'ai', strategy?: AiStrategyId): PlayerState {
  return {
    id,
    kind,
    strategy,
    techs: { researched: [], festivalTicksLeft: 0 },
    pavingUnlocked: false,
    alive: true,
  };
}
