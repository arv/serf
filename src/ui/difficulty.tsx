import {For} from 'solid-js';

/**
 * Match difficulty — the one dial the setup screens offer over how hard
 * the valley pushes back.
 *
 * Nothing reads it yet. It ships disabled, pinned to Normal, because the
 * row it occupies is the row that used to let a match name its opponents
 * seat by seat. Naming them was a designer's switch wearing a player's
 * clothes: it asked for a choice between four playbooks nobody had met,
 * and the answer that made the match interesting was always "surprise me".
 * What a player actually wants to say before a match is how hard it should
 * be, so that is the question the row asks now — on the skirmish pane and
 * in the War Council, where the pickers were, and in the campaign, which
 * never had a row at all.
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

/** The line under the row, on every setup screen. */
export const DIFFICULTY_HINT = 'Not yet adjustable — every match runs Normal';

/**
 * The row itself, so the three screens that ask the question cannot drift
 * apart on a control none of them can change yet: the skirmish pane, the
 * campaign ledger, and the War Council.
 *
 * No signal behind it: the select is disabled and pinned to the default,
 * so there is nothing for a player to change, nothing for a launch URL to
 * carry and nothing for the lobby to patch. When the dial is wired, the
 * state arrives here.
 */
export function DifficultyRow() {
  return (
    <div class="row">
      <div>
        <div class="row-label">Difficulty</div>
        <div class="row-hint">{DIFFICULTY_HINT}</div>
      </div>
      {/* `selected` on the option, not `value` on the select: Solid sets
          the property, and a select whose options are created after it
          (by the For below) drops the assignment and shows the first row.
          Nothing here ever changes the value, so the attribute is the
          whole state. */}
      <select disabled>
        <For each={DIFFICULTY_ORDER}>
          {id => (
            <option value={id} selected={id === DEFAULT_DIFFICULTY}>
              {DIFFICULTY_NAMES[id]}
            </option>
          )}
        </For>
      </select>
    </div>
  );
}
