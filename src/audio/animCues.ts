/**
 * Which sound an animation change makes — the pure half of the unit-audio
 * story, split out because the transition rules are a matrix worth testing
 * exhaustively while the render loop that feeds it is not.
 *
 * The `prev === null` row encodes one carefully chosen rule. SceneSync
 * culls off-screen units by nulling their current clip so re-entry
 * restarts it cleanly; audio keeps its own last-key memory
 * (`visual.audioKey`), and when that memory is empty the unit is either
 * brand new or just scrolled back into view. Neither should announce
 * itself — a pan across a battlefield must not machine-gun the speakers
 * with re-entry cues — with a single exception: a unit first seen already
 * entering `death` still deserves its death sound, because that state is
 * momentary and unrepeatable. Everything else waits for a transition the
 * player actually watched happen.
 */

import type { AnimKey } from '../render/characters';
import type { CueId } from './cues';

/** State-entry cues: fired once when a visible unit switches clips. */
const ENTRY_CUES: Partial<Record<AnimKey, CueId>> = {
  death: 'unitDeath',
};

export function animCue(prev: AnimKey | null, next: AnimKey): CueId | null {
  if (prev === next) return null;
  const cue = ENTRY_CUES[next];
  if (cue === undefined) return null;
  if (prev === null && next !== 'death') return null;
  return cue;
}

/**
 * Per-cycle percussion, for the mixer 'loop'-event hook (step 2): the
 * impact lands `impactPhase01` through the clip, not at the wrap point
 * where the event fires, so the player schedules that far ahead —
 * Web Audio absolute time makes that exact and free. A gait cycle is two
 * footfalls (`perCycle: 2`), the second half a cycle later.
 */
export const LOOP_CUES: Partial<
  Record<AnimKey, { cue: CueId; impactPhase01: number; perCycle: 1 | 2 }>
> = {
  walk: { cue: 'footstep', impactPhase01: 0.15, perCycle: 2 },
  jog: { cue: 'footstep', impactPhase01: 0.15, perCycle: 2 },
  carry: { cue: 'footstep', impactPhase01: 0.15, perCycle: 2 },
  work: { cue: 'chop', impactPhase01: 0.4, perCycle: 1 },
  pickaxe: { cue: 'pickaxe', impactPhase01: 0.45, perCycle: 1 },
  hammer: { cue: 'hammer', impactPhase01: 0.38, perCycle: 1 },
  attack: { cue: 'swordSwing', impactPhase01: 0.35, perCycle: 1 },
  shoot: { cue: 'bowRelease', impactPhase01: 0.85, perCycle: 1 },
};
