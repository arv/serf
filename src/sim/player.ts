import type {Enum} from '../shared/enum.ts';
import type {AiStrategyId} from './defs/aiStrategies.ts';
import type {DifficultyId} from './defs/difficulty.ts';
import type {Owner} from './entities.ts';
import * as PlayerKindNs from './playerKindEnum.ts';
import type {TechState} from './world.ts';

export type PlayerKind = Enum<typeof PlayerKindNs>;

/**
 * Per-player faction state. One entry per seat in world.players, indexed by
 * owner id (invariant: world.players[i].id === i). Plain serializable data —
 * it rides the save file and the rollback snapshots. AI seats carry no brain
 * state here: a brain runs beside the world and speaks ordinary commands,
 * so the sim stays input-driven.
 */
export interface PlayerState {
  id: Owner;
  kind: PlayerKind;
  /**
   * Which AI playbook this seat was dealt (ai seats only). The world is
   * where it lives because the deal must outlive the process that made it:
   * a reloaded save and a resumed match have to face the same opponents,
   * and the brains are rebuilt from scratch in both. Absent on saves from
   * before the deal existed.
   */
  strategy?: AiStrategyId;
  /**
   * The tier this seat is playing at, for the same reason `strategy` lives
   * here rather than in the config: the brains are rebuilt from scratch on
   * a reload and on a resumed match, and an opponent that got easier across
   * a save would be as much a bug as one that changed its opening.
   *
   * On every seat, human ones included — unlike `strategy`, which only a
   * computer has. A tier is a fact about the match, and the seat is where
   * the match writes its facts down: it is what an AI seat's brain plays
   * at, and it is how the end card knows which setting to carry into the
   * next commission. Absent on saves from before difficulty existed, which
   * reads as `normal` — the printed game.
   */
  difficulty?: DifficultyId;
  techs: TechState;
  /** Stone-road paving enabled (unlocked by the Masonry tech). */
  pavingUnlocked: boolean;
  /** False once this player's storehouse is destroyed (eliminated). */
  alive: boolean;
}

export function makePlayer(
  id: Owner,
  kind: PlayerKind,
  strategy?: AiStrategyId,
  difficulty?: DifficultyId,
): PlayerState {
  return {
    id,
    kind,
    strategy,
    difficulty,
    techs: {researched: [], festivalTicksLeft: 0},
    pavingUnlocked: false,
    alive: true,
  };
}

/**
 * The spelling of each seat kind, and the read side of it.
 *
 * The lobby protocol and a replay's config head both say 'human' and 'ai'
 * in words, and both stay that way: one is a JSON document a person may
 * hand-edit, the other a socket message whose whole job is to be legible
 * in a log. The sim takes the number; these two convert at the door.
 */
export const PLAYER_KIND_KEYS: Readonly<Record<PlayerKind, string>> = {
  [PlayerKindNs.human]: 'human',
  [PlayerKindNs.ai]: 'ai',
};

export function playerKindFromKey(key: unknown): PlayerKind | undefined {
  if (key === 'human') return PlayerKindNs.human;
  if (key === 'ai') return PlayerKindNs.ai;
  // ...or the id itself. A replay's config head is written straight out of
  // the WorldConfig it recorded, so a file this build wrote says 1; a lobby
  // message and a hand-written fixture say 'human'. Both are legitimate at
  // this door, so both are read here.
  if (key === PlayerKindNs.human || key === PlayerKindNs.ai) return key;
  return undefined;
}
