import type { BuildingSnap } from '../protocol/messages';

/**
 * A built tower's halt lever is its levy and nothing else. Starting it calls
 * villagers onto the roof; halting it stops calling them and sends the ones
 * already up back to work. Soldiers are never touched either way — an idle
 * archer costs the village nothing — so the lever's vocabulary on a tower is
 * the levy's, not the workshop's "Pause".
 *
 * That also means the lever can run out of anything to move. A garrison is
 * one kind of man or the other (garrisonKind, in the sim): a soldier at the
 * door relieves the levy outright, and no villager is ever let up beside one.
 * So the moment archers hold a tower — even one place of two — the levy order
 * stops deciding anything, and it never starts again, because a standing
 * tower's soldiers never come down. A card that said "paused" there was
 * describing a manned, shooting tower over a button that did nothing.
 */
export interface LevyOrder {
  /** The lever's face and tooltip title: what pressing it would do. */
  label: 'Call up levy' | 'Stand down';
  /** False when pressing it would change nothing — soldiers hold the roof. */
  live: boolean;
}

/**
 * The levy order for `b`, or undefined for everything that is not a standing
 * manned building — including a tower still on the scaffold, whose lever is
 * the ordinary build halt and reads as one.
 */
export function levyOrder(b: BuildingSnap): LevyOrder | undefined {
  if (b.garrisonCap === undefined || b.state !== 'built') return undefined;
  const held = (b.garrison ?? 0) > 0 && b.levied !== true;
  return { label: b.paused ? 'Call up levy' : 'Stand down', live: !held };
}
