import type { BuildingSnap } from '../protocol/messages';
import { BuildingState } from '../sim/entities';

/**
 * A built tower's halt lever is the roof: starting it mans the tower —
 * archers if the village has any, villagers with stones if it does not —
 * and halting it sends whoever is up there back down and calls nobody else
 * up. So the lever's vocabulary on a tower is manning, not the workshop's
 * "Pause": a halted tower is not a tower working slowly, it is an empty one.
 *
 * Which is also why a standing tower can never read "2/2 archers on the roof
 * · paused" any more. Halted and manned is not a state the sim has.
 */
export interface LevyOrder {
  /** The lever's face and tooltip title: what pressing it would do. */
  label: 'Man the tower' | 'Stand down';
}

/**
 * The manning order for `b`, or undefined for everything that is not a
 * standing manned building — including a tower still on the scaffold, whose
 * lever is the ordinary build halt and reads as one.
 */
export function levyOrder(b: BuildingSnap): LevyOrder | undefined {
  if (b.garrisonCap === undefined || b.state !== BuildingState.built) return undefined;
  return { label: b.paused ? 'Man the tower' : 'Stand down' };
}
