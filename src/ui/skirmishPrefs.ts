/**
 * The skirmish setup a player last chose — how many computer opponents, at
 * which tier, and whether the bandits ride. One `serf-*` localStorage
 * record with the pure parsing around it, in the mould of audio/settings.ts
 * and ui/campaign.ts: corrupt or unavailable storage reads as the defaults,
 * a failed write just doesn't outlive the session.
 *
 * These are preferences about how a player likes to play, not facts about a
 * valley — the seed is deliberately not among them. A seed is rolled fresh
 * per visit (StartMenu's rollSeed) precisely so that "again" means new
 * ground; remembering it would hand a returning player the same map they
 * just left, which is the one thing the roll exists to prevent.
 *
 * The tier is stored by its key rather than its numeric id, for the reason
 * defs/difficultyEnum.ts gives: DIFFICULTY_KEYS is the spelling anything
 * that outlives the process uses, so a record written today still reads if
 * the enum is ever renumbered.
 */

import {clamp} from '../shared/math';
import {
  DIFFICULTY_KEYS,
  type DifficultyId,
  parseDifficultyId,
} from '../sim/defs/difficulty.ts';
import * as DifficultyIdNs from '../sim/defs/difficultyEnum.ts';

const KEY = 'serf-skirmish';

export interface SkirmishPrefs {
  v: 1;
  /** Computer seats to field. Zero is the sandbox — a valley to yourself. */
  ai: number;
  difficulty: DifficultyId;
  bandits: boolean;
}

/** What a player who has never touched the rows is offered: a pair of
 * opponents, the printed tier, and the roads worth guarding. */
export const DEFAULT_SKIRMISH_PREFS: SkirmishPrefs = {
  v: 1,
  ai: 2,
  difficulty: DifficultyIdNs.normal,
  bandits: true,
};

/**
 * Raw storage string -> prefs; anything questionable reads as the default
 * for that field alone, since a record half-written by an older build is
 * still worth most of what it says.
 *
 * `maxOpponents` is the caller's ceiling (the menu's OPTIONS), so a record
 * written when the screen offered more seats than it does today cannot
 * select a pill that is not on the screen — the setup would show one seat
 * count and launch another.
 */
export function parseSkirmishPrefs(
  raw: string | null,
  maxOpponents: number,
): SkirmishPrefs {
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Partial<SkirmishPrefs>;
      if (parsed.v === 1) {
        return {
          v: 1,
          ai:
            typeof parsed.ai === 'number' && Number.isFinite(parsed.ai)
              ? clamp(Math.round(parsed.ai), 0, Math.max(0, maxOpponents))
              : DEFAULT_SKIRMISH_PREFS.ai,
          difficulty:
            parseDifficultyId(parsed.difficulty) ??
            DEFAULT_SKIRMISH_PREFS.difficulty,
          // Absent reads as on, which is the default and also how the
          // launch URL spells it: only ?bandits=0 turns them off.
          bandits: parsed.bandits !== false,
        };
      }
    } catch {
      // Fall through to defaults.
    }
  }
  return {...DEFAULT_SKIRMISH_PREFS};
}

/** Prefs -> the storage string, tier spelled as its key. */
export function serializeSkirmishPrefs(prefs: SkirmishPrefs): string {
  return JSON.stringify({
    v: 1,
    ai: prefs.ai,
    difficulty: DIFFICULTY_KEYS[prefs.difficulty],
    bandits: prefs.bandits,
  });
}

export function loadSkirmishPrefs(maxOpponents: number): SkirmishPrefs {
  try {
    return parseSkirmishPrefs(localStorage.getItem(KEY), maxOpponents);
  } catch {
    return {...DEFAULT_SKIRMISH_PREFS};
  }
}

export function saveSkirmishPrefs(prefs: SkirmishPrefs): void {
  try {
    localStorage.setItem(KEY, serializeSkirmishPrefs(prefs));
  } catch {
    // Storage full or denied: the choice just doesn't outlive the session.
  }
}
