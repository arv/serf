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

import * as AnimKey from '../render/animKeyEnum.ts';
import type {Enum} from '../shared/enum.ts';
import type {CueId} from './cues';

type AnimKey = Enum<typeof AnimKey>;

/** State-entry cues: fired once when a visible unit switches clips. */
const ENTRY_CUES: Partial<Record<AnimKey, CueId>> = {
  [AnimKey.death]: 'unitDeath',
};

export function animCue(prev: AnimKey | null, next: AnimKey): CueId | null {
  if (prev === next) return null;
  const cue = ENTRY_CUES[next];
  if (cue === undefined) return null;
  if (prev === null && next !== AnimKey.death) return null;
  return cue;
}

/**
 * Per-cycle percussion, for the mixer 'loop'-event hook (step 2): the
 * impact lands `impactPhase01` through the clip, not at the wrap point
 * where the event fires, so the player schedules that far ahead —
 * Web Audio absolute time makes that exact and free. `perCycle: 2` is a
 * half-cycle symmetry: the second impact lands half a clip after the
 * first — a gait's other foot, a tool loop's second swing.
 *
 * The phases are measured, not guessed: tools/modelLab/animImpacts.mjs
 * evaluates the clips' own bone tracks and prints where each contact
 * lands (a footfall is the foot descending into its floor band; a strike
 * is the hand's swing speed collapsing at the workpiece). Re-run it when
 * a clip mapping in characters.ts changes. Two alignment rules, because
 * there are two kinds of cue: an impact sound (footstep, tool bite)
 * fires at the contact; a motion sound leads it — the sword whoosh
 * starts where the blade starts so its sweep peaks at the hit, and the
 * bow twang fires the instant the string hand lets go.
 */
export const LOOP_CUES: Partial<
  Record<
    AnimKey,
    {
      cue: CueId;
      impactPhase01: number;
      perCycle: 1 | 2;
      /** Phase overrides by clip name, for keys that play a different
       * clip per unit kind (KKSpec.attackClip) with the impact somewhere
       * else entirely. */
      byClip?: Record<string, number>;
    }
  >
> = {
  // Walking_A: heel-strike ends right at the wrap, toes flat by 0.09.
  [AnimKey.walk]: {cue: 'footstep', impactPhase01: 0.05, perCycle: 2},
  // Running_A lands on the ball of the foot: toe down 0.09, planted 0.12.
  [AnimKey.jog]: {cue: 'footstep', impactPhase01: 0.1, perCycle: 2},
  // Carry composites borrow their legs (characters.ts): Carry_Walk from
  // Walking_A — same footfalls — and a jogging carrier's Carry_Jog from
  // Running_A, which lands like the jog.
  [AnimKey.carry]: {
    cue: 'footstep',
    impactPhase01: 0.05,
    perCycle: 2,
    byClip: {Carry_Jog: 0.1},
  },
  // Chopping: one swing, 0.18..0.28, the axe stopping in the trunk.
  [AnimKey.work]: {cue: 'chop', impactPhase01: 0.27, perCycle: 1},
  // Pickaxing and Hammering both genuinely strike twice per clip, on the
  // half-cycle: pick bites at 0.06 and 0.56, hammer falls at 0.09 and
  // 0.59. One cue per loop left the second blow silent and put the first
  // in the middle of the wind-up.
  [AnimKey.pickaxe]: {cue: 'pickaxe', impactPhase01: 0.06, perCycle: 2},
  [AnimKey.hammer]: {cue: 'hammer', impactPhase01: 0.09, perCycle: 2},
  [AnimKey.attack]: {
    cue: 'swordSwing',
    // Melee_1H_Attack_Chop: blade travels 0.50..0.56 — whoosh from 0.50.
    impactPhase01: 0.5,
    perCycle: 1,
    byClip: {
      // The staff knight's thrust: 0.21..0.25, over before the default
      // phase would even have started the sound.
      Melee_1H_Attack_Stab: 0.21,
      // The barbarian's slower two-handed arc, 0.39..0.53.
      Melee_2H_Attack_Chop: 0.45,
    },
  },
  // Ranged_Bow_Draw: the string hand snaps away at 0.50 and the pose
  // freezes by 0.58 — the twang belongs to the release, not the hold.
  [AnimKey.shoot]: {cue: 'bowRelease', impactPhase01: 0.5, perCycle: 1},
};
