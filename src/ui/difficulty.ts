/**
 * Match difficulty — the one dial the setup screens offer over how hard
 * the valley pushes back.
 *
 * Nothing reads it yet. It ships disabled, pinned to Normal, because the
 * row it occupies is the row that used to let a skirmish name its
 * opponents seat by seat. Naming them was a designer's switch wearing a
 * player's clothes: it asked for a choice between four playbooks nobody
 * had met, and the answer that made the match interesting was always
 * "surprise me". What a player actually wants to say before a match is
 * how hard it should be, so that is the question the row asks now — and
 * the campaign, which never had a row at all, asks it too.
 *
 * Disabled rather than absent so the shape of the setup screen is settled
 * before the balance work behind it lands: a control that appears later
 * moves everything under it, and a difficulty that quietly did nothing
 * would be worse than one that plainly says it cannot be changed yet.
 */

export const DIFFICULTY_ORDER = ['easy', 'normal', 'hard'] as const;

export type Difficulty = (typeof DIFFICULTY_ORDER)[number];

export const DIFFICULTY_NAMES: Record<Difficulty, string> = {
  easy: 'Easy',
  normal: 'Normal',
  hard: 'Hard',
};

/** What every match runs at until the dial is wired up. */
export const DEFAULT_DIFFICULTY: Difficulty = 'normal';

/** The line under the row, in both setup panes. */
export const DIFFICULTY_HINT = 'Not yet adjustable — every match runs Normal';
