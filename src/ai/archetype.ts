import type { AiWorldSummary, RivalSummary } from './summary.ts';
import type { Enum } from '../shared/enum.ts';
import * as ArchetypeNs from './archetypeEnum.ts';
export * as Archetype from './archetypeEnum.ts';
export type Archetype = Enum<typeof ArchetypeNs>;

/**
 * Reading the opponent: what kind of game is the other lord playing?
 *
 * A pure function of one rival's line in the summary, so it is testable
 * against literal objects with no world behind them — and so the posture
 * rule that consumes it stays a pure function too.
 *
 * Everything it reads is fog-honest, because the summary is (src/ai/
 * summary.ts): their army is what this seat's scout has actually laid eyes
 * on inside the trust window, their village is the part of it standing on
 * explored ground, and their opening is the first-contact record the brain
 * keeps (src/sim/systems/ai.ts). Ignorance therefore has a name of its own
 * — `unknown` — and the rule that reads this must treat it as "no opinion",
 * never as "peaceful".
 *
 * What the thresholds are worth is a measured question and the answer is
 * "not much yet" — the rule that consumes them does not beat the same rule
 * with them deleted (p = 0.50 at eighty seeds; the note above
 * `choosePosture` has the numbers). Read that before building on this.
 *
 * The read itself does track the opponent, which is the part worth keeping.
 * Watching each shipped playbook play itself for twelve seeds, per
 * consultation:
 *
 *     opponent   rusher   booming   turtling   unknown
 *     warlord      8.0%      3.7%     27.2%     61.1%
 *     steward      0.7%      8.6%     41.1%     49.7%
 *     abbot        1.3%     15.2%     39.4%     44.1%
 *
 * The warlord — "comes early" — is read as a rusher six times as often as
 * the abbot, and the abbot — "builds wide, keeps its soldiers home" — is
 * read as booming four times as often as the warlord. The ordering is
 * right; the margins are small, and half of every column is `unknown`,
 * because behind fog three quite different openings look much alike.
 */


/**
 * The numbers the classifier turns on. Calibrated by watching the three
 * shipped playbooks play themselves (8 seeds each, minutes 5 through 14),
 * not by taste — and the calibration is also what makes the thresholds
 * suspect, because those three openings look far more alike from the
 * outside than their blurbs suggest.
 */
export const ARCHETYPE = {
  /** Before this, a seat has scouted too little to have an opinion. The
   * first sighting of a rival lands around minute four in every playbook —
   * it is their lone scout, not their army. */
  readableFrom: 5,
  /** A raid this early is a rush by any definition. Late in a match every
   * seat eventually marches, so the fact only means something while the
   * opening is still running. */
  rushBefore: 9,
  /** Soldiers that make a force rather than a patrol. Same bar the brain
   * uses to call a sighting an army at all (AI_INTEL.minSighting). */
  force: 3,
  /** At or below this, they have shown nothing that could hold a wall. */
  quiet: 1,
  /** Buildings on explored ground that make a village worth the name. */
  village: 10,
} as const;

/**
 * One rival, classified. `minutes` is the match clock, because every fact
 * here is a fact about timing and the same observation means opposite
 * things at minute five and at minute twenty.
 */
export function classifyRival(rival: RivalSummary, minutes: number): Archetype {
  if (!rival.alive) return ArchetypeNs.unmet;
  if (minutes < ARCHETYPE.readableFrom) return ArchetypeNs.unmet;

  // A force at our gates settles it, whatever else they have been doing.
  const raid = rival.contact.firstAttackMin;
  if (raid >= 0 && raid <= ARCHETYPE.rushBefore) return ArchetypeNs.rusher;

  // Their strength as best the scout knows it. `peak` rather than `total`:
  // it is the more accurate of the two by a fifth (summary.ts, RivalIntel).
  const army = rival.intel ? rival.intel.peak : 0;

  // Without their castle located there is no village to weigh the army
  // against, and a seat that has simply not looked must not read its own
  // idleness as an opponent playing quietly.
  if (!rival.found) return ArchetypeNs.unmet;

  if (army >= ARCHETYPE.force && rival.buildings < ARCHETYPE.village) return ArchetypeNs.rusher;
  if (army <= ARCHETYPE.quiet && rival.buildings >= ARCHETYPE.village) return ArchetypeNs.booming;
  if (army >= ARCHETYPE.force) return ArchetypeNs.turtling;
  return ArchetypeNs.unmet;
}

/**
 * The whole board as one label: the loudest living rival wins, because a
 * posture is a single stance and the seat cannot fortify against one
 * neighbour while pouncing on another. Loudest is rusher first (they set
 * the clock), then turtling, then booming; ties break on the lower seat id
 * so two hosts read the same valley identically.
 */
const LOUDNESS: Record<Archetype, number> = { [ArchetypeNs.rusher]: 3, [ArchetypeNs.turtling]: 2, [ArchetypeNs.booming]: 1, [ArchetypeNs.unmet]: 0 };

export function readOpponent(summary: AiWorldSummary): Archetype {
  let best: Archetype = ArchetypeNs.unmet;
  for (const rival of summary.rivals) {
    if (!rival.alive) continue;
    const kind = classifyRival(rival, summary.minutes);
    if (LOUDNESS[kind] > LOUDNESS[best]) best = kind;
  }
  return best;
}
