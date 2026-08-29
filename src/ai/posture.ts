import {POSTURES, type PostureId} from '../sim/defs/aiPostures.ts';
import * as PostureIdNs from '../sim/defs/postureIdEnum.ts';
import type {StrategyAdvice} from './advice.ts';
import {readOpponent} from './archetype.ts';
import * as Archetype from './archetypeEnum.ts';
import type {AiWorldSummary} from './summary.ts';

/**
 * The advice side of the stance system.
 *
 * The stance data itself — the knob table, the spellings, the ids — lives
 * in sim (src/sim/defs/aiPostures.ts) because the brain's stance engine
 * reads it, and everything that steers commands belongs inside the
 * replay-version hash surface. This module re-exports it for the advice
 * seam and keeps the two things that are advice-only:
 *
 * - `postureAdvice`, which expands a stance name into StrategyAdvice for
 *   parseAdvice's `{"posture":"siege"}` reply shape;
 * - the two rule-based stance pickers the lab runs as engines
 *   (`--engine posture` / `posture-reads`), kept as the reference every
 *   recorded number was measured under and as the test bench for candidate
 *   cascades — a rule that wins here, paired, earns a place in playbook
 *   data (AiStrategy.stances); one that loses stays an experiment.
 */
export {
  isPostureId,
  POSTURE_KEYS,
  POSTURE_ORDER,
  postureFromKey,
  POSTURES,
  type Posture,
  type PostureKnobs,
} from '../sim/defs/aiPostures.ts';
export type {PostureId} from '../sim/defs/aiPostures.ts';

/**
 * The knob set every posture carries is exactly the advisable set minus the
 * keys the table's header explains away — asserted here from the advice
 * side, so the sim table and the advice contract cannot drift apart: a new
 * StrategyAdvice knob without a posture entry (or the reverse) is a type
 * error on this line.
 */
const _POSTURES_COVER_ADVICE: Record<
  PostureId,
  {
    knobs: Readonly<
      Required<
        Omit<
          StrategyAdvice,
          | 'trainPreference'
          | 'weaponMix'
          | 'reason'
          | 'posture'
          | 'marchConfidence'
        >
      >
    >;
  }
> = POSTURES;
void _POSTURES_COVER_ADVICE;

/** A posture's knobs as advice. Copied, because the caller merges into it
 * and the table is shared across every seat in the process. */
export function postureAdvice(id: PostureId): StrategyAdvice {
  return {...POSTURES[id].knobs};
}

/**
 * The rule-based stance picker the lab means by `--engine posture`: stances
 * chosen from the summary, without reading the opponent.
 *
 * It is the reference on the evidence. `choosePostureReadingOpponent` below
 * conditions the same cascade on an archetype and does not beat it — 0 won,
 * 2 lost, p = 0.50 over eighty seeds — so the simpler rule holds the name
 * that every recorded number was measured under, and the classifier waits
 * behind `--engine posture-reads` until a fair test says otherwise.
 *
 * The shape of this cascade is measured, not reasoned. Its first draft was
 * the intuitive one — grow while small, raid while nothing is found, siege
 * once strong — and holding each stance for a whole match instead
 * (`--engine posture:<id>`, 40 seeds) said the intuition was wrong:
 *
 *     posture:siege    68.4%   (19 flips toward the advised seat, 6 away)
 *     posture:muster   60.8%
 *     posture:expand   50.0%
 *     the draft rule   51.3%
 *     random            46.6%
 *
 * Paired McNemar over the same seeds: siege beat the draft rule (p =
 * 0.012) and beat expand (p = 0.0024); the draft rule did not beat random
 * at all (p = 0.63). A cascade losing to its own best constant means the
 * *picking* was the problem, not the menu — so the picking defaults to
 * the aggressive end and deviates only where standing pat is untenable.
 * The shipped playbooks' stance cascades (AiStrategy.stances) are this
 * lesson written into data.
 *
 * The lesson under the numbers is about this valley: matches resolve in
 * about eleven minutes, so an economy stance spends the decisive window
 * paying for growth that never gets to fight. `expand` and `raid` stay in
 * the table because they are honest options on maps and seat counts the
 * bake-off has not swept — but nothing in this function chooses them.
 */
export function choosePosture(summary: AiWorldSummary): PostureId {
  // Someone is in the yard. The only situation worth breaking stance for:
  // an army that marches while its castle burns loses the castle.
  if (summary.me.underAttack) return PostureIdNs.fortify;

  // Nothing located yet. `siege` sets prefersRivals, which parks the army
  // until a castle is found — so until one is, mass instead, which leaves
  // the captain free to clear the camps he can reach.
  const found = summary.rivals.some(r => r.alive && r.found);
  if (!found) return PostureIdNs.muster;

  // A castle is on the map. Go and take it — including when the army is
  // still thin, which is where the draft rule went wrong: it waited, and
  // waiting is what `expand` and the printed playbook already lose to.
  return PostureIdNs.siege;
}

/**
 * The same cascade with one more input: what kind of lord is on the other
 * side (src/ai/archetype.ts).
 *
 * Two deviations from the blind rule, and only two, so that a measurement
 * has something to attribute:
 *
 *  - **A quiet neighbour is pounced on.** A rival whose castle is found and
 *    whose army has never amounted to anything gets marched on at five
 *    soldiers instead of twelve. This is the one thing the march-gate
 *    negative result asked for by name: blind early aggression loses, so
 *    make it not blind.
 *  - **A lone raider no longer breaks the siege.** `underAttack` is any
 *    hostile in sight of the castle, bandits included, and dropping stance
 *    for one of them is exactly the kind of deviation that left the blind
 *    rule (58.3%) short of the `siege` constant it could have named
 *    (68.4%). Stance now breaks for an opponent who has actually come at us
 *    in force — a rusher — and for an unread board, where fortifying is the
 *    safe read of ignorance.
 *
 * Both were hypotheses, and both were measured against the null that
 * matters — the same cascade with `readOpponent` deleted. Eighty seeds,
 * same build, same valley:
 *
 *     posture       (opponent ignored)   51.8%   (73/141)
 *     posture-reads (opponent read)      50.7%   (73/144)
 *     paired McNemar over the same seeds: 0 trials won, 2 lost, p = 0.50
 *
 * The branch is not inert — it changes the stance on about one consultation
 * in seven, and the two arms end up in a materially different world in 41
 * of 160 paired trials, with a different winner in five. It simply does not
 * win those trials. **Conditioning on the opponent, here, decides nothing.**
 *
 * So this function is kept the way `combatOdds.ts` is kept: as the wiring a
 * better read would plug into, with the measurement that says it is not
 * paying yet written down beside it. If you are about to build on it, the
 * thing to fix first is upstream — three playbooks as different as
 * `warlord` and `abbot` look far more alike from behind the fog than they
 * do in their blurbs, and a classifier cannot separate what scouting never
 * showed it.
 */
export function choosePostureReadingOpponent(
  summary: AiWorldSummary,
): PostureId {
  const opponent = readOpponent(summary);

  if (
    summary.me.underAttack &&
    opponent !== Archetype.booming &&
    opponent !== Archetype.turtling
  ) {
    return PostureIdNs.fortify;
  }

  const found = summary.rivals.some(r => r.alive && r.found);
  if (!found) return PostureIdNs.muster;

  if (opponent === Archetype.booming) return PostureIdNs.pounce;

  return PostureIdNs.siege;
}
