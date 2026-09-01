import {For} from 'solid-js';
import {
  DIFFICULTIES,
  DIFFICULTY_KEYS,
  DIFFICULTY_ORDER,
  type DifficultyId,
} from '../sim/defs/difficulty.ts';
import * as DifficultyIdNs from '../sim/defs/difficultyEnum.ts';

/**
 * Match difficulty — the one dial the setup screens offer over how hard
 * the valley pushes back.
 *
 * The row it occupies is the row that used to let a match name its
 * opponents seat by seat. Naming them was a designer's switch wearing a
 * player's clothes: it asked for a choice between four playbooks nobody
 * had met, and the answer that made the match interesting was always
 * "surprise me". What a player actually wants to say before a match is how
 * hard it should be, so that is the question the row asks — on the
 * skirmish pane and in the War Council, where the pickers were, and in the
 * campaign, which never had a row at all.
 *
 * It shipped disabled and pinned to Normal, so the shape of the setup
 * screen could settle before the balance work behind it landed. That work
 * has landed (sim/defs/difficulty.ts), and the state arrives here as the
 * file said it would.
 *
 * The tiers come off the sim's own table rather than a copy kept here: the
 * ids ride saves, the lobby wire and ?difficulty=, and a menu with its own
 * private spelling of them is a menu that can name a tier the sim will not
 * honour.
 */

/** What every match runs at until a player says otherwise. */
export const DEFAULT_DIFFICULTY: DifficultyId = DifficultyIdNs.normal;

/**
 * What to say under the row, which is not one answer: the setting does two
 * different jobs and a hint naming only one of them would be a lie half
 * the time.
 *
 * On a commission it scales what the crown grants you — the larder, the
 * hands in the yard, and how long the peace holds. In a skirmish it is
 * purely how well the computer plays; nobody's opening moves, which is the
 * part worth saying out loud, since "hard" in most games means the
 * opponent was handed something. A sandbox with no opponents in it is told
 * plainly that the setting has nothing to touch, rather than left to imply
 * otherwise. And a joiner in a war council is told whose choice it is.
 */
export function difficultyHint(
  kind: 'campaign' | 'skirmish' | 'sandbox' | 'guest',
): string {
  switch (kind) {
    case 'campaign':
      return 'Scales the opening the crown grants you, and the peace before the first raid';
    case 'sandbox':
      return 'Nothing to set: a sandbox has no opponents';
    case 'guest':
      return 'Set by the host';
    case 'skirmish':
      return 'How well the computer plays — never what it is given';
  }
}

/**
 * The row itself, so the three screens that ask the question cannot drift
 * apart: the skirmish pane, the campaign ledger, and the War Council.
 */
export function DifficultyRow(props: {
  value: DifficultyId;
  onChange: (id: DifficultyId) => void;
  hint: string;
  /** A joiner watches the host's choice rather than making one. */
  disabled?: boolean;
}) {
  return (
    <div class="row">
      <div>
        <div class="row-label">Difficulty</div>
        <div class="row-hint">{props.hint}</div>
      </div>
      {/* `selected` on the option, not `value` on the select: Solid sets
          the property, and a select whose options are created after it
          (by the For below) drops the assignment and shows the first row. */}
      <select
        disabled={props.disabled}
        onChange={e => {
          const id = DIFFICULTY_ORDER.find(
            d => DIFFICULTY_KEYS[d] === e.currentTarget.value,
          );
          if (id !== undefined) props.onChange(id);
        }}
      >
        <For each={DIFFICULTY_ORDER}>
          {id => (
            <option value={DIFFICULTY_KEYS[id]} selected={id === props.value}>
              {DIFFICULTIES[id].name}
            </option>
          )}
        </For>
      </select>
    </div>
  );
}
